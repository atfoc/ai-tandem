//go:build !windows

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/container/containertest"
	"ai-whiteboard/internal/model"
)

// The Claude accounts through real server processes (plan, stream G): the stand-in docker
// (containertest) is the server's -docker, and the stand-in claude (agenttest.FakeClaude) is both
// the computer's own Claude Code (-claude) and the claude program of the accounts' containers
// (AIWB_TEST_ALIAS_CLAUDE): the stand-in docker runs a `docker exec` on the host, in the folder of
// its -w and with its -e vars, so the fake claude runs as it would in the container, with the
// account's CLAUDE_CONFIG_DIR and HOME. It reaches the server's MCP listener at the URL a
// container uses through FAKE_CLAUDE_MCP_HOST_MAP.
//
// Every server process here has a HOME of its own (a temp folder): nothing reads or writes the
// computer's ~/.claude.

// accountServer is a server of the account tests and what it runs with.
type accountServer struct {
	*instance
	docker *containertest.Fake
	fake   string // the fake claude: -claude and the accounts' claude
	s      *retryServer
}

// newAccountServer makes the instance of an account test: the stand-in docker with the default
// image present (so no build is needed), the fake claude as the accounts' claude too, reaching the
// MCP listener through FAKE_CLAUDE_MCP_HOST_MAP, and what newAccountInstance gives. The server is
// not started.
func newAccountServer(t *testing.T) *accountServer {
	t.Helper()
	a := newAccountInstance(t)
	a.docker = containertest.New(t)
	a.docker.AddImage(container.DefaultImage())
	a.instance.docker = a.docker.Bin
	a.setenv("AIWB_TEST_ALIAS_CLAUDE="+a.fake, "FAKE_CLAUDE_MCP_HOST_MAP=host.docker.internal=127.0.0.1")
	return a
}

// newAccountInstance is the instance of an account test whatever its docker: the fake claude as
// -claude, a HOME of its own, the retry's first pause and the agents' look-up on the fastest clock.
// The caller sets the docker (-docker) and the accounts' claude (AIWB_TEST_ALIAS_CLAUDE). The
// server is not started.
func newAccountInstance(t *testing.T) *accountServer {
	t.Helper()
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH (the fake claude is a Node script)")
	}
	a := &accountServer{instance: newInstance(t), fake: agenttest.FakeClaude(t)}
	a.claude = a.fake
	a.setenv("HOME="+t.TempDir(), "FAKE_CLAUDE_STATE="+t.TempDir(), fastest.env(t, "retry", "agents"))
	return a
}

// start starts the server and waits until it serves its clients and has looked at the stand-in
// docker (until then every account is refused with notLookedAt).
func (a *accountServer) start(t *testing.T) {
	t.Helper()
	a.s = startRetryServer(t, a.instance)
	a.waitFor(t, "Docker found", func() bool { return a.aliasList(t).Docker.OK })
}

