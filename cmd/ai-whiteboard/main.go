// ai-whiteboard: a local server that keeps Excalidraw boards and chats with coding agents
// (Claude Code, Cursor) that read and edit them. The web client is a separate program; the
// server serves its built folder for convenience.
//
// Commands:
//
//	ai-whiteboard [serve] [flags]  run the server in the foreground (or print the running one's URL)
//	ai-whiteboard launch [flags]   start the server in the background if needed, print its URL, exit
//	ai-whiteboard relaunch [flags] stop the running server if any, then launch; prints the URL
//	ai-whiteboard stop [flags]     stop the running server
//	ai-whiteboard remote setup [-port N] [-name X]... [-server-port N] [-new-cert]
//	                               set up remote access (HTTPS with a secret); makes what is missing
//	ai-whiteboard remote status [-server-port N]
//	                               what a running server serves and what the next start will do
//	ai-whiteboard remote off       turn remote access off at the next start; keeps secret and certificate
//	ai-whiteboard secret [-new]    print the secret of remote access, or replace it and print the new one
//
// The remote and secret commands take their own flags after the sub-command, and -home <dir>.
//
// The program never opens a browser or a window: the Electron app does that. To use a browser tab,
// run launch (or serve) and open the printed URL.
package main

import (
	"context"
	"encoding/json"
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
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/pi"
	"ai-whiteboard/internal/pibridge"
	"ai-whiteboard/internal/prompts"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/server"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/usable"
)

// The chat manager is the runs' chat host.
var _ runs.ChatHost = (*chats.Manager)(nil)

// options are the flags every command takes.
type options struct {
	port                 int
	home, client, cwd    string
	claudeBin, cursorBin string
	cursorCostBin        string
	piBin, piNamerModel  string
	paths                store.Paths
}

