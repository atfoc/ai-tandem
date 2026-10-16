// ai-whiteboard: a server that keeps Excalidraw boards and chats with coding agents (Claude
// Code, Cursor, pi) that read and edit them. It serves no page: the desktop app is its client,
// over HTTPS with a secret, on this machine as on any other.
//
// Commands:
//
//	ai-whiteboard [serve] [flags]  run the server in the foreground (refuses when not set up)
//	ai-whiteboard launch [flags] [-json]    start the server in the background if needed; print its
//	                               address and certificate fingerprint, exit
//	ai-whiteboard relaunch [flags] [-json]  stop the running server if any, then launch
//	ai-whiteboard stop [-home DIR] stop the running server
//	ai-whiteboard status [-home DIR] [-json]  what the running server serves, and what the next
//	                               start will do
//	ai-whiteboard remote setup [-port N] [-name X]... [-new-cert]
//	                               set up access for clients (HTTPS with a secret); makes what is
//	                               missing. A server that was never set up does not start.
//	ai-whiteboard secret [-new]    print the secret, or replace it and print the new one
//
// The remote, secret, status and stop commands take their own flags after the command, and -home <dir>.
//
// The program never opens a browser or a window: the Electron app is the client.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/app"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/cursor"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/headless"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/pi"
	"ai-whiteboard/internal/pibridge"
	"ai-whiteboard/internal/prompts"
	"ai-whiteboard/internal/server"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/usable"
)

// options are the flags every command takes.
type options struct {
	home, cwd            string
	claudeBin, cursorBin string
	cursorCostBin        string
	piBin, piNamerModel  string
	// headlessNode, headlessDir and headlessQuiet are the headless writer's: the program that runs
	// it, the folder of its bundle ("" for each: look for it, architecture D33, D34) and how long it
	// keeps a board after an agent's last call on it (D26).
	headlessNode, headlessDir string
	headlessQuiet             time.Duration
	json                      bool // launch and relaunch: write one JSON line for the app
	paths                     store.Paths
	// serveArgs are the flags the server that launch starts gets: the data folder, and every flag
	// that was given, as it was.
	serveArgs []string
}

func main() {
	cmd, args := command(os.Args[1:])
	if code, ok := ownCommand(cmd, args, os.Stdout, os.Stderr); ok {
		os.Exit(code)
	}
	switch cmd {
	case "serve", "launch", "relaunch":
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q (serve, launch, relaunch, stop, status, remote, secret)\n", cmd)
		os.Exit(2)
	}
	o := parseFlags(cmd, args)
	switch cmd {
	case "serve":
		serve(o)
	case "launch":
		os.Exit(launch(o, os.Stdout, os.Stderr))
	case "relaunch":
		os.Exit(relaunch(o, os.Stdout, os.Stderr))
	}
}

// command splits the arguments into a command and its flags. With no command it is serve.
func command(args []string) (string, []string) {
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		return args[0], args[1:]
	}
	return "serve", args
}

func parseFlags(cmd string, args []string) options {
	here, _ := os.Getwd()
	var o options
	fs := flag.NewFlagSet("ai-whiteboard "+cmd, flag.ExitOnError)
	fs.StringVar(&o.home, "home", "~/.ai-whiteboard", "data folder")
	fs.StringVar(&o.cwd, "cwd", here, "default working folder for new chats")
	fs.StringVar(&o.claudeBin, "claude", "claude", "Claude Code binary")
	fs.StringVar(&o.cursorBin, "cursor", "agent", "Cursor agent binary")
	fs.StringVar(&o.cursorCostBin, "cursor-cost", "cursor-cost", "cursor-cost binary, for the Cursor plan's usage (~/bin is tried too)")
	fs.StringVar(&o.piBin, "pi", "pi", "pi binary")
	fs.StringVar(&o.piNamerModel, "pi-namer-model", "", "pi model for chat titles (empty = pi's default)")
	fs.StringVar(&o.headlessNode, "headless-node", "", "program that runs the headless writer, which edits boards while no window is open (empty = the desktop app's Electron, else node 22+ on PATH; or AIWB_HEADLESS_NODE)")
	fs.StringVar(&o.headlessDir, "headless-dir", "", "folder of the headless writer's bundle (empty = headless/ beside the server, or Resources/headless of the Mac app)")
	fs.DurationVar(&o.headlessQuiet, "headless-quiet", headless.QuietDefault, "how long the headless writer keeps a board after an agent's last call on it")
	if cmd != "serve" {
		fs.BoolVar(&o.json, "json", false, "write one JSON line for the app")
	}
	fs.Parse(args)
	if o.headlessQuiet <= 0 {
		fmt.Fprintf(os.Stderr, "-headless-quiet %v: the time must be above 0\n", o.headlessQuiet)
		os.Exit(2)
	}

	home, _ := os.UserHomeDir()
	root, err := filepath.Abs(expand(o.home, home))
	if err != nil {
		log.Fatalf("data folder: %v", err)
	}
	o.paths = store.NewPaths(root)
	o.serveArgs = []string{"-home", root}
	fs.Visit(func(f *flag.Flag) {
		if f.Name != "home" && f.Name != "json" {
			o.serveArgs = append(o.serveArgs, "-"+f.Name+"="+f.Value.String())
		}
	})
	return o
}

