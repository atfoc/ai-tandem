// Package boardapi is the board API for agents: the fixed MCP endpoint /mcp on the dedicated
// listener (identity in the Authorization header). Authorized board tools go through Relay.Call,
// the one path from an agent to the client, which owns the board engine. Spawn-family tools go
// to chats.Manager and never through the board-tool bridge.
package boardapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
)

// callTimeout is how long a board tool call waits for the client's answer. A variable so that a
// test can lower it; the production value stays.
var callTimeout = 30 * time.Second

// maxBodyBytes is the largest /mcp request body that is read. The largest real requests are an
// apply with a board's worth of elements and a spawn_subagent prompt, both far below it.
const maxBodyBytes = 4 << 20

// maxNameBytes is how much of a name the caller supplies (client name, client version, tool
// name) is logged and kept in the contact table.
const maxNameBytes = 128

// NoClientText is what an agent is told when no client is active.
const NoClientText = "The board isn't open: the AI Whiteboard window is closed. " +
	"Board work needs the window open. Tell the user, and don't retry until they ask again."

// What an agent is told when a board call cannot be carried out the usual way (architecture 2.10).
const (
	// NoEditorText is the answer when the server's background editor cannot run and a window is
	// connected, so there is one place to press.
	NoEditorText = "Nobody is editing this board in a window, and this server cannot edit a board without one. " +
		"Tell the user that they can press Edit here on the board; don't retry until they ask again."
	// AwayLostText is the answer to a call cut by the end of the background editor.
	AwayLostText = "The board's background editor stopped while it ran this call, so the call did not finish. " +
		"The board is as it was after your last finished change. Read the board again before you change it."
	// TakenText is the answer to a call cut by a hand-off, an archive or a delete of its board.
	TakenText = "The board was taken over in a window while this call ran, so the call did not finish. " +
		"Your earlier changes are saved. Read the board again before you change it."
)

// AwayEditor is the headless writer as the relay sees it: the server's background editor of boards
// that no window holds.
type AwayEditor interface {
	// Ensure makes sure the editor runs and has its stream open, and returns its client id. An error
	// says that it cannot run; the calls then fail with the text for the agent.
	Ensure(ctx context.Context) (clientID string, err error)
	// CallTimedOut tells the editor that a call routed to it got no answer in time.
	CallTimedOut()
}

// Relay is the one path from an agent to the client, shared by every agent's board MCP server.
type Relay struct {
	Bridge *editorbridge.Bridge
	Chats  *chats.Manager
	Boards *boards.Service
	// Contacts is the last MCP contact per chat, read by the control socket's /status. Its zero value is
	// ready to use.
	Contacts ContactLog
	// ImageDir is where a picture is written for a Cursor agent (see imagefile.go). Empty means
	// aiwb-images-<uid> in the OS temp dir. ImageMaxAge is how long such a file is kept; zero
	// means an hour. Both are agent.ImageFiles' own.
	ImageDir    string
	ImageMaxAge time.Duration
	// Away is the background editor that works on the boards no window holds. Nil: there is none, and
	// a board call that no window holds fails with NoClientText.
	Away AwayEditor
}

// Call runs a board tool for the chat with this token and returns the text for the agent; a
// picture the tool returns is left out (see CallResult).
// Errors come back as text too (isErr = true), so the agent can tell the user.
// Spawn-family tools must not go through Call (that path is the 30s board-tool bridge).
func (r *Relay) Call(token, tool string, args json.RawMessage) (text string, isErr bool) {
	res := r.CallResult(token, tool, args)
	return res.Text, res.IsErr
}