// realDir is a new temp folder, symlinks resolved: the path the server keeps for it.
func realDir(t *testing.T) string {
	t.Helper()
	d, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// addAccount adds the account through POST /api/aliases with the folders mounted and returns it.
func (a *accountServer) addAccount(t *testing.T, name string, mounts ...string) aliases.View {
	t.Helper()
	var v aliases.View
	a.must(t, testClient, "POST", "/api/aliases", map[string]any{"name": name, "mounts": mounts}, &v)
	if v.ID == "" || v.Kind != model.AliasKind(v.ID) || v.Name != name || !slices.Equal(v.Mounts, mounts) || v.Login.LoggedIn {
		t.Fatalf("POST /api/aliases answered %+v", v)
	}
	return v
}

// logIn logs the account in through the login routes, as the app does: the start answers waiting
// with the URL, the good code answers logged_in with the account's email. For at most build the
// start may answer preparing (the account's image is being built), and it is asked again, as the
// app asks again; 0: the image is there, and the first answer is waiting.
func (a *accountServer) logIn(t *testing.T, id string, build time.Duration) {
	t.Helper()
	var ans aliases.LoginAnswer
	a.must(t, testClient, "POST", "/api/aliases/"+id+"/login", nil, &ans)
	for deadline := time.Now().Add(build); ans.State == aliases.LoginPreparing && time.Now().Before(deadline); {
		time.Sleep(time.Second)
		a.must(t, testClient, "POST", "/api/aliases/"+id+"/login", nil, &ans)
	}
	if ans.State != aliases.LoginWaiting || !strings.HasPrefix(ans.URL, "https://claude.example/oauth/authorize?") {
		t.Fatalf("POST login: %+v, want waiting with the URL\n%s", ans, a.s.out.String())
	}
	a.must(t, testClient, "POST", "/api/aliases/"+id+"/login/code", map[string]any{"code": "good#code"}, &ans)
	if ans.State != aliases.LoginLoggedIn || ans.Email != "account@example.com" {
		t.Fatalf("POST login/code: %+v, want logged_in as account@example.com\n%s", ans, a.s.out.String())
	}
}

// aliasList is GET /api/aliases.
func (a *accountServer) aliasList(t *testing.T) aliases.List {
	t.Helper()
	var l aliases.List
	a.must(t, testClient, "GET", "/api/aliases", nil, &l)
	return l
}

// view is the account's row of GET /api/aliases.
func (a *accountServer) view(t *testing.T, id string) aliases.View {
	t.Helper()
	for _, v := range a.aliasList(t).Aliases {
		if v.ID == id {
			return v
		}
	}
	t.Fatalf("GET /api/aliases has no account %s", id)
	return aliases.View{}
}

// snapshotAgents is the agents of the snapshot (GET /api/state).
func (a *accountServer) snapshotAgents(t *testing.T) []model.AgentKind {
	t.Helper()
	var st struct{ Agents []model.AgentKind }
	a.must(t, testClient, "GET", "/api/state", nil, &st)
	return st.Agents
}

// accountChat makes a chat on the agent kind, on the board when board is not "", in the folder cwd.
func (a *accountServer) accountChat(t *testing.T, kind model.AgentKind, board, cwd string) string {
	t.Helper()
	body := map[string]any{"agent": kind, "group": model.Ungrouped}
	if board != "" {
		body = map[string]any{"agent": kind, "board": board}
	}
	var made model.ChatView
	a.must(t, testClient, "POST", "/api/chats", body, &made)
	if made.Agent != kind {
		t.Fatalf("POST /api/chats: agent %q, want %q", made.Agent, kind)
	}
	a.must(t, testClient, "PATCH", "/api/chats/"+made.ID, map[string]any{"cwd": cwd}, nil)
	return made.ID
}

// waitFor polls until ok holds, for at most a minute: a bound for what must happen, not a measure.
func (a *accountServer) waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	waitRetry(t, what, a.s, ok)
}

// dockerExec is one `docker exec` of the server, taken apart.
type dockerExec struct {
	dir     string            // -w
	env     map[string]string // -e, the last value of a name
	name    string            // the container
	wrapper []string          // /bin/sh -c <script> <$0>, when the run wrapper starts argv
	argv    []string
}

// parseExec takes apart the args of a recorded `docker exec`.
func parseExec(t *testing.T, args []string) dockerExec {
	t.Helper()
	e := dockerExec{env: map[string]string{}}
	i := 1 // after "exec"
	for ; i < len(args) && strings.HasPrefix(args[i], "-"); i++ {
		switch args[i] {
		case "-i":
		case "-w":
			i++
			e.dir = args[i]
		case "-e":
			i++
			k, v, _ := strings.Cut(args[i], "=")
			e.env[k] = v
		default:
			t.Fatalf("docker exec with the flag %q: %q", args[i], args)
		}
	}
	if i >= len(args) {
		t.Fatalf("docker exec without a container: %q", args)
	}
	e.name, e.argv = args[i], args[i+1:]
	if len(e.argv) >= 4 && e.argv[0] == "/bin/sh" && e.argv[1] == "-c" {
		e.wrapper, e.argv = e.argv[:4], e.argv[4:]
	}
	return e
}

// chatExecs are the execs of chat processes (the stream-JSON ones with a session) in the order
// they were made.
func (a *accountServer) chatExecs(t *testing.T) []dockerExec {
	t.Helper()
	var out []dockerExec
	for _, c := range a.docker.CallsOf("exec") {
		e := parseExec(t, c)
		if slices.Contains(e.argv, "--input-format") && (slices.Contains(e.argv, "--session-id") || slices.Contains(e.argv, "--resume")) {
			out = append(out, e)
		}
	}
	return out
}

