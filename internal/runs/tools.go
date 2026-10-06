// This file is the thirteen run tools (boardtools.RunTools) as the MCP endpoint calls them:
// Service.Tools and Service.Call with the per-caller checks, and one function per tool. The texts
// the tools answer with are in tooltext.go.
//
// Who may call what, and how a call is recorded:
//   - The orchestrator gets every tool but tell_orchestrator, and wait_for only when the run's
//     wake mode is declared. Each of its calls, read or change,
//     accepted or refused, is one journal entry that appends an op to its turn. The entry is
//     made only when that turn is the running one and its agent is the caller's chat, checked
//     inside the entry's build, under the run's lock: a call that arrives after the turn ended
//     changes nothing and is not recorded.
//   - A person's chat on the run gets every tool but set_notes, edit_notes, wait_for and
//     finish_run. Its reads are not
//     recorded. Its changes are entries with a chatOps record; an accepted one also makes a
//     chat_op event for the orchestrator and holds the task it touched until the chat's reply
//     ends.
//   - A task agent, a merge agent and every subagent get nothing.
//
// Every check a change depends on is made inside build. Nothing of the chat manager, git or a
// file is read there: what a tool needs of those it reads first, with no lock held.
package runs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"regexp"
	"slices"
	"strings"
	"time"

	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/model"
)

// toolGitWait is how long a tool waits for the git reads of its text.
const toolGitWait = 30 * time.Second

// The Service answers the run tools of the MCP endpoint.
var _ boardapi.RunService = (*Service)(nil)

var (
	errToolTurnOver = errors.New("the orchestrator's turn is over")
	errToolAgain    = errors.New("the state changed under the call: make it again")
	errToolActive   = errors.New("the task is active: its worker must end it")
)

// Tools is the run tool list of tools/list for the caller: the orchestrator's twelve (eleven
// when the run's wake mode is not declared: no wait_for), a person's chat's nine, and nothing for
// anyone else.
func (s *Service) Tools(c boardapi.RunCaller) []boardtools.Tool {
	if c.Subagent || c.Run == "" {
		return nil
	}
	switch c.Role {
	case model.RoleOrchestrator:
		declared := true
		if r, err := s.run(c.Run); err == nil {
			r.mu.Lock()
			declared = toolDeclared(r.meta)
			r.mu.Unlock()
		}
		return boardtools.RunToolsFor(true, declared)
	case "":
		return boardtools.RunChatTools()
	}
	return nil
}

// toolDeclared reports whether the run's orchestrator says what it waits for (wait_for): the wake
// mode declared, which an empty one counts as.
func toolDeclared(meta model.RunMeta) bool {
	return meta.Settings.Wake == "" || meta.Settings.Wake == "declared"
}

// Call runs one run tool for the caller and returns the text for the agent; a refusal is the
// text with isErr true. The checks are the contract's (T13 §8.1), in its order.
func (s *Service) Call(c boardapi.RunCaller, name string, args json.RawMessage) (text string, isErr bool) {
	defer func() {
		if p := recover(); p != nil {
			log.Printf("runs: %s of run %s: panic: %v", name, c.Run, p)
			text, isErr = fmt.Sprintf("internal error in %s: %v", name, p), true
		}
	}()
	if !boardtools.IsRunTool(name) {
		return "unknown tool " + name, true
	}
	switch {
	case c.Subagent:
		return name + " is not available to subagents", true
	case c.Role == model.RoleTask || c.Role == model.RoleMerge:
		return name + " is not available to this agent", true
	case c.Run == "" || (c.Role != "" && c.Role != model.RoleOrchestrator):
		return name + " is not available on this chat", true
	}
	r, err := s.run(c.Run)
	if err != nil {
		return name + " is not available on this chat", true
	}
	k := &toolCall{s: s, r: r, c: c, name: name, orch: c.Role == model.RoleOrchestrator, read: boardtools.IsRunRead(name)}
	text, refusal, err := k.do(args)
	switch {
	case err != nil:
		return "internal error in " + name + ": " + err.Error(), true
	case refusal != "":
		return refusal, true
	}
	return text, false
}

// toolCall is one call of a run tool.
type toolCall struct {
	s    *Service
	r    *run
	c    boardapi.RunCaller
	name string
	orch bool // the caller is the run's orchestrator; else a person's chat
	read bool // the tool changes nothing
	args map[string]json.RawMessage
	pre  string // a refusal that depends on nothing recorded: made before any lock, recorded like any other
	late bool   // the entry records what has happened already: whether the run can be changed is not asked again
}

// do answers the call: a text, or a refusal, or an error that is none of the tool's own.
func (k *toolCall) do(args json.RawMessage) (text, refusal string, err error) {
	a, ok := toolArgs(args)
	k.args = a
	switch {
	case !ok:
		k.pre = toolNotObject
	case !k.orch && (k.name == "set_notes" || k.name == "edit_notes"):
		k.pre = toolChatNotes
	case !k.orch && k.name == "wait_for":
		k.pre = toolChatWait
	case !k.orch && k.name == "finish_run":
		k.pre = toolChatFinish
	case k.orch && k.name == "tell_orchestrator":
		k.pre = toolOrchTell
	}

	k.r.mu.Lock()
	meta := k.r.meta
	k.r.mu.Unlock()
	if k.orch && k.name == "wait_for" && !toolDeclared(meta) && k.pre == "" {
		k.pre = "unknown tool wait_for" // not one of this run's tools: refused as an unknown one is, and recorded
	}
	if meta.Started.IsZero() { // a draft has no journal: nothing is recorded
		switch {
		case k.orch:
			return "", k.over(), nil
		case k.pre != "":
			return "", k.pre, nil
		case k.read:
			return toolDraftRead(meta.Name), "", nil
		}
		return "", toolDraftChange, nil
	}
	if err := k.r.load(); err != nil {
		return "", "", err
	}
	// The orchestrator's process must be in a turn: asked of the chat manager before any lock.
	// Whether that turn is the run's running one is checked again inside every entry.
	if k.orch && k.s.Chats != nil && !k.s.Chats.TurnRunning(k.c.Chat) {
		return "", k.over(), nil
	}
	if k.pre != "" {
		if !k.orch && k.read {
			return "", k.pre, nil
		}
		return k.commit(KOp, func(tx *Tx, op *model.RunOp, turn int) (string, string, error) { return "", k.pre, nil })
	}
	switch k.name {
	case "get_run":
		return k.getRun()
	case "get_task":
		return k.getTask()
	case "get_agent":
		return k.getAgent()
	case "get_notes":
		return k.getNotes()
	case "set_notes":
		return k.setNotes()
	case "edit_notes":
		return k.editNotes()
	case "wait_for":
		return k.waitFor()
	case "add_task":
		return k.addTask()
	case "update_task":
		return k.updateTask()
	case "cancel_task":
		return k.cancelTask()
	case "retry_task":
		return k.retryTask()
	case "finish_run":
		return k.finishRun()
	case "tell_orchestrator":
		return k.tell()
	}
	return "", "unknown tool " + k.name, nil
}