// CallResult is Call with the whole result: the text and, for a tool that draws, the picture.
func (r *Relay) CallResult(token, tool string, args json.RawMessage) ToolResult {
	caller, ok := r.Chats.ResolveToken(token)
	if !ok {
		return errResult("unknown board token")
	}
	meta := caller.Meta
	if meta.Archived {
		return errResult("this chat is archived")
	}
	if meta.InstructionsSent {
		return errResult("this chat used the old board connection")
	}
	if !boardtools.IsTool(tool) {
		return errResult("unknown tool " + tool)
	}
	// The board the call is about: the one it names, else the chat's own.
	var named struct {
		Board json.RawMessage `json:"board"`
	}
	json.Unmarshal(args, &named)
	var target string
	if len(named.Board) > 0 && string(named.Board) != "null" && json.Unmarshal(named.Board, &target) != nil {
		// Not a string: no board has such an id, and the call must not fall to the chat's own.
		return errResult("NO_BOARD: no board with id " + string(named.Board) + "; call list_boards to find ids")
	}
	switch tool {
	case "list_boards":
		return textResult(r.listBoards(meta.Board), false)
	case "create_board":
		return textResult(r.createBoard(meta.Board, args))
	case "get_view": // about the screen, not about a board
		target = ""
	default:
		if target == "" {
			target = meta.Board
		}
		bd, ok := r.Boards.Get(target)
		switch {
		case !ok && target == meta.Board:
			return errResult("NO_BOARD: this chat's board " + target + " no longer exists")
		case !ok:
			return errResult("NO_BOARD: no board with id " + target + "; call list_boards to find ids")
		case bd.Archived:
			return errResult("ARCHIVED: " + bd.Name + " is archived")
		}
	}
	// The client knows the chat by its top-level id, also when a branch's agent calls; branch
	// says which branch's agent (or subagent) it is, "main" for the chat's main line. board is
	// the chat's board and target the board the call is about.
	params := map[string]any{
		"chat": caller.Chat, "branch": caller.Branch, "board": meta.Board, "name": tool, "args": args,
	}
	if target != "" {
		params["target"] = target
	}
	spec := editorbridge.CallSpec{Method: "tool", Params: params, Board: target, ChatBoard: meta.Board}
	screen := tool == "get_view" || tool == "show_board" // asked of the screen that shows the chat's board
	if screen {
		spec.Board, spec.Screen = "", true
	} else if r.Away != nil {
		// A board that no window holds is worked on by the background editor, which is started only
		// now; the bridge hands it the board, unless a window took it meanwhile.
		spec.Away = true
		if _, held := r.Bridge.HolderOf(target); !held {
			ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
			_, err := r.Away.Ensure(ctx)
			cancel()
			if err != nil {
				return errResult(r.noBoardText())
			}
		}
	}
	out, err := r.Bridge.CallBoard(spec, callTimeout)
	switch {
	case err == nil:
		return pageResult(tool, out)
	case errors.Is(err, editorbridge.ErrNoClient):
		switch {
		case screen && r.Away != nil: // no window shows the board: not a failure of the board
			return textResult(r.screenText(tool, meta.Board, target), false)
		case spec.Away:
			return errResult(r.noBoardText())
		}
		return errResult(NoClientText)
	case errors.Is(err, editorbridge.ErrTaken):
		return errResult(TakenText)
	case errors.Is(err, editorbridge.ErrAwayLost):
		return errResult(AwayLostText)
	}
	if !screen && r.Away != nil && timedOut(err) && r.Bridge.WriterOf(target) == "headless" {
		r.Away.CallTimedOut()
	}
	return errResult(err.Error())
}

// noBoardText is what an agent is told when no client can work on a board that no window holds:
// the usual text, or, when the server has a background editor that cannot run and a window is
// connected, the one that names the button.
func (r *Relay) noBoardText() string {
	if r.Away != nil && r.Bridge.WindowsConnected() {
		return NoEditorText
	}
	return NoClientText
}

// timedOut reports whether err is CallBoard's "did not answer in time".
func timedOut(err error) bool {
	return errors.Is(err, editorbridge.ErrTimeout)
}

// screenText is the plain answer to get_view or show_board when no window shows the chat's board.
// It is no error: the board can be worked on without a screen.
func (r *Relay) screenText(tool, chatBoard, target string) string {
	if tool == "get_view" {
		return "No window shows " + r.boardRef(chatBoard) + " now, so there is no view and no selection to read. " +
			"The board itself can be read and changed as usual: use read_board, and get_image for a picture."
	}
	return "No window shows this chat's board now, so " + r.boardRef(target) + " could not be put on a screen. " +
		"Your changes are saved in the board; the user sees them when they open it."
}

// boardRef writes a board as the agent's context does, "name (id)".
func (r *Relay) boardRef(id string) string {
	if bd, ok := r.Boards.Get(id); ok {
		return bd.Name + " (" + bd.ID + ")"
	}
	return id
}

// groupText is a board's group path as an agent reads it, "Work / Infra", or "Ungrouped".
func groupText(path []string) string {
	if len(path) == 0 {
		return "Ungrouped"
	}
	return strings.Join(path, " / ")
}