// lastChatExec is the newest exec of a chat process whose --mcp-config is the file of the chat
// object id (a chat, or "<chat>/subagents/<sid>").
func (a *accountServer) lastChatExec(t *testing.T, aliasDir, object string) (dockerExec, bool) {
	t.Helper()
	want := filepath.Join(aliasDir, "mcp", strings.ReplaceAll(object, "/", "-")+".json")
	execs := a.chatExecs(t)
	for i := len(execs) - 1; i >= 0; i-- {
		if argOf(execs[i].argv, "--mcp-config") == want {
			return execs[i], true
		}
	}
	return dockerExec{}, false
}

// argOf is the value after the flag in argv, "" when there is none.
func argOf(argv []string, flag string) string {
	if i := slices.Index(argv, flag); i >= 0 && i+1 < len(argv) {
		return argv[i+1]
	}
	return ""
}

// runOf is the stand-in's run of the id.
func (a *accountServer) runOf(id string) (containertest.Run, bool) {
	for _, r := range a.docker.Runs() {
		if r.ID == id {
			return r, true
		}
	}
	return containertest.Run{}, false
}

// refusal is the JSON of a refused call.
type refusal struct{ Error, Code string }

var runIDForm = regexp.MustCompile(`^r[0-9a-f]{16}$`)

// notLookedAt is Docker's reason before the server's first look at it.
const notLookedAt = "Docker has not been looked at yet"

// The head of claude's arguments for a chat process (claude.Spawner.Args), before its session.
var chatArgsHead = []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json",
	"--verbose", "--include-partial-messages", "--permission-mode", "auto", "--permission-prompt-tool", "stdio",
	"--forward-subagent-text"}