// over is the answer to an orchestrator whose turn is not the running one. A refusal that came
// before that check in the contract's order keeps its place.
func (k *toolCall) over() string {
	if k.pre != "" {
		return k.pre
	}
	return toolTurnOver(k.name)
}

// commit makes the call's one journal entry. do runs inside the entry's build, with the run's
// lock held, after the checks every call shares: for the orchestrator that its turn is the
// running one (turn is its number; 0 for a chat), for a change that the run can be changed. do
// returns the answer, or a refusal, or an error that aborts the entry. It must change nothing on
// tx when it refuses: a refused call is recorded with its error and nothing else. The entry gets
// the op: appended to the turn's ops for the orchestrator, to the run's chatOps for a chat.
func (k *toolCall) commit(kind EntryKind, do func(tx *Tx, op *model.RunOp, turn int) (text, refusal string, err error)) (text, refusal string, err error) {
	_, err = k.r.commit(kind, func(tx *Tx) error {
		l := tx.L()
		turn := 0
		if k.orch {
			n := len(l.Turns)
			if n == 0 || l.Turns[n-1].Status != "running" || l.Turns[n-1].Agent != k.c.Chat {
				return errToolTurnOver
			}
			turn = l.Turns[n-1].N
		}
		op := model.RunOp{Op: k.name}
		ref := k.pre
		if ref == "" && !k.read && !k.late {
			ref = k.fixed(l)
		}
		if ref == "" {
			var err error
			if text, ref, err = do(tx, &op, turn); err != nil {
				return err
			}
		}
		if ref != "" {
			op = model.RunOp{Op: k.name, Task: k.taskArg(l), Error: clip(ref, 400)}
		}
		refusal = ref
		head := Entry{Op: k.name, Task: op.Task, Attempt: op.Attempt, Chat: k.c.Chat, Error: op.Error}
		if k.orch {
			t := tx.Turn(turn)
			op.I, op.T = len(t.Ops), tx.Now()
			t.Ops = append(t.Ops, op)
			head.Turn = turn
		} else {
			op.Chat, op.Turn = k.c.Chat, toolLatestTurn(l)
			tx.AddChatOp(op)
		}
		tx.Head(head)
		return nil
	})
	switch {
	case errors.Is(err, errToolTurnOver):
		return "", k.over(), nil
	case err != nil:
		return "", "", err
	}
	return text, refusal, nil
}

// fixed says why the run cannot be changed now, "" when it can. r.mu held (inside build).
func (k *toolCall) fixed(l *Loaded) string {
	st := l.State.Status
	switch {
	case st.Final() || l.State.Result != nil:
		return toolFinished
	case st == model.RunStopping, k.orch && st != model.RunRunning:
		// An orchestrator's call that is still on its way when the run halts must not change a
		// halted run: its turn stays `running` across the halt.
		return toolStopping
	case k.r.meta.Archived:
		return toolArchived
	}
	return ""
}

// taskArg is the task a refused call was about, when its id names one.
func (k *toolCall) taskArg(l *Loaded) string {
	id, _ := toolStr(k.args, "id")
	if l.hasTask(id) {
		return id
	}
	return ""
}

// holder is who holds a task this call adds, changes or queues again.
func (k *toolCall) holder(turn int) Holder {
	if k.orch {
		return Holder{Turn: turn}
	}
	return Holder{Chat: k.c.Chat}
}

// event tells the orchestrator of a chat's accepted change. The orchestrator's own changes make
// no event.
func (k *toolCall) event(tx *Tx, task, text string, max int) {
	if !k.orch {
		tx.Event(model.RunEvent{Type: "chat_op", Task: task, Chat: k.c.Chat, Text: clip(text, max)})
	}
}

// hold puts the caller among the task's holders: it starts when the turn, or the chat's reply,
// has ended.
func (k *toolCall) hold(t *Task, turn int) {
	if h := k.holder(turn); !slices.Contains(t.HeldBy, h) {
		t.HeldBy = append(t.HeldBy, h)
	}
}

// snapshot is the run as a read answers from it: copies taken in one hold of the run's lock.
type toolSnap struct {
	meta model.RunMeta
	l    *Loaded
	live map[string]Live
	turn int // the calling orchestrator's turn; 0 for a chat
}

func (k *toolCall) snapshot() toolSnap {
	k.r.mu.Lock()
	defer k.r.mu.Unlock()
	return k.snapLocked()
}

// snapLocked is snapshot with r.mu held.
func (k *toolCall) snapLocked() toolSnap {
	s := toolSnap{meta: k.r.meta, l: k.r.L.snapshot(), live: k.r.live()}
	if n := len(s.l.Turns); k.orch && n > 0 {
		s.turn = s.l.Turns[n-1].N
	}
	return s
}