// listBoards answers list_boards: the boards that are not archived, by name then id, one line
// each, with a mark on the chat's own board. No client is asked.
func (r *Relay) listBoards(chatBoard string) string {
	groups := r.Boards.Groups()
	var list []model.Board
	for _, bd := range r.Boards.List() {
		if !bd.Archived {
			list = append(list, bd)
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Name != list[j].Name {
			return list[i].Name < list[j].Name
		}
		return list[i].ID < list[j].ID
	})
	lines := make([]string, 0, len(list))
	for _, bd := range list {
		line := fmt.Sprintf("%s  (%s)  [%s]", bd.Name, bd.ID, groupText(groups[bd.ID]))
		if bd.ID == chatBoard {
			line += "  (this chat's board)"
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return "(no boards)"
	}
	return strings.Join(lines, "\n")
}

// createBoard answers create_board: a new board, marked new, in the group of the chat's board.
// No client is asked, and no client holds the new board.
func (r *Relay) createBoard(chatBoard string, args json.RawMessage) (text string, isErr bool) {
	own, ok := r.Boards.Get(chatBoard)
	if !ok {
		return "NO_BOARD: this chat's board " + chatBoard + " no longer exists", true
	}
	var p struct {
		Name any `json:"name"`
	}
	json.Unmarshal(args, &p)
	name, _ := p.Name.(string)
	bd, err := r.Boards.Create(name, own.Group, true)
	if err != nil {
		return err.Error(), true
	}
	return fmt.Sprintf("created %s (%s) in %s", bd.Name, bd.ID, groupText(r.Boards.Groups()[bd.ID])), false
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// clipName cuts a name the caller supplies to maxNameBytes, on a rune boundary.
func clipName(s string) string {
	if len(s) <= maxNameBytes {
		return s
	}
	n := maxNameBytes
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// Contact is the last MCP contact observed for one chat (or for an unresolved credential). It
// carries no credential and no board content, so it is safe on the read-only status surface.
type Contact struct {
	Chat          string    `json:"chat"`                    // short chat id, or "unknown"
	Client        string    `json:"client,omitempty"`        // initialize clientInfo.name
	ClientVersion string    `json:"clientVersion,omitempty"` // initialize clientInfo.version
	Method        string    `json:"method"`                  // "initialize" or "tools/call"
	Tool          string    `json:"tool,omitempty"`          // tools/call name
	Outcome       string    `json:"outcome,omitempty"`       // tools/call: "ok" or "error"
	At            time.Time `json:"at"`
}

// ContactLog is the MCP observation point's in-memory last-contact tracker. The MCP listener is
// concurrent with the status reads of the control socket, so every access is guarded. It keeps one
// entry per chat, so it stays bounded and cheap.
type ContactLog struct {
	mu sync.Mutex
	m  map[string]Contact
}

// unknownContact is the entry key for a credential that resolved to no chat. It is deliberately
// constant, never derived from the credential.
const unknownContact = "unknown"

// recordInit records an initialize for the chat keyed by key (the full chat id, or unknown).
func (l *ContactLog) recordInit(key, chat, client, version string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.m == nil {
		l.m = map[string]Contact{}
	}
	c := l.m[key]
	c.Chat, c.Client, c.ClientVersion = chat, client, version
	c.Method, c.Tool, c.Outcome = "initialize", "", ""
	c.At = time.Now()
	l.m[key] = c
}

// recordCall records a tools/call for the chat keyed by key (the full chat id, or unknown).
func (l *ContactLog) recordCall(key, chat, tool, outcome string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.m == nil {
		l.m = map[string]Contact{}
	}
	c := l.m[key]
	c.Chat, c.Method, c.Tool, c.Outcome = chat, "tools/call", tool, outcome
	c.At = time.Now()
	l.m[key] = c
}

// Snapshot returns the last contact per chat, most recent first.
func (l *ContactLog) Snapshot() []Contact {
	l.mu.Lock()
	out := make([]Contact, 0, len(l.m))
	for _, c := range l.m {
		out = append(out, c)
	}
	l.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	return out
}

// ---- MCP ------------------------------------------------------------------

// The board API served as an MCP server (Streamable HTTP, JSON responses only): the fixed
// POST /mcp on the dedicated listener. serverInfo.name is "board", so Claude names the tools
// mcp__board__<tool>.

type rpcReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// mcpToolsOf is tools in MCP's tools/list shape. An empty input yields an empty list, not null.
func mcpToolsOf(tools []boardtools.Tool) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		schema := t.Schema
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, map[string]any{"name": t.Name, "description": t.Description, "inputSchema": schema})
	}
	return out
}