// serve runs the server in the foreground until SIGINT or SIGTERM.
func serve(o options) {
	home, _ := os.UserHomeDir()
	p := o.paths

	if run, ok := findRunning(p); ok {
		fmt.Printf("AI Whiteboard is already running (pid %d)\n", run.hello.Pid)
		return
	}
	rem := checkRemote(o)
	// The server list of an earlier version is deleted before any listener: a server keeps none,
	// and the secrets in it are the app's now.
	if removed, err := store.RemoveServerList(p); err != nil {
		log.Printf("the server list of an earlier version could not be removed: %v", err)
	} else if removed {
		log.Printf("the server list of an earlier version is removed from %s: servers are added in the app", p.Root)
	}

	// The MCP listener is bound here, before server.json is written: a 6006 conflict is fatal
	// and must not leave a server.json behind (plan D11).
	wantMCPPort := mcpPort()
	mcpLn, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", wantMCPPort))
	if err != nil {
		log.Fatalf("%s", mcpListenError(wantMCPPort, err))
	}
	mcpBoundPort := mcpLn.Addr().(*net.TCPAddr).Port
	rem.bind()
	port := rem.rep.Config.Port

	st, err := store.Open(p)
	if err != nil {
		log.Fatalf("data folder %s: %v", p.Root, err)
	}
	var a *app.App
	var cm *chats.Manager
	br := editorbridge.New()
	waits := readTestWaits() // zero outside the tests
	br.PingEvery = waits.ping
	if waits.hov > 0 {
		br.SetHandoverDelay(waits.hov)
	}
	bs := boards.New(st, br)
	br.SceneRev = bs.Rev
	bins := map[model.AgentKind]string{model.Claude: o.claudeBin, model.Cursor: o.cursorBin, model.Pi: o.piBin}
	agents := usable.New(bins) // the agents whose programs are found; looked up again every usable.Every
	base := fmt.Sprintf("https://127.0.0.1:%d", port)
	cursorSpawner := &cursor.Spawner{Bin: o.cursorBin, AppRoot: p.Root, Home: home}
	claudeSpawner := &claude.Spawner{Bin: o.claudeBin, AppRoot: p.Root, Home: home, Prompt: prompts.Claude()}
	probePiVersion(o.piBin)
	piSpawner := &pi.Spawner{Bin: o.piBin, AppRoot: p.Root, Home: home, Prompt: prompts.Pi()}
	turnCaps()
	cm = chats.New(chats.Deps{Store: st, Bridge: br, Boards: bs, DefaultCwd: o.cwd, Agents: agents,
		MCPURL: boardapi.Endpoint(mcpBoundPort), ImageWait: waits.images,
		Namers: map[model.AgentKind]chats.Namer{
			model.Claude: chats.ClaudeNamer{Bin: o.claudeBin},
			model.Cursor: chats.ClaudeNamer{Bin: o.claudeBin},
			model.Pi:     chats.PiNamer{Bin: o.piBin, Model: o.piNamerModel},
		},
		Spawners: map[model.AgentKind]agent.Spawner{
			model.Claude: claudeSpawner,
			model.Cursor: cursorSpawner,
			model.Pi:     piSpawner,
		}})
	if err := bs.Load(); err != nil { // before chats: board chats look up their board
		log.Fatalf("loading boards: %v", err)
	}
	if err := cm.Load(); err != nil {
		log.Fatalf("loading chats: %v", err)
	}
	// The cleanup of the images nobody uses any more: of what was left before this start, and
	// then every few minutes. Never stopped: it ends with cm.Shutdown.
	go cm.CleanImages(nil)
	relay := &boardapi.Relay{Bridge: br, Chats: cm, Boards: bs}
	extPath, err := pibridge.MaterializeExtension(filepath.Join(p.Root, "pi-extension"))
	if err != nil {
		log.Printf("pi extension: %v", err) // pi chats run without board tools
		extPath = ""
	}
	pb := pibridge.New(pibridge.SocketPath(p.Root))
	if err := pb.Start(); err != nil {
		log.Fatalf("pi bridge: %v", err)
	}
	piSpawner.Extension = extPath
	piSpawner.Bridge = pb
	go refreshCursorCatalog(cursorSpawner, st, br)
	go refreshPiCatalog(piSpawner, st, br)
	go refreshClaudeCatalog(claudeSpawner, st, br)
	// Never stopped: the server ends by exiting.
	go agents.Watch(waits.agentsEvery(), nil, func(l []model.AgentKind) { br.Broadcast(map[string]any{"type": "agents", "agents": l}) })
	a = &app.App{St: st, Boards: bs, Chats: cm, Bridge: br, Agents: agents, Home: home, DefaultCwd: o.cwd, DataDir: p.Root}
	// The change-overs of a server from before: nothing of another server is kept, and the group
	// "Remote" of before level 5 goes, before any request.
	localOnly(p, cm, a)
	if err := a.DropRemoteGroup(); err != nil {
		log.Printf("the group \"Remote\" of before could not be removed, the next start tries again: %v", err)
	}
	// The prompt library of this server: a file that cannot be read was set aside by the open,
	// which logged it, and the library starts empty.
	if err := a.OpenLibrary(p.Root); err != nil {
		log.Printf("prompt library: %v", err) // the clients show no library
	}
	if err := cursor.EnsureDenyRules(p.Root); err != nil {
		log.Printf("cursor deny rules: %v", err)
	}
	var mcpUp atomic.Bool // read by the control socket's /status
	srv := &server.Server{App: a, Relay: relay, Bridge: br,
		Usage: map[model.AgentKind]func(bool) (model.PlanUsage, error){
			model.Claude: (&agent.UsageCache{Fetch: claudeSpawner.Usage, TTL: time.Minute}).Get,
			model.Cursor: (&agent.UsageCache{Fetch: (&cursor.CostReader{Bin: o.cursorCostBin, Home: home}).Usage, TTL: time.Minute}).Get,
		},
		MCPPort: mcpBoundPort, MCPURL: boardapi.Endpoint(mcpBoundPort), MCPUp: mcpUp.Load}
	// The headless writer, for the board calls no window answers: nothing is looked up or started
	// until the first of them. It connects as a client, so it needs the instance id and the secret
	// that attach gives the server, and the relay has it before the MCP listener serves a call.
	rem.attach(srv)
	hm := headless.New(br, headless.Listener{Port: port, Fingerprint: rem.rep.Fingerprint,
		Secret: rem.currentSecret, InstanceID: srv.InstanceID}, waits.headlessOptions(o))
	relay.Away = hm
	mcpHandler := srv.MCPHandler(mcpBoundPort)
	mcpUp.Store(true)
	go func() {
		if err := http.Serve(mcpLn, mcpHandler); err != nil && err != http.ErrServerClosed {
			log.Printf("MCP listener: %v", err)
			mcpUp.Store(false)
		}
	}()
	ctl, controlPath, err := bindControl(p.Root)
	if errors.Is(err, errControlAnswers) {
		fmt.Printf("AI Whiteboard is already running (its control socket %s answers)\n", controlPath)
		return
	} else if err != nil {
		log.Fatalf("control socket: %v", err)
	}
	if err := store.WriteServerFile(p, port, controlPath); err != nil {
		log.Printf("server.json: %v", err)
	}
	go func() {
		if err := http.Serve(ctl, withHeadlessStatus(srv.ControlHandler(p.Root), hm)); err != nil && !errors.Is(err, net.ErrClosed) {
			log.Printf("control socket: %v", err)
		}
	}()
	go onSignal(func() {
		br.StopAndFlush(2 * time.Second) // the clients write pending board changes, the headless writer's too
		hm.Close()                       // then it ends
		cm.Shutdown()                    // history written; agents end
		agent.EndAll(2 * time.Second)    // agents still running, and whatever they started
		pb.Close()                       // the extension bridge: no more connections, socket removed
		store.RemoveServerFile(p)
		ctl.Close() // removes the socket file; the control socket answers until here
		store.RemoveControlSocket(controlPath)
		os.Exit(0)
	}, syscall.SIGINT, syscall.SIGTERM)

	log.Printf("AI Whiteboard: %s  (data in %s)", base, p.Root)
	log.Printf("MCP endpoint: %s", boardapi.Endpoint(mcpBoundPort))
	err = rem.serve(srv)
	store.RemoveServerFile(p)
	ctl.Close()
	store.RemoveControlSocket(controlPath)
	log.Fatal(err)
}