// answered ends a read whose answer is made: a chat gets it as it is; the orchestrator's call is
// recorded first, with fill setting the op's own fields.
func (k *toolCall) answered(text, refusal string, fill func(op *model.RunOp)) (string, string, error) {
	if !k.orch {
		return text, refusal, nil
	}
	return k.commit(KOp, func(tx *Tx, op *model.RunOp, turn int) (string, string, error) {
		if refusal == "" && fill != nil {
			fill(op)
		}
		return text, refusal, nil
	})
}

// ---- the reads ---------------------------------------------------------------------------

// getRun answers get_run. For the orchestrator it is one entry that moves the inbox to its
// turn's Learned and records the call, and the text is built from the state that entry made. The
// git reads come first, so a git failure consumes nothing.
func (k *toolCall) getRun() (string, string, error) {
	offset, bad := toolInt(k.args, "offset", 0)
	if bad || offset < 0 {
		return k.answered("", "offset must be a number, 0 or more", nil)
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolGitWait)
	g, err := k.s.engine.gitFacts(k.r, ctx)
	cancel()
	if err != nil {
		return "", "", err
	}
	if !k.orch {
		s := k.snapshot()
		text, refusal := toolPage(toolRunText(s.meta, s.l, g, toolRunOpts{now: k.s.nowMs(), live: s.live}), offset, "get_run", "", 0)
		return text, refusal, nil
	}
	for {
		// The entry's kind says whether it took events, and has to be chosen before the entry is
		// built: look first, and look again inside.
		k.r.mu.Lock()
		takes := offset == 0 && len(k.r.L.State.Inbox) > 0
		k.r.mu.Unlock()
		kind := KOp
		if takes {
			kind = KLearned
		}
		var s toolSnap
		var news []model.RunEvent
		_, refusal, err := k.commit(kind, func(tx *Tx, op *model.RunOp, turn int) (string, string, error) {
			inbox := tx.L().State.Inbox
			if (offset == 0 && len(inbox) > 0) != takes {
				return "", "", errToolAgain
			}
			if takes {
				news = slices.Clone(inbox)
				t := tx.Turn(turn)
				t.Learned = append(t.Learned, news...)
				tx.State().Inbox = nil
			} else if offset > 0 { // a later part of an answer: with what the turn learned before
				news = slices.Clone(tx.L().Turns[len(tx.L().Turns)-1].Learned)
			}
			tx.After(func() { s = k.snapLocked() })
			return "", "", nil
		})
		switch {
		case errors.Is(err, errToolAgain):
			continue
		case err != nil || refusal != "":
			return "", refusal, err
		}
		text := toolRunText(s.meta, s.l, g, toolRunOpts{now: k.s.nowMs(), callerTurn: s.turn, live: s.live}) + toolNewSince(news)
		text, refusal = toolPage(text, offset, "get_run", "", 0)
		return text, refusal, nil
	}
}

// getTask answers get_task: the record copied under the lock, the task's files read outside it.
func (k *toolCall) getTask() (string, string, error) {
	id, _ := toolStr(k.args, "id")
	fill := func(op *model.RunOp) { op.Task = id }
	s := k.snapshot()
	t, ok := toolTask(s.l, id)
	if !ok {
		return k.answered("", toolNoTask(s.l, id), nil)
	}
	part, _ := toolStr(k.args, "part")
	if part != "" && part != "brief" && part != "report" {
		return k.answered("", "part must be brief or report", nil)
	}
	in := toolTaskIn{l: s.l, task: t, attempt: toolLastAttempt(t), live: s.live, now: k.s.nowMs()}
	if _, has := k.args["attempt"]; has {
		n, bad := toolInt(k.args, "attempt", 0)
		if bad || n < 1 || n > len(t.Attempts) {
			return k.answered("", fmt.Sprintf("%s has no attempt %s", id, toolRawArg(k.args, "attempt")), nil)
		}
		in.attempt, in.asked = t.Attempts[n-1], true
	}
	offset, bad := toolInt(k.args, "offset", 0)
	if bad || offset < 0 {
		return k.answered("", "offset must be a number, 0 or more", nil)
	}
	var err error
	if in.brief, err = readBrief(k.r.dir, id, t.BriefRev); err != nil && !errors.Is(err, ErrNoText) {
		return "", "", err
	}
	in.brief = strings.TrimSpace(in.brief)
	if in.attempt.Result != nil {
		if in.report, err = readReport(k.r.dir, id, in.attempt.N); err != nil && !errors.Is(err, ErrNoText) {
			return "", "", err
		}
		in.report = strings.TrimSpace(in.report)
	}
	if in.attempt.Head != "" {
		if c, err := readChanges(k.r.dir, id, in.attempt.N); err == nil {
			in.changes = &c
		}
	}
	var text, refusal string
	switch part {
	case "brief":
		text, refusal = toolTaskBrief(in, offset)
	case "report":
		text, refusal = toolTaskReport(in, offset)
	default:
		text, refusal = toolTaskText(in, offset)
	}
	return k.answered(text, refusal, fill)
}

// getAgent answers get_agent: the agent found by name under the lock, its thread read from the
// chat manager outside it.
func (k *toolCall) getAgent() (string, string, error) {
	name, _ := toolStr(k.args, "agent")
	name = strings.TrimSpace(name)
	last, bad := toolInt(k.args, "last", toolLastSteps)
	if bad {
		return k.answered("", "last must be a number", nil)
	}
	last = max(1, min(toolMaxSteps, last))
	s := k.snapshot()
	i := slices.IndexFunc(s.l.Agents, func(a Agent) bool { return a.Name == name })
	if i < 0 {
		return k.answered("", "there is no agent "+toolQuote(name)+". "+toolAgentNames, nil)
	}
	a := s.l.Agents[i]
	var items []model.Item
	if k.s.Chats != nil {
		if _, _, got, _, err := k.s.Chats.ItemsOf(a.ID, ""); err == nil {
			items = got
		}
	}
	text := toolAgentText(a.View(s.live[a.ID]), items, k.s.nowMs(), last)
	return k.answered(text, "", func(op *model.RunOp) { op.Agent = name })
}

