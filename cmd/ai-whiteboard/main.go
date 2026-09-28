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
//
// The program never opens a browser or a window: the Electron app does that. To use a browser tab,
// run launch (or serve) and open the printed URL.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
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
	"ai-whiteboard/internal/prompts"
	"ai-whiteboard/internal/server"
	"ai-whiteboard/internal/store"
)

// options are the flags every command takes.
type options struct {
	port                 int
	home, client, cwd    string
	claudeBin, cursorBin string
	cursorCostBin        string
	paths                store.Paths
}

func main() {
	cmd, args := command(os.Args[1:])
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
		fmt.Fprintf(os.Stderr, "unknown command %q (serve, launch, relaunch, stop)\n", cmd)
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

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", o.port))
	if err != nil {
		log.Fatalf("cannot listen on port %d (port in use by another program?): %v", o.port, err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	st, err := store.Open(p)
	if err != nil {
		log.Fatalf("data folder %s: %v", p.Root, err)
	}
	var a *app.App
	br := editorbridge.New(func() any { return a.Snapshot() })
	bs := boards.New(st, br)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	cursorSpawner := &cursor.Spawner{Bin: o.cursorBin, AppRoot: p.Root, Home: home}
	claudeSpawner := &claude.Spawner{Bin: o.claudeBin, AppRoot: p.Root, Home: home, Prompt: prompts.Claude()}
	cm := chats.New(chats.Deps{Store: st, Bridge: br, Boards: bs, DefaultCwd: o.cwd, BaseURL: base,
		Namer: chats.ClaudeNamer{Bin: o.claudeBin},
		Spawners: map[model.AgentKind]agent.Spawner{
			model.Claude: claudeSpawner,
			model.Cursor: cursorSpawner,
		}})
	if err := bs.Load(); err != nil { // before chats: board chats look up their board
		log.Fatalf("loading boards: %v", err)
	}
	if err := cm.Load(); err != nil {
		log.Fatalf("loading chats: %v", err)
	}
	go refreshCursorCatalog(cursorSpawner, st, br)
	a = &app.App{St: st, Boards: bs, Chats: cm, Bridge: br, Home: home, DefaultCwd: o.cwd, DataDir: p.Root}
	if err := cursor.EnsureDenyRules(p.Root); err != nil {
		log.Printf("cursor deny rules: %v", err)
	}
	srv := &server.Server{App: a, Relay: &boardapi.Relay{Bridge: br, Chats: cm, Boards: bs}, Bridge: br,
		Client: o.client, Port: port, Usage: map[model.AgentKind]func(bool) (model.PlanUsage, error){
			model.Claude: (&agent.UsageCache{Fetch: claudeSpawner.Usage, TTL: time.Minute}).Get,
			model.Cursor: (&agent.UsageCache{Fetch: (&cursor.CostReader{Bin: o.cursorCostBin, Home: home}).Usage, TTL: time.Minute}).Get,
		},
		Restart: func() error { return startRelaunch(p, args) }}
	if err := store.WriteServerFile(p, port); err != nil {
		log.Printf("server.json: %v", err)
	}
	go onSignal(func() {
		br.StopAndFlush(2 * time.Second) // the client writes pending board changes
		cm.Shutdown()                    // history written; agents end
		agent.EndAll(2 * time.Second)    // agents still running, and whatever they started
		store.RemoveServerFile(p)
		os.Exit(0)
	}, syscall.SIGINT, syscall.SIGTERM)

	log.Printf("AI Whiteboard: %s  (data in %s)", base, p.Root)
	log.Fatal(http.Serve(ln, srv.Handler()))
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

// refreshCursorCatalog fetches Cursor's model list for the pickers (spec 4.6). On failure the
// stored catalog stays.
func refreshCursorCatalog(sp *cursor.Spawner, st *store.Store, br *editorbridge.Bridge) {
	cat, err := sp.Catalog(20 * time.Second)
	if err != nil {
		log.Printf("cursor model list: %v", err)
		return
	}
	if err := st.Update(func(s *model.State) error { s.Cursor = cat; return nil }); err != nil {
		log.Printf("cursor model list: saving: %v", err)
	}
	br.Broadcast(map[string]any{"type": "catalog", "agent": string(model.Cursor), "catalog": cat})
}