// listedTools is the per-chat, per-caller tools/list. Missing, unknown, or revoked tokens
// get an empty list (handshake still succeeds), and so do the callers dispatch refuses every
// call: an archived chat and a legacy chat. Other live tokens follow the §2 matrix: the board
// tools for a caller whose chat has a board, and the spawn family for a caller the chat's
// subagent depth gives it (chats.Caller.MaySpawn): the chat's agent unless subagents are off, and
// a subagent above the chat's deepest level.
func (r *Relay) listedTools(token string) []map[string]any {
	caller, ok := r.Chats.ResolveToken(token)
	if !ok || caller.Meta.Archived || caller.Meta.InstructionsSent {
		return mcpToolsOf(nil)
	}
	var tools []boardtools.Tool
	if caller.Meta.Board != "" {
		tools = append(tools, boardtools.Tools...)
	}
	if caller.MaySpawn() {
		tools = append(tools, r.spawnListed(caller)...)
	}
	return mcpToolsOf(tools)
}

// spawnListed is the spawn family as tools/list shows it to caller: its agent parameter names
// only the agents this server can start, and a subagent reads of itself where the chat's agent
// reads of its chat.
func (r *Relay) spawnListed(caller chats.Caller) []boardtools.Tool {
	usable := r.Chats.UsableAgents()
	names := make([]string, len(usable))
	for i, a := range usable {
		names[i] = string(a)
	}
	if caller.Subagent {
		return boardtools.SpawnFamilyForSub(names)
	}
	return boardtools.SpawnFamilyFor(names)
}

// ServeFixedMCP serves the fixed POST /mcp on the dedicated listener. The credential is the
// chat's durable board token in the Authorization header (bearer form).
func (r *Relay) ServeFixedMCP(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	r.serveRPC(w, req, bearerToken(req.Header.Get("Authorization")))
}

// bearerToken returns the token of an "Authorization: Bearer <token>" header, or "".
func bearerToken(header string) string {
	const prefix = "Bearer "
	if len(header) < len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}