// getNotes answers get_notes: the index under the lock, the version's file outside it.
func (k *toolCall) getNotes() (string, string, error) {
	offset, bad := toolInt(k.args, "offset", 0)
	if bad || offset < 0 {
		return k.answered("", "offset must be a number, 0 or more", nil)
	}
	s := k.snapshot()
	n := len(s.l.Notes)
	if n == 0 {
		return k.answered(toolNoNotes, "", nil)
	}
	nv := s.l.Notes[n-1]
	asked := toolHas(k.args, "version")
	if asked {
		v, bad := toolInt(k.args, "version", 0)
		i := slices.IndexFunc(s.l.Notes, func(x model.NotesVersion) bool { return x.V == v })
		if bad || i < 0 {
			return k.answered("", fmt.Sprintf("there is no version %s of the notes (the latest is %d)", toolRawArg(k.args, "version"), nv.V), nil)
		}
		nv = s.l.Notes[i]
	}
	notes, err := readNotes(k.r.dir, nv.V)
	if err != nil {
		return "", "", err
	}
	text, refusal := toolNotesText(nv, s.l.Notes[n-1].V, strings.TrimRight(notes, "\n"), asked, offset)
	return k.answered(text, refusal, func(op *model.RunOp) { op.NotesVersion = nv.V })
}

// ---- the changes --------------------------------------------------------------------------

// setNotes answers set_notes (the orchestrator's alone): a new version of the notes, whole.
func (k *toolCall) setNotes() (string, string, error) {
	notes, _ := toolStr(k.args, "notes")
	notes = strings.TrimSpace(notes)
	return k.commit(KOp, func(tx *Tx, op *model.RunOp, turn int) (string, string, error) {
		if notes == "" {
			return "", "the notes are empty", nil
		}
		v := 1
		if n := len(tx.L().Notes); n > 0 {
			v = tx.L().Notes[n-1].V + 1
		}
		size := toolChars(notes)
		tx.AddNotes(model.NotesVersion{V: v, At: tx.Now(), Turn: turn, Size: size})
		tx.File(notesRel(v), []byte(notes+"\n"))
		op.NotesVersion, op.Size = v, size
		return toolNotesSaved("Notes saved", size, v), "", nil
	})
}

// editNotes answers edit_notes (the orchestrator's alone): a new version of the notes with one
// section replaced, added or removed. The latest version is read before the entry; the entry
// checks that it is still the latest.
func (k *toolCall) editNotes() (string, string, error) {
	heading, _ := toolStr(k.args, "heading")
	section, _ := toolStr(k.args, "text")
	for {
		k.r.mu.Lock()
		v := 0
		if n := len(k.r.L.Notes); n > 0 {
			v = k.r.L.Notes[n-1].V
		}
		k.r.mu.Unlock()
		old := ""
		if v > 0 {
			text, err := readNotes(k.r.dir, v)
			if err != nil {
				return "", "", err
			}
			old = strings.TrimRight(text, "\n")
		}
		text, refusal, err := k.commit(KOp, func(tx *Tx, op *model.RunOp, turn int) (string, string, error) {
			latest := 0
			if n := len(tx.L().Notes); n > 0 {
				latest = tx.L().Notes[n-1].V
			}
			if latest != v {
				return "", "", errToolAgain
			}
			notes, did, refusal := notesReplaceSection(old, heading, section)
			switch {
			case !toolHas(k.args, "text"):
				return "", "text is missing: give the section's new content, or an empty text to remove it", nil
			case refusal != "":
				return "", refusal, nil
			case notes == "":
				return "", "removing it would leave the notes empty; replace them with set_notes instead", nil
			}
			size := toolChars(notes)
			tx.AddNotes(model.NotesVersion{V: v + 1, At: tx.Now(), Turn: turn, Size: size})
			tx.File(notesRel(v+1), []byte(notes+"\n"))
			op.NotesVersion, op.Size, op.Heading = v+1, size, clip(strings.TrimSpace(heading), 120)
			return toolNotesSaved(fmt.Sprintf("Section '%s' %s", strings.TrimSpace(heading), did), size, v+1), "", nil
		})
		if errors.Is(err, errToolAgain) {
			continue
		}
		return text, refusal, err
	}
}

// waitFor answers wait_for (the orchestrator's alone, in the wake mode declared): the tasks whose
// end starts the next turn. The last call of a turn is the one that holds.
func (k *toolCall) waitFor() (string, string, error) {
	return k.commit(KOp, func(tx *Tx, op *model.RunOp, turn int) (string, string, error) {
		l := tx.L()
		var list []string
		if !toolHas(k.args, "tasks") || json.Unmarshal(k.args["tasks"], &list) != nil || len(list) == 0 {
			return "", "tasks must be a list of task ids, with at least one", nil
		}
		mode := "all"
		if m, ok := toolStr(k.args, "mode"); ok && m != "" {
			mode = m
		}
		if mode != "all" && mode != "any" {
			return "", "mode must be all or any", nil
		}
		var ids, unknown, over []string
		for _, id := range list {
			if slices.Contains(ids, id) {
				continue
			}
			ids = append(ids, id)
			if !l.hasTask(id) {
				unknown = append(unknown, id)
			} else if st := toolStateOf(l, id); st.Final() {
				over = append(over, id+" ("+toolCoarse(st)+")")
			}
		}
		if len(unknown) > 0 {
			return "", toolNoTask(l, unknown...), nil
		}
		if len(over) > 0 {
			return "", strings.Join(over, ", ") + " already ended, so there is nothing to wait for: its result is there to read now (get_task). Name only tasks that are pending or running.", nil
		}
		tx.State().Wait = &model.RunWait{Tasks: ids, Mode: mode, Turn: turn}
		op.Tasks, op.Mode = slices.Clone(ids), mode
		return fmt.Sprintf("After this turn the next instance starts when %s of %s ended, or earlier if a task fails, nothing is left running, or a chat on the run changes it.",
			toolWaitMode(mode), strings.Join(ids, ", ")), "", nil
	})
}