// errControlAnswers is bindControl's refusal when the control socket answers: another server runs.
var errControlAnswers = errors.New("the control socket answers")

// bindControl binds the control socket in the data folder, mode 0600: the Unix socket that only
// the user of this machine can open and that the server program's commands ask. A socket file
// that is there and answers nobody is the leftover of a server that died, and is replaced; one
// that answers is another running server.
func bindControl(root string) (net.Listener, string, error) {
	path := store.ControlSocketPath(root)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, path, err
	}
	ln, err := net.Listen("unix", path)
	if errors.Is(err, syscall.EADDRINUSE) {
		if c, derr := net.DialTimeout("unix", path, time.Second); derr == nil {
			c.Close()
			return nil, path, errControlAnswers
		}
		if err := os.Remove(path); err != nil {
			return nil, path, err
		}
		ln, err = net.Listen("unix", path)
	}
	if err == nil {
		if err = os.Chmod(path, 0o600); err != nil {
			ln.Close()
		}
	}
	if err != nil {
		store.RemoveControlFolder(path) // a fallback folder made for nothing; a file in it keeps it
		return nil, path, err
	}
	return ln, path, nil
}

// mcpPort returns the MCP listener port: the fixed production port, or the hidden test-only
// AIWB_MCP_PORT override. It is deliberately not a flag: changing the port would break Cursor's
// exact-URL allowlist (plan D10). Port 0 asks the OS for an ephemeral port.
func mcpPort() int {
	v := strings.TrimSpace(os.Getenv("AIWB_MCP_PORT"))
	if v == "" {
		return boardapi.MCPPort
	}
	p, err := strconv.Atoi(v)
	if err != nil || p < 0 || p > 65535 {
		log.Fatalf("AIWB_MCP_PORT %q is not a valid port (0-65535)", v)
	}
	return p
}