// A Claude account from its add to its chats, on one server with the stand-in docker (a–f, h, i, l
// of the plan's stream G): the account is added with a folder mounted and logged in through the
// login routes; a board chat on it in that folder runs in the account's container (the create's
// and the exec's args), its MCP config is in the account's folder with host.docker.internal and its
// board calls reach the board; a subagent and a fork run on the account too; the account's Stop with
// a working turn kills the run in the container; a temporary error is retried; a chat in a folder
// that is not mounted is refused, with nothing run; the account's model list is probed.
func TestAccountChatsThroughTheStandInDocker(t *testing.T) {
	smokeTest(t)
	a := newAccountServer(t)
	a.start(t)
	w := a.window(t) // a client with an event stream: the agents and catalog events, and the board's window

	// (a) The account, with one folder mounted, logged in through the login routes.
	mounted, elsewhere := realDir(t), realDir(t)
	v := a.addAccount(t, "Work", mounted)
	id, kind := v.ID, v.Kind
	aliasDir := aliases.Dir(a.dir, id)
	if slices.Contains(a.snapshotAgents(t), kind) {
		t.Fatalf("the agents list %s before the login", kind)
	}
	a.logIn(t, id, 0)
	a.waitFor(t, "an agents event that lists "+string(kind), func() bool {
		for _, ev := range w.events() {
			if l, _ := ev["agents"].([]any); ev["type"] == "agents" && slices.Contains(l, any(string(kind))) {
				return true
			}
		}
		return false
	})
	if got := a.snapshotAgents(t); !slices.Contains(got, kind) {
		t.Fatalf("the snapshot's agents %v do not list %s after the login", got, kind)
	}
	if got := a.view(t, id); !got.Login.LoggedIn || got.Login.Email != "account@example.com" || got.Container.State != aliases.ContainerRunning {
		t.Fatalf("the account after the login: %+v", got)
	}

	// (b) The container: exactly the account's folder and the mounted one, Docker's host name of
	// the host, the person's uid:gid, an init, the labels.
	name := container.Name(id)
	ctr, ok := a.docker.Container(name)
	if !ok || len(a.docker.CallsOf("create")) != 1 {
		t.Fatalf("containers %+v, creates %q: want one create of %s", a.docker.Containers(), a.docker.CallsOf("create"), name)
	}
	if want := []string{aliasDir + ":" + aliasDir, mounted + ":" + mounted}; !slices.Equal(ctr.Binds, want) {
		t.Fatalf("the container's mounts %q, want exactly %q", ctr.Binds, want)
	}
	if want := strconv.Itoa(os.Getuid()) + ":" + strconv.Itoa(os.Getgid()); ctr.User != want || !ctr.Init ||
		!slices.Equal(ctr.ExtraHosts, []string{"host.docker.internal:host-gateway"}) || ctr.Image != container.DefaultImage() ||
		ctr.Labels[container.LabelAlias] != id || ctr.Labels[container.LabelSpec] == "" || ctr.State != "running" {
		t.Fatalf("the container %+v: want --user %s, --init, the host-gateway host, the default image, the labels, running", ctr, want)
	}

	// (l) The account's model list is probed in its container once it runs, and sent as a catalog
	// event of its kind.
	a.waitFor(t, "a catalog event of "+string(kind), func() bool {
		for _, ev := range w.events() {
			if ev["type"] == "catalog" && ev["agent"] == string(kind) && ev["catalog"] != nil {
				return true
			}
		}
		return false
	})
	probed := false
	for _, c := range a.docker.CallsOf("exec") {
		if e := parseExec(t, c); e.name == name && len(e.argv) > 1 && slices.Equal(e.argv[1:], claude.ProbeArgs()) {
			probed = e.argv[0] == a.fake
		}
	}
	if !probed {
		t.Fatalf("no exec of the model list probe in %s: %q", name, a.docker.CallsOf("exec"))
	}

	// (b, c) A board chat on the account in the mounted folder: its process runs in the container,
	// in that folder, with the account's environment, through the run wrapper, as claude's usual
	// chat process with the account's claude program.
	var board struct{ ID string }
	a.must(t, testClient, "POST", "/api/boards", map[string]any{"name": "accounts", "group": model.Ungrouped}, &board)
	a.take(t, w, board.ID)
	var rpcs atomic.Int32
	w.OnRPC(func(map[string]any) (any, string) { rpcs.Add(1); return "from the window", "" })
	chat := a.accountChat(t, kind, board.ID, mounted)
	reply := a.say(t, chat, `hello [[mcp read_board {}]] [[mcp apply {"add":[]}]]`)
	for _, want := range []string{"FAKE(", "read_board -> from the window\n", "apply -> from the window\n"} {
		if !strings.Contains(reply, want) {
			t.Fatalf("the reply has no %q:\n%s\n%s", want, reply, a.s.out.String())
		}
	}
	if n := rpcs.Load(); n != 2 {
		t.Fatalf("the window was given %d board calls, want the read and the change", n)
	}
	e, ok := a.lastChatExec(t, aliasDir, chat)
	if !ok {
		t.Fatalf("no exec of the chat's process: %q", a.docker.CallsOf("exec"))
	}
	wantEnv := map[string]string{"CLAUDE_CONFIG_DIR": aliases.ClaudeDir(a.dir, id), "HOME": aliases.HomeDir(a.dir, id),
		"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1", "DISABLE_AUTOUPDATER": "1"}
	for k, want := range wantEnv {
		if e.env[k] != want {
			t.Errorf("the exec's %s=%q, want %q", k, e.env[k], want)
		}
	}
	if e.dir != mounted || e.name != name || !runIDForm.MatchString(e.env["AIWB_RUN"]) ||
		!slices.Equal(e.wrapper, []string{"/bin/sh", "-c", container.RunScript, container.RunName}) {
		t.Fatalf("the chat's exec: -w %q, container %q, AIWB_RUN %q, wrapper %q; want -w %s, %s, a run id, the run wrapper",
			e.dir, e.name, e.env["AIWB_RUN"], e.wrapper, mounted, name)
	}
	if len(e.argv) < len(chatArgsHead)+3 || e.argv[0] != a.fake || !slices.Equal(e.argv[1:len(chatArgsHead)+1], chatArgsHead) ||
		e.argv[len(chatArgsHead)+1] != "--session-id" || e.argv[len(chatArgsHead)+2] == "" {
		t.Fatalf("the chat's argv %q: want the fake claude, then %q and --session-id", e.argv, chatArgsHead)
	}
	// The app folder's deny rules are absolute: the container's ~ is the account's home.
	if got, want := argOf(e.argv, "--disallowedTools"), strings.Join(append(claude.AppDirRules(a.dir, ""), "Task", "Agent"), ","); got != want {
		t.Fatalf("--disallowedTools %q, want %q", got, want)
	}
	if run, ok := a.runOf(e.env["AIWB_RUN"]); !ok || run.Container != name {
		t.Fatalf("the stand-in has no run %s in %s: %+v", e.env["AIWB_RUN"], name, a.docker.Runs())
	}
	session := e.argv[len(chatArgsHead)+2]

	// (c) The MCP config is in the account's folder, readable by the person alone, with the URL a
	// container reaches the MCP listener at; none is in the chat's folders.
	mcpFile := filepath.Join(aliases.MCPDir(a.dir, id), chat+".json")
	fi, err := os.Stat(mcpFile)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("the MCP config %s: %v, mode %v; want 0600", mcpFile, err, fi)
	}
	var cfg struct {
		MCPServers map[string]struct{ URL string }
	}
	if raw, err := os.ReadFile(mcpFile); err != nil || json.Unmarshal(raw, &cfg) != nil {
		t.Fatalf("the MCP config: %v %s", err, raw)
	}
	if got, want := cfg.MCPServers["board"].URL, fmt.Sprintf("http://host.docker.internal:%d/mcp", a.mcpPort); got != want {
		t.Fatalf("the MCP config's URL %q, want %q", got, want)
	}
	for _, p := range []string{filepath.Join(a.dir, "chats", chat, "mcp.json"), filepath.Join(mounted, "mcp.json")} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s: %v, want no MCP config there", p, err)
		}
	}

	// (d) A subagent of the account chat runs on the account, in the same container.
	a.say(t, chat, `[[mcp spawn_subagent {"prompt":"sub hello","description":"helper"}]]`)
	var sub model.Subagent
	a.waitFor(t, "the subagent completed", func() bool {
		_, subs := a.chatThread(t, chat)
		if len(subs) == 1 {
			sub = subs[0]
		}
		return len(subs) == 1 && sub.Status == model.SubCompleted
	})
	se, ok := a.lastChatExec(t, aliasDir, chat+"/subagents/"+sub.ID)
	if !ok || se.name != name || se.dir != mounted || se.argv[0] != a.fake || se.env["CLAUDE_CONFIG_DIR"] != aliases.ClaudeDir(a.dir, id) ||
		!runIDForm.MatchString(se.env["AIWB_RUN"]) || se.env["AIWB_RUN"] == e.env["AIWB_RUN"] {
		t.Fatalf("the subagent %+v: its exec %+v (found %v), want one in %s, in %s, with its own run", sub, se, ok, name, mounted)
	}
	if sub.Kind != "" && sub.Kind != kind {
		t.Fatalf("the subagent's kind %q, want %q", sub.Kind, kind)
	}

	// (h) A fork of the account chat runs on the account: its process is started in the container
	// from the chat's session.
	items, _ := a.chatThread(t, chat)
	var fork model.ChatView
	a.must(t, testClient, "POST", "/api/chats/"+chat+"/fork", map[string]any{"branch": "main", "at": len(items)}, &fork)
	if fork.Agent != kind || fork.Cwd != mounted {
		t.Fatalf("the fork: agent %q, folder %q; want %q in %s", fork.Agent, fork.Cwd, kind, mounted)
	}
	fe, ok := a.lastChatExec(t, aliasDir, fork.ID)
	if !ok || fe.name != name || fe.dir != mounted || !slices.Contains(fe.argv, "--fork-session") || argOf(fe.argv, "--resume") != session {
		t.Fatalf("the fork's exec %+v (found %v): want one in %s with --resume %s --fork-session", fe, ok, name, session)
	}
	if reply := a.say(t, fork.ID, "hello fork"); !strings.Contains(reply, "FAKE(") {
		t.Fatalf("the fork's reply:\n%s", reply)
	}

	// (i) A chat on the account whose folder is not mounted is refused, and nothing is run.
	other := a.accountChat(t, kind, "", elsewhere)
	execs := len(a.docker.CallsOf("exec"))
	status, body := a.call(t, testClient, "POST", "/api/chats/"+other+"/messages", map[string]any{"text": "hello"}, nil)
	var r refusal
	json.Unmarshal([]byte(body), &r)
	if want := (&aliases.MountError{Account: "Work", Folder: elsewhere}).Error(); status != http.StatusConflict || r.Code != aliases.CodeNotMounted || r.Error != want {
		t.Fatalf("a message in a folder that is not mounted: %d %s, want 409 %s %q", status, body, aliases.CodeNotMounted, want)
	}
	time.Sleep(200 * time.Millisecond)
	for _, c := range a.docker.CallsOf("exec")[execs:] {
		if e := parseExec(t, c); e.dir == elsewhere || slices.Contains(e.argv, "hello") {
			t.Fatalf("an exec after the refusal: %q", c)
		}
	}
	if items, _ := a.chatThread(t, other); len(items) != 0 {
		t.Fatalf("the refused chat has items: %+v", items)
	}

	// (e) The account's Stop while a turn works: first it answers busy, then, forced, it kills the
	// run in the container (the kill wrapper for its run id, the run's group gone) and stops the
	// container.
	a.must(t, testClient, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": "[[sleep 30]]"}, nil)
	var working dockerExec
	a.waitFor(t, "the chat working, its run live", func() bool {
		cv := a.chatView(t, chat)
		e, _ := a.lastChatExec(t, aliasDir, chat)
		r, ok := a.runOf(e.env["AIWB_RUN"])
		working = e
		return cv.Status != model.StatusReady && ok && r.Live
	})
	runID := working.env["AIWB_RUN"]
	var ch aliases.Change
	a.must(t, testClient, "POST", "/api/aliases/"+id+"/stop", map[string]any{}, &ch)
	if ch.Restart != aliases.RestartBusy || ch.Busy != 1 {
		t.Fatalf("the Stop with a working turn: %+v, want busy 1", ch)
	}
	a.must(t, testClient, "POST", "/api/aliases/"+id+"/stop", map[string]any{"force": true}, &ch)
	if ch.Restart != aliases.RestartDone {
		t.Fatalf("the forced Stop: %+v, want done", ch)
	}
	a.waitFor(t, "the run killed", func() bool {
		r, _ := a.runOf(runID)
		return slices.Contains(a.docker.Kills(), runID) && !r.Live
	})
	if ctr, _ := a.docker.Container(name); ctr.State == "running" || len(a.docker.CallsOf("stop")) != 1 {
		t.Fatalf("after the Stop the container is %q, with stops %q", ctr.State, a.docker.CallsOf("stop"))
	}
	a.waitFor(t, "the chat no longer working", func() bool { return a.chatView(t, chat).Status == model.StatusReady })

	// (f) A temporary error is retried on the account: the turn that the API refused is started
	// again, in the container (started again with no new create), and answers.
	starts := len(a.docker.CallsOf("start"))
	before := len(a.chatExecs(t))
	a.must(t, testClient, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": "[[apierror authentication_failed 1]] hello again"}, nil)
	var seen bool
	a.waitFor(t, "the chat retrying", func() bool {
		cv := a.chatView(t, chat)
		seen = seen || cv.Status == model.StatusRetrying
		return seen
	})
	a.waitFor(t, "the chat idle again", func() bool {
		cv := a.chatView(t, chat)
		return cv.Status == model.StatusReady && cv.Retry == (model.Retry{})
	})
	items, _ = a.chatThread(t, chat)
	if last := items[len(items)-1]; !strings.Contains(fmt.Sprint(items), "FAKE(") || last.Kind == "error" {
		t.Fatalf("the retried turn's items: %+v", items)
	}
	var retried []dockerExec
	for _, e := range a.chatExecs(t)[before:] {
		if argOf(e.argv, "--mcp-config") == mcpFile {
			retried = append(retried, e)
		}
	}
	if len(retried) < 2 || len(a.docker.CallsOf("create")) != 1 || len(a.docker.CallsOf("start")) <= starts {
		t.Fatalf("the retry: %d execs of the chat (want the attempt and the retry), creates %d (want 1), starts %d (want more than %d)",
			len(retried), len(a.docker.CallsOf("create")), len(a.docker.CallsOf("start")), starts)
	}
	for _, e := range retried {
		if e.name != name || argOf(e.argv, "--resume") != session {
			t.Fatalf("an exec of the retry: %+v, want --resume %s in %s", e, session, name)
		}
	}
	noSecret(t, a.secret, a.s.out.String())
	// The login's URL and code are in the answers to the calls alone: in no event, in no log.
	var events strings.Builder
	for _, ev := range w.events() {
		b, _ := json.Marshal(ev)
		events.Write(b)
	}
	for _, secret := range []string{"claude.example/oauth", "good#code"} {
		if strings.Contains(a.s.out.String(), secret) || strings.Contains(events.String(), secret) {
			t.Errorf("the login's %q is in the server's log or in an event", secret)
		}
	}
}

// A Claude account across a stop of the server (g, k of the plan's stream G): SIGTERM while a
// turn of an account chat works kills the run in the container and leaves the container running
// (no stop, no rm); a new server on the same data folder and the same Docker finds the container
// (no second create, no start) and the next message resumes the chat's session in it.
func TestAccountChatAfterARestart(t *testing.T) {
	smokeTest(t)
	a := newAccountServer(t)
	a.start(t)
	mounted := realDir(t)
	v := a.addAccount(t, "Home", mounted)
	id, kind := v.ID, v.Kind
	aliasDir, name := aliases.Dir(a.dir, id), container.Name(id)
	a.logIn(t, id, 0)
	a.waitFor(t, "the account usable", func() bool { return slices.Contains(a.snapshotAgents(t), kind) })
	chat := a.accountChat(t, kind, "", mounted)
	if reply := a.say(t, chat, "first"); !strings.Contains(reply, "FAKE(") {
		t.Fatalf("the first reply:\n%s", reply)
	}
	first, ok := a.lastChatExec(t, aliasDir, chat)
	session := argOf(first.argv, "--session-id")
	if !ok || session == "" {
		t.Fatalf("no exec of the chat with a session: %q", a.docker.CallsOf("exec"))
	}

	// (k) SIGTERM with a turn working in the container.
	a.must(t, testClient, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": "[[sleep 30]]"}, nil)
	var runID string
	a.waitFor(t, "the turn working, its run live", func() bool {
		e, _ := a.lastChatExec(t, aliasDir, chat)
		r, ok := a.runOf(e.env["AIWB_RUN"])
		runID = e.env["AIWB_RUN"]
		return a.chatView(t, chat).Status != model.StatusReady && ok && r.Live
	})
	if err := a.s.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case <-a.s.exited:
	case <-time.After(30 * time.Second):
		t.Fatalf("the server did not exit within 30 s of SIGTERM:\n%s", a.s.out.String())
	}
	if r, _ := a.runOf(runID); !slices.Contains(a.docker.Kills(), runID) || r.Live {
		t.Fatalf("after the stop: kills %q, the run %+v; want the run %s killed\n%s", a.docker.Kills(), r, runID, a.s.out.String())
	}
	if stops, rms := a.docker.CallsOf("stop"), a.docker.CallsOf("rm"); len(stops)+len(rms) != 0 {
		t.Fatalf("the stop of the server stopped or removed the container: %q %q", stops, rms)
	}
	if ctr, _ := a.docker.Container(name); ctr.State != "running" {
		t.Fatalf("the container after the server's stop: %+v, want it running", ctr)
	}

	// (g) A new server on the same data folder and Docker: the next message resumes the session in
	// the container that runs.
	creates, starts := len(a.docker.CallsOf("create")), len(a.docker.CallsOf("start"))
	a.start(t)
	a.waitFor(t, "the account usable after the restart", func() bool { return slices.Contains(a.snapshotAgents(t), kind) })
	if reply := a.say(t, chat, "second"); !strings.Contains(reply, "FAKE(") {
		t.Fatalf("the reply after the restart:\n%s\n%s", reply, a.s.out.String())
	}
	again, ok := a.lastChatExec(t, aliasDir, chat)
	if !ok || again.env["AIWB_RUN"] == runID || again.name != name || again.dir != mounted || argOf(again.argv, "--resume") != session {
		t.Fatalf("the exec after the restart %+v (found %v): want --resume %s in %s, in %s", again, ok, session, name, mounted)
	}
	if c, s := len(a.docker.CallsOf("create")), len(a.docker.CallsOf("start")); c != creates || s != starts || creates != 1 {
		t.Fatalf("after the restart: creates %d (was %d), starts %d (was %d); want the running container found", c, creates, s, starts)
	}
}

// Without Docker, or with a Docker that does not answer (j of the plan's stream G): the server
// starts without waiting on it, GET /api/aliases answers at once and says why within the quick
// limit, the account is not usable and a chat on it is refused at once with Docker's reason, and
// the computer's own Claude Code works as ever.
func TestAccountsWithoutDocker(t *testing.T) {
	smokeTest(t)
	for _, tc := range []struct {
		mode   string
		reason string // container.Unavailable's
	}{{"missing", "Docker is not installed"}, {"slow", "Docker is not running"}} {
		t.Run(tc.mode, func(t *testing.T) {
			t.Parallel()
			a := newAccountServer(t)
			if tc.mode == "missing" {
				a.instance.docker = filepath.Join(t.TempDir(), "no-docker")
			} else {
				a.docker.SetMode(containertest.ModeSlow) // every call sleeps 30 s
				a.instance.docker = a.docker.Bin
			}
			began := time.Now()
			a.s = startRetryServer(t, a.instance)
			if took := time.Since(began); took >= container.QuickTimeout {
				t.Fatalf("the server took %v to start, at least Docker's quick limit %v", took, container.QuickTimeout)
			}
			v := a.addAccount(t, "Work", realDir(t))
			var l aliases.List
			if took := timed(func() { l = a.aliasList(t) }); took > 2*time.Second || l.Docker.OK || l.Docker.Reason == "" {
				t.Fatalf("GET /api/aliases took %v and answered Docker %+v, want at once with a reason", took, l.Docker)
			}
			if got := a.snapshotAgents(t); slices.Contains(got, v.Kind) || !slices.Contains(got, model.Claude) {
				t.Fatalf("the agents %v: want claude without %s", got, v.Kind)
			}

			// A chat on the account is refused at once with Docker's reason (until the first look:
			// that it has not been looked at yet); nothing ran in Docker.
			var status int
			var body string
			if took := timed(func() {
				status, body = a.call(t, testClient, "POST", "/api/chats", map[string]any{"agent": v.Kind, "group": model.Ungrouped}, nil)
			}); took > 2*time.Second {
				t.Fatalf("the refusal took %v", took)
			}
			var r refusal
			json.Unmarshal([]byte(body), &r)
			if status != http.StatusConflict || r.Code != aliases.CodeDocker || (r.Error != tc.reason && r.Error != notLookedAt) {
				t.Fatalf("a chat on the account: %d %s, want 409 %s %q", status, body, aliases.CodeDocker, tc.reason)
			}
			if n := len(a.docker.CallsOf("exec")) + len(a.docker.CallsOf("create")); n != 0 {
				t.Fatalf("docker create or exec was called %d times", n)
			}

			// The computer's own Claude Code works.
			if reply := a.say(t, retryChat(t, a.instance), "hello"); !strings.Contains(reply, "FAKE(") {
				t.Fatalf("the reply of a Claude Code chat:\n%s", reply)
			}

			// Docker's reason is known within its quick limit of the start (generous for a loaded
			// machine), and it is the account's.
			for l.Docker.Reason != tc.reason {
				if since := time.Since(began); since > container.QuickTimeout+3*time.Second {
					t.Fatalf("%v after the start Docker is %+v, want %q", since, l.Docker, tc.reason)
				}
				time.Sleep(50 * time.Millisecond)
				l = a.aliasList(t)
			}
			t.Logf("%q %v after the start", tc.reason, time.Since(began).Round(time.Millisecond))
			if got := a.view(t, v.ID); got.Container.State != aliases.ContainerUnavailable || got.Container.Reason != tc.reason {
				t.Fatalf("the account %+v, want its container %s with %q", got, aliases.ContainerUnavailable, tc.reason)
			}
		})
	}
}