// addTask answers add_task.
func (k *toolCall) addTask() (string, string, error) {
	return k.commit(KOp, func(tx *Tx, op *model.RunOp, turn int) (string, string, error) {
		l := tx.L()
		var missing []string
		for _, f := range []string{"title", "brief", "kind", "writes", "tier", "tier_reason"} {
			if !toolHas(k.args, f) {
				missing = append(missing, f)
			}
		}
		if len(missing) > 0 {
			return "", "missing: " + strings.Join(missing, ", "), nil
		}
		d, refusal := toolDefOf(k.args, l, "")
		if refusal != "" {
			return "", refusal, nil
		}
		if d.writes && len(l.Notes) == 0 {
			return "", k.gate(), nil
		}
		id := TaskID(len(l.Tasks) + 1)
		h := k.holder(turn)
		t := Task{ID: id, Title: d.title, Kind: d.kind, Writes: d.writes, Tier: d.tier, TierReason: d.tierReason, DependsOn: d.deps, NeedsReport: d.needs,
			AddedTurn: toolLatestTurn(l), AddedBy: h.Chat,
			CreatedAt: tx.Now(), ChangedTurns: []int{}, BriefRev: 1,
			Briefs:   []model.BriefRev{{Rev: 1, At: tx.Now(), Turn: h.Turn, Chat: h.Chat, Size: toolChars(d.brief)}},
			HeldBy:   []Holder{h},
			Attempts: []Attempt{{RunAttempt: model.RunAttempt{N: 1, Tier: d.tier, QueuedTurn: toolLatestTurn(l), QueuedBy: h.Chat, QueuedAt: tx.Now(), Phases: []model.RunPhase{}}}}}
		tx.AddTask(t)
		tx.File(briefRel(id, 1), []byte(d.brief+"\n"))
		writes := d.writes
		op.Task, op.Title, op.Kind, op.Writes, op.DependsOn, op.BriefRev = id, d.title, d.kind, &writes, d.deps, 1
		op.Tier, op.TierReason, op.NeedsReport = d.tier, clip(d.tierReason, toolMaxTierReason), d.needs
		k.event(tx, id, fmt.Sprintf("A chat on the run added %s [%s, %s]: %s.", id, d.kind, toolWrites(d.writes), d.title), 600)
		after := "turn"
		if !k.orch {
			after = "reply"
		}
		return fmt.Sprintf("Added %s: %s. It starts after your %s ends, once its dependencies are done.%s%s", id, d.title, after,
			toolDepWarning(func(dep string) model.TaskState { return toolStateOf(l, dep) }, d.deps), toolReportsWarning(l, t)), "", nil
	})
}

// updateTask answers update_task. The brief in force is read before the entry, to tell a change
// of it from the same text; the entry checks that it is still the one in force.
func (k *toolCall) updateTask() (string, string, error) {
	id, _ := toolStr(k.args, "id")
	for {
		rev, old := 0, ""
		if toolHas(k.args, "brief") {
			k.r.mu.Lock()
			if t, ok := toolTask(k.r.L, id); ok {
				rev = t.BriefRev
			}
			k.r.mu.Unlock()
			if rev > 0 {
				text, err := readBrief(k.r.dir, id, rev)
				if err != nil && !errors.Is(err, ErrNoText) {
					return "", "", err
				}
				old = strings.TrimSpace(text)
			}
		}
		text, refusal, err := k.commit(KOp, func(tx *Tx, op *model.RunOp, turn int) (string, string, error) {
			l := tx.L()
			cur, ok := toolTask(l, id)
			if !ok {
				return "", toolNoTask(l, id), nil
			}
			switch st := cur.State(); {
			case st == model.TaskMerge:
				return "", id + " has finished and is being merged; it can no longer be changed. Add a task that depends on it instead.", nil
			case st.Active():
				return "", fmt.Sprintf("%s is %s. Cancel it first if it must change, then retry it.", id, toolCoarse(st)), nil
			case st == model.TaskDone:
				return "", id + " is done and final. Add a task that depends on it instead.", nil
			}
			fields := []string{"title", "brief", "kind", "writes", "tier", "tier_reason", "depends_on", "needs_report"}
			if !slices.ContainsFunc(fields, func(f string) bool { return toolHas(k.args, f) }) {
				return "", "nothing to change: give title, brief, kind, writes, tier, tier_reason, depends_on or needs_report", nil
			}
			d, refusal := toolDefOf(k.args, l, id)
			if refusal != "" {
				return "", refusal, nil
			}
			if d.has.brief && cur.BriefRev != rev {
				return "", "", errToolAgain
			}
			if d.has.deps && !d.has.needs { // a report of a task it no longer depends on
				d.needs = []string{}
				for _, x := range cur.NeedsReport {
					if slices.Contains(d.deps, x) {
						d.needs = append(d.needs, x)
					}
				}
				d.has.needs = true
			}
			var changed []string
			if d.has.title && d.title != cur.Title {
				changed = append(changed, "title")
			}
			if d.has.brief && d.brief != old {
				changed = append(changed, "brief")
			}
			if d.has.kind && d.kind != cur.Kind {
				changed = append(changed, "kind")
			}
			if d.has.writes && d.writes != cur.Writes {
				changed = append(changed, "writes")
			}
			if d.has.tier && d.tier != cur.Tier {
				changed = append(changed, "tier")
			}
			if d.has.tierReason && d.tierReason != cur.TierReason {
				changed = append(changed, "tier_reason")
			}
			if d.has.deps && !slices.Equal(d.deps, cur.DependsOn) {
				changed = append(changed, "depends_on")
			}
			if d.has.needs && !slices.Equal(d.needs, cur.NeedsReport) {
				changed = append(changed, "needs_report")
			}
			if len(changed) == 0 {
				return "", id + " already is as you describe it", nil
			}
			if d.has.writes && d.writes && len(l.Notes) == 0 {
				return "", k.gate(), nil
			}

			t := tx.Task(id)
			h := k.holder(turn)
			for _, f := range changed {
				switch f {
				case "title":
					t.Title = d.title
				case "kind":
					t.Kind = d.kind
				case "writes":
					t.Writes = d.writes
				case "depends_on":
					t.DependsOn = d.deps
				case "needs_report":
					t.NeedsReport = d.needs
				case "tier":
					t.Tier = d.tier
				case "tier_reason":
					t.TierReason = d.tierReason
				case "brief":
					t.BriefRev++
					t.Briefs = append(t.Briefs, model.BriefRev{Rev: t.BriefRev, At: tx.Now(), Turn: h.Turn, Chat: h.Chat, Size: toolChars(d.brief)})
					tx.File(briefRel(id, t.BriefRev), []byte(d.brief+"\n"))
					op.BriefRev = t.BriefRev
				}
			}
			if k.orch && !slices.Contains(t.ChangedTurns, turn) {
				t.ChangedTurns = append(t.ChangedTurns, turn)
			}
			st := t.State()
			if st.Waiting() {
				k.hold(t, turn)
				// The attempt that waits has not started: it runs on the task's tier.
				t.Attempts[len(t.Attempts)-1].Tier = t.Tier
			}
			writes := t.Writes
			op.Task, op.Changed, op.Title, op.Kind, op.Writes, op.DependsOn = id, changed, t.Title, t.Kind, &writes, orEmpty(slices.Clone(t.DependsOn))
			op.Tier, op.NeedsReport = t.Tier, slices.Clone(t.NeedsReport)
			k.event(tx, id, fmt.Sprintf("A chat on the run changed %s (%s).", id, strings.Join(changed, ", ")), 600)
			text := fmt.Sprintf("Updated %s (%s).", id, strings.Join(changed, ", "))
			if st == model.TaskFailed || st == model.TaskCancelled {
				text += fmt.Sprintf(" It is %s: call retry_task to queue it again.", st)
			}
			return text + toolDepWarning(func(dep string) model.TaskState { return toolStateOf(l, dep) }, t.DependsOn) + toolReportsWarning(l, *t), "", nil
		})
		if errors.Is(err, errToolAgain) {
			continue
		}
		return text, refusal, err
	}
}