// turnCaps applies the hidden test-only overrides of the cap on running turns and returns the caps
// in force: AIWB_CHAT_CAP for the branches of one chat that may work at once (4), AIWB_APP_CAP
// for those of all chats (12). Each is a positive integer; unset or anything else keeps the cap.
// They are read once, before the chats are loaded. An end-to-end test reaches a cap of one with
// two turns.
func turnCaps() (perChat, overall int) {
	return chats.SetCaps(os.Getenv("AIWB_CHAT_CAP"), os.Getenv("AIWB_APP_CAP"))
}

// mcpListenError is the fail-fast message when the MCP listener cannot bind (plan D11): it names
// the effective port, the likely holder and the remedy.
func mcpListenError(port int, err error) string {
	return fmt.Sprintf(
		"cannot serve the MCP endpoint on port %d: %v\n"+
			"Port %d is probably held by another AI Whiteboard instance (for a different data folder) or by another program.\n"+
			"Stop that instance or free port %d, then start AI Whiteboard again.",
		port, err, port, port)
}

// expand turns a leading "~" into the user's home folder.
func expand(path, home string) string {
	if path == "~" {
		return home
	}
	if strings.HasPrefix(path, "~/") {
		return filepath.Join(home, path[2:])
	}
	return path
}

// onSignal runs f once the first of sigs arrives.
func onSignal(f func(), sigs ...os.Signal) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, sigs...)
	<-ch
	f()
}