// serveRPC decodes and answers one JSON-RPC request for the board token token. A body over
// maxBodyBytes is refused before anything of it is logged or recorded.
func (r *Relay) serveRPC(w http.ResponseWriter, req *http.Request, token string) {
	body, err := io.ReadAll(http.MaxBytesReader(w, req.Body, maxBodyBytes))
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
		return
	}
	var rq rpcReq
	if err := json.Unmarshal(body, &rq); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if rq.ID == nil { // a notification
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var result any
	var rpcErr map[string]any
	switch rq.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
			ClientInfo      struct {
				Name    string `json:"name"`
				Version string `json:"version"`
			} `json:"clientInfo"`
		}
		json.Unmarshal(rq.Params, &p)
		r.logInitialize(token, p.ClientInfo.Name, p.ClientInfo.Version)
		result = map[string]any{
			"protocolVersion": p.ProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "board", "version": "0.0.1"},
		}
	case "tools/list":
		result = map[string]any{"tools": r.listedTools(token)}
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		json.Unmarshal(rq.Params, &p)
		tr := r.dispatch(token, p.Name, p.Arguments)
		r.logToolCall(token, p.Name, tr.IsErr)
		res := map[string]any{"content": tr.content()}
		if tr.IsErr {
			res["isError"] = true
		}
		result = res
	case "ping":
		result = map[string]any{}
	default:
		rpcErr = map[string]any{"code": -32601, "message": "method not found"}
	}
	resp := map[string]any{"jsonrpc": "2.0", "id": rq.ID}
	if rpcErr != nil {
		resp["error"] = rpcErr
	} else {
		resp["result"] = result
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// dispatch authorizes and routes one tools/call. Spawn-family never goes through Relay.Call; its
// results are text.
func (r *Relay) dispatch(token, name string, args json.RawMessage) ToolResult {
	caller, ok := r.Chats.ResolveToken(token)
	if !ok {
		return errResult("unknown board token")
	}
	if caller.Meta.Archived {
		return errResult("this chat is archived")
	}
	if caller.Meta.InstructionsSent {
		return errResult("this chat used the old board connection")
	}
	hasBoard := caller.Meta.Board != ""
	if boardtools.IsSpawnFamily(name) {
		if !caller.MaySpawn() {
			return errResult(caller.NoSpawnText(name))
		}
		return textResult(r.callSpawnFamily(caller, name, args))
	}
	if boardtools.IsTool(name) {
		if !hasBoard {
			return errResult(name + " is not available on this chat")
		}
		res := r.CallResult(token, name, args)
		if caller.Kind == model.Cursor { // Cursor is not handed an image part: a file it opens
			res = r.imageToFile(name, res)
		}
		return res
	}
	return errResult("unknown tool " + name)
}

// callSpawnFamily runs a spawn-family tool on the caller's own chat object: caller.Meta.ID, a
// branch's server id for a branch. The caller is the chat's agent or one of its subagents
// (caller.SID): a subagent it spawns is that one's, and it stops only its own.
func (r *Relay) callSpawnFamily(caller chats.Caller, name string, args json.RawMessage) (string, bool) {
	switch name {
	case "spawn_subagent":
		req, err := parseSpawnArgs(args)
		if err != nil {
			return err.Error(), true
		}
		req.From = caller.SID
		sa, err := r.Chats.SpawnSubagent(caller.Meta.ID, req)
		if err != nil {
			return spawnErrorText(err), true
		}
		return fmt.Sprintf("spawned subagent %s (%s)", sa.ID, sa.Status), false
	case "stop_subagent":
		sid, err := parseStopArgs(args)
		if err != nil {
			return err.Error(), true
		}
		if err := r.Chats.StopSubagentBy(caller.Meta.ID, caller.SID, sid); err != nil {
			return err.Error(), true
		}
		return "stopped subagent " + sid, false
	case "list_subagent_models":
		return r.listSubagentModels(caller, args)
	default:
		return "unknown tool " + name, true
	}
}

// spawnErrorText is a spawn error as the agent reads it. A model or effort the manager rejected
// against a known list also says how to find the valid values.
func spawnErrorText(err error) string {
	var ve *chats.SpawnValueError
	if errors.As(err, &ve) {
		return fmt.Sprintf("%s. Call list_subagent_models with agent %q to see the models and efforts spawn_subagent accepts.", err.Error(), ve.Kind)
	}
	return err.Error()
}

func parseSpawnArgs(args json.RawMessage) (chats.SpawnSubRequest, error) {
	var p struct {
		Prompt      string `json:"prompt"`
		Description string `json:"description"`
		Agent       string `json:"agent"`
		Model       string `json:"model"`
		Effort      string `json:"effort"`
	}
	if len(args) > 0 && string(args) != "null" {
		if err := json.Unmarshal(args, &p); err != nil {
			return chats.SpawnSubRequest{}, errors.New("invalid spawn_subagent arguments")
		}
	}
	if strings.TrimSpace(p.Prompt) == "" {
		return chats.SpawnSubRequest{}, errors.New("prompt is required")
	}
	var kind model.AgentKind
	if p.Agent != "" {
		switch model.AgentKind(p.Agent) {
		case model.Claude, model.Cursor, model.Pi:
			kind = model.AgentKind(p.Agent)
		default:
			return chats.SpawnSubRequest{}, fmt.Errorf("unknown agent %q", p.Agent)
		}
	}
	return chats.SpawnSubRequest{
		Prompt: p.Prompt, Description: p.Description, Kind: kind, Model: p.Model, Effort: p.Effort,
	}, nil
}

func parseStopArgs(args json.RawMessage) (string, error) {
	var p struct {
		SID string `json:"sid"`
	}
	if len(args) > 0 && string(args) != "null" {
		if err := json.Unmarshal(args, &p); err != nil {
			return "", errors.New("invalid stop_subagent arguments")
		}
	}
	if strings.TrimSpace(p.SID) == "" {
		return "", errors.New("sid is required")
	}
	return p.SID, nil
}

// chatKey resolves a credential to its short chat id and tracker key: the top-level chat's, also
// for a branch's credential. An unknown or empty credential maps to the constant unknown marker;
// the credential itself is never returned.
func (r *Relay) chatKey(token string) (label, key string) {
	if caller, ok := r.Chats.ResolveToken(token); ok {
		return short(caller.Chat), caller.Chat
	}
	return unknownContact, unknownContact
}

// logInitialize writes one structured MCP access line and records the contact. It never logs the
// credential; the agent-supplied client name/version are cut short and quoted.
func (r *Relay) logInitialize(token, name, version string) {
	name, version = clipName(name), clipName(version)
	label, key := r.chatKey(token)
	log.Printf("mcp initialize chat=%s client=%q version=%q", label, name, version)
	r.Contacts.recordInit(key, label, name, version)
}

// logToolCall writes one structured MCP access line and records the contact. It is the only
// line a tools/call produces (the arguments are deliberately left out) and never logs the
// credential; the agent-supplied tool name is cut short and quoted.
func (r *Relay) logToolCall(token, tool string, isErr bool) {
	tool = clipName(tool)
	outcome := "ok"
	if isErr {
		outcome = "error"
	}
	label, key := r.chatKey(token)
	log.Printf("mcp tools/call chat=%s tool=%q outcome=%s", label, tool, outcome)
	r.Contacts.recordCall(key, label, tool, outcome)
}