// cancelTask answers cancel_task. A task that waits, or failed, is closed by the call's own
// entry. A task in setup, work or merge is the engine's to end: the tool asks it (cancelActive),
// with no lock held, and records the call afterwards.
func (k *toolCall) cancelTask() (string, string, error) {
	id, _ := toolStr(k.args, "id")
	reason, _ := toolStr(k.args, "reason")
	reason = clip(strings.TrimSpace(reason), 2000)
	var cancel model.AttemptCancel
	// done records an accepted cancel: the op, a chat's event, and the answer.
	done := func(tx *Tx, op *model.RunOp, l *Loaded) string {
		op.Task, op.Reason = id, clip(reason, 400)
		k.event(tx, id, fmt.Sprintf("A chat on the run cancelled %s: %s", id, reason), 600)
		var waiting []string
		for _, x := range l.Tasks {
			if x.ID != id && x.State().Waiting() && slices.Contains(x.DependsOn, id) {
				waiting = append(waiting, x.ID)
			}
		}
		text := "Cancelled " + id + "."
		if len(waiting) > 0 {
			text += " " + strings.Join(waiting, ", ") + " depend on it and cannot start until you change or cancel them."
		}
		// What the orchestrator cancels itself it no longer waits for.
		if w := tx.State().Wait; k.orch && w != nil && slices.Contains(w.Tasks, id) {
			if rest := slices.DeleteFunc(slices.Clone(w.Tasks), func(x string) bool { return x == id }); len(rest) > 0 {
				tx.State().Wait = &model.RunWait{Tasks: rest, Mode: w.Mode, Turn: w.Turn}
			} else {
				tx.State().Wait = nil
			}
			text += " It is taken out of what you wait for."
		}
		return text
	}
	text, refusal, err := k.commit(KOp, func(tx *Tx, op *model.RunOp, turn int) (string, string, error) {
		l := tx.L()
		cur, ok := toolTask(l, id)
		if !ok {
			return "", toolNoTask(l, id), nil
		}
		if reason == "" {
			return "", "the reason is empty", nil
		}
		h := k.holder(turn)
		cancel = model.AttemptCancel{T: tx.Now(), Reason: reason, Turn: h.Turn, Chat: h.Chat}
		st := cur.State()
		switch {
		case st == model.TaskDone:
			return "", id + " is done; its work is already part of the run. Add a task to change it.", nil
		case st == model.TaskCancelled:
			return "", id + " is already cancelled", nil
		case st.Active():
			return "", "", errToolActive
		}
		t := tx.Task(id)
		a := &t.Attempts[len(t.Attempts)-1]
		a.Outcome, a.Cancel = model.TaskCancelled, &cancel
		if st != model.TaskFailed { // a failed attempt keeps its end, its error and its phases
			a.EndedAt = tx.Now()
		}
		t.HeldBy = nil
		return done(tx, op, l), "", nil
	})
	if !errors.Is(err, errToolActive) {
		return text, refusal, err
	}

	answer := k.s.engine.cancelActive(k.r, id, cancel)
	k.late = true
	text, refusal, err = k.commit(KOp, func(tx *Tx, op *model.RunOp, turn int) (string, string, error) {
		if answer != "" {
			return "", answer, nil
		}
		l := tx.L()
		if st := toolStateOf(l, id); st != model.TaskCancelled {
			return "", fmt.Sprintf("%s is now %s", id, toolCoarse(st)), nil
		}
		return done(tx, op, l), "", nil
	})
	if err == nil && refusal == toolTurnOver(k.name) && answer == "" {
		// The task was cancelled, and the turn ended while its worker let go: say what happened.
		return "Cancelled " + id + ".", "", nil
	}
	return text, refusal, err
}