func main() {
	cmd, args := command(os.Args[1:])
	if code, ok := ownCommand(cmd, args, os.Stdout, os.Stderr); ok {
		os.Exit(code)
	}
	o := parseFlags(cmd, args)
	switch cmd {
	case "serve":
		serve(o, args)
	case "launch":
		launch(o, args, os.Stdout)
	case "relaunch":
		relaunch(o, args, os.Stdout)
	case "stop":
		stop(o)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q (serve, launch, relaunch, stop, remote, secret)\n", cmd)
		os.Exit(2)
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
	client := "web/dist"
	if res := bundleResources(); res != "" {
		client = filepath.Join(res, "web")
	}
	var o options
	fs := flag.NewFlagSet("ai-whiteboard "+cmd, flag.ExitOnError)
	fs.IntVar(&o.port, "port", 4747, "listen port")
	fs.StringVar(&o.home, "home", "~/.ai-whiteboard", "data folder")
	fs.StringVar(&o.client, "client", client, `built web client to serve ("" = serve none)`)
	fs.StringVar(&o.cwd, "cwd", here, "default working folder for new chats")
	fs.StringVar(&o.claudeBin, "claude", "claude", "Claude Code binary")
	fs.StringVar(&o.cursorBin, "cursor", "agent", "Cursor agent binary")
	fs.StringVar(&o.cursorCostBin, "cursor-cost", "cursor-cost", "cursor-cost binary, for the Cursor plan's usage (~/bin is tried too)")
	fs.StringVar(&o.piBin, "pi", "pi", "pi binary")
	fs.StringVar(&o.piNamerModel, "pi-namer-model", "", "pi model for chat titles (empty = pi's default)")
	fs.Parse(args)

	home, _ := os.UserHomeDir()
	root, err := filepath.Abs(expand(o.home, home))
	if err != nil {
		log.Fatalf("data folder: %v", err)
	}
	o.paths = store.NewPaths(root)
	return o
}

// serve runs the server in the foreground until SIGINT or SIGTERM. args are its flags, which
// POST /api/restart passes on to relaunch.
func serve(o options, args []string) {
	home, _ := os.UserHomeDir()
	p := o.paths

	if url, ok := findRunning(p, o.port); ok {
		fmt.Println("AI Whiteboard is already running at", url)
		return
	}
	rem := checkRemote(o)

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", o.port))
	if err != nil {
		log.Fatalf("cannot listen on port %d (port in use by another program?): %v", o.port, err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	// The MCP listener is bound here, before server.json is written: a 6006 conflict is fatal
	// and must not leave a server.json behind (plan D11).
	wantMCPPort := mcpPort()
	mcpLn, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", wantMCPPort))
	if err != nil {
		log.Fatalf("%s", mcpListenError(wantMCPPort, err))
	}
	mcpBoundPort := mcpLn.Addr().(*net.TCPAddr).Port
	rem.bind()

	st, err := store.Open(p)
	if err != nil {
		log.Fatalf("data folder %s: %v", p.Root, err)
	}
	var a *app.App
	var cm *chats.Manager
	br := editorbridge.New(func() any { return a.Snapshot() })
	waits := readTestWaits() // zero outside the tests
	br.PingEvery = waits.ping
	bs := boards.New(st, br)
	br.SceneRev = bs.Rev
	bins := map[model.AgentKind]string{model.Claude: o.claudeBin, model.Cursor: o.cursorBin, model.Pi: o.piBin}
	agents := usable.New(bins) // the agents whose programs are found; looked up again every usable.Every
	rs := runs.New(runs.Deps{Store: st, Emit: br, DefaultCwd: o.cwd, Clock: runs.RealClock{},
		Bins: bins, Agents: agents,
		Mark: func(run, client string) { br.SetMark(editorbridge.Run(run), client) }})
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	cursorSpawner := &cursor.Spawner{Bin: o.cursorBin, AppRoot: p.Root, Home: home}
	claudeSpawner := &claude.Spawner{Bin: o.claudeBin, AppRoot: p.Root, Home: home, Prompt: prompts.Claude()}
	probePiVersion(o.piBin)
	piSpawner := &pi.Spawner{Bin: o.piBin, AppRoot: p.Root, Home: home, Prompt: prompts.Pi()}
	turnCaps()
	cm = chats.New(chats.Deps{Store: st, Bridge: br, Boards: bs, Runs: rs, DefaultCwd: o.cwd, Agents: agents,
		MCPURL: boardapi.Endpoint(mcpBoundPort),
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
	if err := rs.Load(); err != nil { // before chats: a run's chats look up their run
		log.Fatalf("loading runs: %v", err)
	}
	if err := cm.Load(); err != nil {
		log.Fatalf("loading chats: %v", err)
	}
	rs.Chats = cm
	relay := &boardapi.Relay{Bridge: br, Chats: cm, Boards: bs, Runs: rs}
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
	a = &app.App{St: st, Boards: bs, Chats: cm, Runs: rs, Bridge: br, Agents: agents, Home: home, DefaultCwd: o.cwd, DataDir: p.Root}
	if err := cursor.EnsureDenyRules(p.Root); err != nil {
		log.Printf("cursor deny rules: %v", err)
	}
	var mcpUp atomic.Bool // read by GET /api/mcp/status
	srv := &server.Server{App: a, Relay: relay, Bridge: br,
		Client: o.client, Port: port, Usage: map[model.AgentKind]func(bool) (model.PlanUsage, error){
			model.Claude: (&agent.UsageCache{Fetch: claudeSpawner.Usage, TTL: time.Minute}).Get,
			model.Cursor: (&agent.UsageCache{Fetch: (&cursor.CostReader{Bin: o.cursorCostBin, Home: home}).Usage, TTL: time.Minute}).Get,
		},
		MCPPort: mcpBoundPort, MCPURL: boardapi.Endpoint(mcpBoundPort), MCPUp: mcpUp.Load,
		Restart: func() error { return startRelaunch(p, args) }}
	mcpHandler := srv.MCPHandler(mcpBoundPort)
	stopServers := startServers(p, br, cm, a, srv, waits)
	mcpUp.Store(true)
	go func() {
		if err := http.Serve(mcpLn, mcpHandler); err != nil && err != http.ErrServerClosed {
			log.Printf("MCP listener: %v", err)
			mcpUp.Store(false)
		}
	}()
	rem.attach(srv)
	if err := store.WriteServerFile(p, port); err != nil {
		log.Printf("server.json: %v", err)
	}
	go onSignal(func() {
		rs.Shutdown(2 * time.Second)     // runs halt (they continue at the next start); no agent, task or turn starts from here on
		br.StopAndFlush(2 * time.Second) // the client writes pending board changes
		cm.Shutdown()                    // history written; agents end
		stopServers()                    // the connections to other servers end; what is kept of their chats is written
		agent.EndAll(2 * time.Second)    // agents still running, and whatever they started
		pb.Close()                       // the extension bridge: no more connections, socket removed
		store.RemoveServerFile(p)
		os.Exit(0)
	}, syscall.SIGINT, syscall.SIGTERM)

	log.Printf("AI Whiteboard: %s  (data in %s)", base, p.Root)
	log.Printf("MCP endpoint: %s", boardapi.Endpoint(mcpBoundPort))
	// Last, with the MCP endpoint up and before the first request is served: runs a dead server
	// left are halted, and runs an orderly stop halted continue (their agents call the run tools
	// at once).
	rs.Boot()
	log.Fatal(http.Serve(ln, srv.Handler()))
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

// findRunning looks for an AI Whiteboard server already running for this data folder: the port in
// server.json first, then the -port flag. A port counts only when GET /api/hello answers within 1 s
// with app == "ai-whiteboard", so a stale server.json or another program on the port is ignored.
func findRunning(p store.Paths, port int) (string, bool) {
	var ports []int
	if _, sp, ok := store.ReadServerFile(p); ok {
		ports = append(ports, sp)
	}
	if port > 0 && (len(ports) == 0 || ports[0] != port) {
		ports = append(ports, port)
	}
	c := httpClient()
	for _, pt := range ports {
		base := fmt.Sprintf("http://127.0.0.1:%d", pt)
		if isOurs(c, base) {
			return base + "/", true
		}
	}
	return "", false
}

// httpClient is for asking a local server /api/hello: it must answer within 1 s.
func httpClient() *http.Client { return &http.Client{Timeout: time.Second} }

func isOurs(c *http.Client, base string) bool {
	_, ok := helloOf(c, base)
	return ok
}

// helloReply is a server's answer to GET /api/hello.
type helloReply struct {
	App     string `json:"app"`
	Version string `json:"version"`
	Pid     int    `json:"pid"`
	// FeatureLevel is 0 for a build that reports none; from level 1 on a running server reads its
	// secret again when it is sent SIGUSR1.
	FeatureLevel int    `json:"featureLevel"`
	InstanceID   string `json:"instanceId"`
}

// helloOf asks base for /api/hello; ok only when an AI Whiteboard server answers.
func helloOf(c *http.Client, base string) (helloReply, bool) {
	var h helloReply
	resp, err := c.Get(base + "/api/hello")
	if err != nil {
		return h, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return h, false
	}
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil {
		return h, false
	}
	return h, h.App == "ai-whiteboard"
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