// probePiVersion logs the pi binary and version at boot. It never fails startup: a missing or
// broken pi only means pi chats show an error per chat until pi is installed and authenticated.
func probePiVersion(bin string) {
	path, err := exec.LookPath(bin)
	if err != nil {
		log.Printf("pi: cannot find %q: pi chats will show an error until pi is installed and authenticated", bin)
		return
	}
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.WaitDelay = 5 * time.Second // a child that leaks its pipes must not keep Output waiting past the bound
	out, err := cmd.Output()
	if err != nil {
		log.Printf("pi: %s at %s did not answer --version (%v): pi chats will show an error until pi is installed and authenticated", bin, path, err)
		return
	}
	version := strings.TrimSpace(string(out))
	if version == "" {
		version = "unknown version"
	}
	log.Printf("pi %s at %s", version, path)
}

// refreshCursorCatalog fetches Cursor's model list for the pickers (spec 4.6). On failure the
// stored catalog stays.
func refreshCursorCatalog(sp *cursor.Spawner, st *store.Store, br *editorbridge.Bridge) {
	cat, err := sp.Catalog(20 * time.Second)
	if err != nil {
		log.Printf("cursor model list: %v", err)
		return
	}
	if err := st.Update(func(s *model.State) error { s.SetCatalog(model.Cursor, cat); return nil }); err != nil {
		log.Printf("cursor model list: saving: %v", err)
	}
	br.Broadcast(map[string]any{"type": "catalog", "agent": string(model.Cursor), "catalog": cat})
}

// refreshPiCatalog fetches pi's model list for the pickers, like refreshCursorCatalog. On failure
// the stored catalog stays.
func refreshPiCatalog(sp *pi.Spawner, st *store.Store, br *editorbridge.Bridge) {
	cat, err := sp.Catalog(20 * time.Second)
	if err != nil {
		log.Printf("pi model list: %v", err)
		return
	}
	if err := st.Update(func(s *model.State) error { s.SetCatalog(model.Pi, cat); return nil }); err != nil {
		log.Printf("pi model list: saving: %v", err)
	}
	br.Broadcast(map[string]any{"type": "catalog", "agent": string(model.Pi), "catalog": cat})
}

// refreshClaudeCatalog fetches Claude's model list for the pickers, like refreshCursorCatalog. On
// failure the stored catalog stays.
func refreshClaudeCatalog(sp *claude.Spawner, st *store.Store, br *editorbridge.Bridge) {
	cat, err := sp.Catalog(20 * time.Second)
	if err != nil {
		log.Printf("claude model list: %v", err)
		return
	}
	if err := st.Update(func(s *model.State) error { s.SetCatalog(model.Claude, cat); return nil }); err != nil {
		log.Printf("claude model list: saving: %v", err)
	}
	br.Broadcast(map[string]any{"type": "catalog", "agent": string(model.Claude), "catalog": cat})
}

// localOnly makes the data folder hold nothing of another server, as it is after the first start of
// a version that keeps no record of a chat or a board of another server. The folder remote/ goes
// with everything in it. A chat that never had a message and was kept here for another server
// becomes a chat of this server with its draft; one on a board that is not this server's has
// nowhere to be and is deleted. The defaults of state.json were brought to this server's alone
// when the store opened. It runs at every start, before a request is served, and does nothing
// when there is nothing of the kind; what fails is logged and tried at the next start.
func localOnly(p store.Paths, cm *chats.Manager, a *app.App) {
	if removed, err := store.RemoveRemote(p); err != nil {
		log.Printf("the records of other servers' chats: %v", err)
	} else if removed {
		log.Printf("the records of other servers' chats and boards are removed from %s: they show in their servers' sections", p.Root)
	}
	boardHere := func(string) bool { return false }
	if a.Boards != nil {
		boardHere = func(id string) bool { _, ok := a.Boards.Get(id); return ok }
	}
	local, deleted, err := cm.LocalOnly(boardHere)
	if err != nil {
		log.Printf("chats that were kept for another server: %v", err)
	}
	for _, id := range local {
		log.Printf("the chat %s, which had no message yet, is a chat of this server now", id)
	}
	for _, id := range deleted {
		log.Printf("the chat %s, which had no message yet, is deleted: its board is not on this server", id)
	}
}