// retryTask answers retry_task: a new attempt of a failed or cancelled task.
func (k *toolCall) retryTask() (string, string, error) {
	id, _ := toolStr(k.args, "id")
	reason, _ := toolStr(k.args, "reason")
	reason = clip(strings.TrimSpace(reason), 2000)
	return k.commit(KOp, func(tx *Tx, op *model.RunOp, turn int) (string, string, error) {
		l := tx.L()
		cur, ok := toolTask(l, id)
		if !ok {
			return "", toolNoTask(l, id), nil
		}
		if reason == "" {
			return "", "the reason is empty", nil
		}
		tier, refusal := toolTier(k.args)
		if refusal != "" {
			return "", refusal, nil
		}
		if st := cur.State(); st != model.TaskFailed && st != model.TaskCancelled {
			return "", fmt.Sprintf("%s is %s; only a failed or cancelled task can be retried", id, toolCoarse(st)), nil
		}
		t := tx.Task(id)
		h := k.holder(turn)
		n := len(t.Attempts) + 1
		if tier != "" && tier != t.Tier { // the new attempt is a new agent, so it can run on another model
			t.Tier, t.TierReason = tier, strings.Join(strings.Fields(reason), " ")
		}
		t.Attempts = append(t.Attempts, Attempt{RunAttempt: model.RunAttempt{N: n, Tier: t.Tier, QueuedTurn: toolLatestTurn(l), QueuedBy: h.Chat,
			QueuedAt: tx.Now(), Phases: []model.RunPhase{}}})
		t.HeldBy = []Holder{h}
		if k.orch && !slices.Contains(t.ChangedTurns, turn) {
			t.ChangedTurns = append(t.ChangedTurns, turn)
		}
		op.Task, op.Reason, op.Attempt, op.Tier = id, clip(reason, 400), n, t.Tier
		k.event(tx, id, fmt.Sprintf("A chat on the run queued %s again as attempt %d: %s", id, n, reason), 600)
		text := fmt.Sprintf("%s is queued again as attempt %d (%s)", id, n, t.Tier)
		if k.r.meta.Git {
			text += ", from a fresh checkout"
		}
		return text + "." + toolDepWarning(func(dep string) model.TaskState { return toolStateOf(l, dep) }, t.DependsOn), "", nil
	})
}

// finishRun answers finish_run (the orchestrator's alone): the run ends when its turn does.
func (k *toolCall) finishRun() (string, string, error) {
	outcome, _ := toolStr(k.args, "outcome")
	summary, _ := toolStr(k.args, "summary")
	summary = strings.TrimSpace(summary)
	return k.commit(KOp, func(tx *Tx, op *model.RunOp, turn int) (string, string, error) {
		if o := model.RunOutcome(outcome); o != model.Achieved && o != model.NotAchieved {
			return "", "outcome must be achieved or not_achieved", nil
		}
		if summary == "" {
			return "", "the summary is empty", nil
		}
		var open []string
		for _, t := range tx.L().Tasks {
			if st := t.State(); st.Waiting() || st.Active() {
				open = append(open, t.ID)
			}
		}
		if len(open) > 0 {
			return "", strings.Join(open, ", ") + " are not finished. Let them finish and decide then, or cancel the ones the run no longer needs.", nil
		}
		tx.State().Result = &model.RunResult{Outcome: model.RunOutcome(outcome), Summary: summary, Turn: turn, At: tx.Now()}
		op.Outcome, op.Text = model.RunOutcome(outcome), clip(summary, 600)
		return toolFinishResult, "", nil
	})
}

// tell answers tell_orchestrator (a chat's alone): the message becomes an event for the next turn.
func (k *toolCall) tell() (string, string, error) {
	msg, _ := toolStr(k.args, "text")
	msg = strings.TrimSpace(msg)
	return k.commit(KOp, func(tx *Tx, op *model.RunOp, turn int) (string, string, error) {
		switch n := toolChars(msg); {
		case n == 0:
			return "", "the message is empty", nil
		case n > toolMaxMessage:
			return "", fmt.Sprintf("the message is %s characters; keep it to 4,000", toolNum(n)), nil
		}
		l := tx.L()
		op.Text = clip(msg, 600)
		k.event(tx, "", "Message from the person, passed on by a chat on the run:\n"+msg, toolMaxMessage+100)
		when := ", when the person resumes the run"
		if l.State.Status == model.RunRunning {
			when = ", which is now"
			if n := len(l.Turns); n > 0 && l.Turns[n-1].Status == "running" {
				when = ", after the turn that is running"
			}
		}
		return "Passed on. The orchestrator reads it when its next turn starts" + when + ".", "", nil
	})
}

// gate is the refusal of a task that changes the repository while the run has no notes.
func (k *toolCall) gate() string {
	if k.orch {
		return toolGateOrch
	}
	return toolGateChat
}

// ---- arguments and definitions ---------------------------------------------------------------

// toolArgs reads a call's arguments: an object, or nothing at all.
func toolArgs(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	if s := strings.TrimSpace(string(raw)); s == "" || s == "null" {
		return map[string]json.RawMessage{}, true
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return map[string]json.RawMessage{}, false
	}
	return m, true
}

// toolHas reports whether the call gives the argument (null is not given).
func toolHas(a map[string]json.RawMessage, key string) bool {
	raw, ok := a[key]
	return ok && strings.TrimSpace(string(raw)) != "null"
}

// toolStr is a text argument. A value that is not a string is taken as it is written.
func toolStr(a map[string]json.RawMessage, key string) (string, bool) {
	if !toolHas(a, key) {
		return "", false
	}
	var s string
	if json.Unmarshal(a[key], &s) != nil {
		return strings.TrimSpace(string(a[key])), true
	}
	return s, true
}

// toolInt is a whole-number argument, def when it is not given; bad when it is not a number.
func toolInt(a map[string]json.RawMessage, key string, def int) (n int, bad bool) {
	if !toolHas(a, key) {
		return def, false
	}
	var f float64
	if json.Unmarshal(a[key], &f) != nil || f != float64(int(f)) {
		return def, true
	}
	return int(f), false
}

// toolRawArg is an argument as the caller wrote it, for a refusal that names it.
func toolRawArg(a map[string]json.RawMessage, key string) string {
	return clip(strings.TrimSpace(string(a[key])), 40)
}

func toolLatestTurn(l *Loaded) int {
	if n := len(l.Turns); n > 0 {
		return l.Turns[n-1].N
	}
	return 0
}

// toolDef is a task's definition as a call gives it, cleaned: only the fields that has names.
type toolDef struct {
	title, brief, kind string
	writes             bool
	tier               model.Tier
	tierReason         string
	deps, needs        []string
	has                struct{ title, brief, kind, writes, tier, tierReason, deps, needs bool }
}

// toolMaxTierReason is how much of the reason for a tier an op records, in characters.
const toolMaxTierReason = 300

// toolBadTier is the refusal of a tier the run does not have.
const toolBadTier = "tier must be one of deep, standard, light"

// toolTier is the tier argument of a call: "" when it is not given, a refusal when it names none.
func toolTier(a map[string]json.RawMessage) (model.Tier, string) {
	if !toolHas(a, "tier") {
		return "", ""
	}
	var s string
	if json.Unmarshal(a["tier"], &s) != nil || !model.ValidTier(s) {
		return "", toolBadTier
	}
	return model.Tier(s), ""
}

// toolMinBrief is the shortest brief a task can have, in characters.
const toolMinBrief = 40

var (
	toolKindRe  = regexp.MustCompile(`^[a-z][a-z0-9-]{0,23}$`)
	toolNotSlug = regexp.MustCompile(`[^a-z0-9]+`)
)

// toolDefOf checks the definition fields a call gives (T13 §8.2). self is the task an update is
// about: it cannot depend on itself, nor on a task that depends on it.
func toolDefOf(a map[string]json.RawMessage, l *Loaded, self string) (d toolDef, refusal string) {
	if d.has.tier = toolHas(a, "tier"); d.has.tier {
		if d.tier, refusal = toolTier(a); refusal != "" {
			return d, refusal
		}
	}
	if d.has.tierReason = toolHas(a, "tier_reason"); d.has.tierReason {
		s, _ := toolStr(a, "tier_reason")
		if d.tierReason = strings.Join(strings.Fields(s), " "); d.tierReason == "" {
			return d, "tier_reason is empty: say in a sentence why this tier is enough for the task"
		}
	}
	if d.has.title = toolHas(a, "title"); d.has.title {
		s, _ := toolStr(a, "title")
		if d.title = strings.Join(strings.Fields(s), " "); d.title == "" {
			return d, "the title is empty"
		}
	}
	if d.has.brief = toolHas(a, "brief"); d.has.brief {
		s, _ := toolStr(a, "brief")
		if d.brief = strings.TrimSpace(s); toolChars(d.brief) < toolMinBrief {
			return d, "the brief is too short to work from: its agent knows nothing but the brief"
		}
	}
	if d.has.kind = toolHas(a, "kind"); d.has.kind {
		s, _ := toolStr(a, "kind")
		d.kind = strings.Trim(toolNotSlug.ReplaceAllString(strings.ToLower(s), "-"), "-")
		if len(d.kind) > 24 {
			d.kind = strings.Trim(d.kind[:24], "-")
		}
		if !toolKindRe.MatchString(d.kind) {
			return d, "kind must be one short word, e.g. research, implement, review"
		}
	}
	if d.has.writes = toolHas(a, "writes"); d.has.writes {
		if json.Unmarshal(a["writes"], &d.writes) != nil {
			return d, "writes must be true or false"
		}
	}
	if d.has.deps = toolHas(a, "depends_on"); d.has.deps {
		var list []string
		if json.Unmarshal(a["depends_on"], &list) != nil {
			return d, "depends_on must be a list of task ids"
		}
		d.deps = []string{}
		var unknown []string
		for _, id := range list {
			if slices.Contains(d.deps, id) {
				continue
			}
			d.deps = append(d.deps, id)
			if !l.hasTask(id) {
				unknown = append(unknown, id)
			}
		}
		if len(unknown) > 0 {
			return d, "depends_on names tasks that do not exist: " + strings.Join(unknown, ", ")
		}
		if self != "" {
			if slices.Contains(d.deps, self) {
				return d, self + " cannot depend on itself"
			}
			if path := toolCycle(l, self, d.deps); path != nil {
				return d, "that would make a dependency cycle: " + strings.Join(path, " -> ")
			}
		}
	} else if self == "" {
		d.deps = []string{}
	}
	if d.has.needs = toolHas(a, "needs_report"); d.has.needs {
		var list []string
		if json.Unmarshal(a["needs_report"], &list) != nil {
			return d, "needs_report must be a list of task ids"
		}
		deps := d.deps
		if !d.has.deps && self != "" {
			t, _ := toolTask(l, self)
			deps = t.DependsOn
		}
		d.needs = []string{}
		var outside []string
		for _, id := range list {
			if slices.Contains(d.needs, id) {
				continue
			}
			d.needs = append(d.needs, id)
			if !slices.Contains(deps, id) {
				outside = append(outside, id)
			}
		}
		if len(outside) > 0 {
			return d, "needs_report names tasks this one does not depend on: " + strings.Join(outside, ", ") + ". Add them to depends_on as well."
		}
	} else if self == "" {
		d.needs = []string{}
	}
	return d, ""
}

// toolCycle looks for a way from one of deps back to self along the tasks' dependencies: the
// cycle that making self depend on deps would close, from self to self; nil when there is none.
func toolCycle(l *Loaded, self string, deps []string) []string {
	seen := map[string]bool{}
	var walk func(id string, path []string) []string
	walk = func(id string, path []string) []string {
		if id == self {
			return append(path, id)
		}
		if seen[id] {
			return nil
		}
		seen[id] = true
		t, ok := toolTask(l, id)
		if !ok {
			return nil
		}
		for _, d := range t.DependsOn {
			if p := walk(d, append(slices.Clone(path), id)); p != nil {
				return p
			}
		}
		return nil
	}
	for _, d := range deps {
		if p := walk(d, []string{self}); p != nil {
			return p
		}
	}
	return nil
}
