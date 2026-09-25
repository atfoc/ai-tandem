// ai-whiteboard: a local server that keeps Excalidraw boards and chats with coding agents
// (Claude Code, Cursor) that read and edit them. The web client is a separate program; the
// server serves its built folder for convenience.
package main

import (
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

func main() {
	here, _ := os.Getwd()
	portFlag := flag.Int("port", 4747, "listen port")
	homeFlag := flag.String("home", "~/.ai-whiteboard", "data folder")
	client := flag.String("client", "web/dist", `built web client to serve ("" = serve none)`)
	noOpen := flag.Bool("no-open", false, "don't open the browser")
	cwd := flag.String("cwd", here, "default working folder for new chats")
	claudeBin := flag.String("claude", "claude", "Claude Code binary")
	cursorBin := flag.String("cursor", "agent", "Cursor agent binary")
	flag.Parse()

	home, _ := os.UserHomeDir()
	root, err := filepath.Abs(expand(*homeFlag, home))
	if err != nil {
		log.Fatalf("data folder: %v", err)
	}
	p := store.NewPaths(root)

	if url, ok := findRunning(p, *portFlag); ok {
		fmt.Println("AI Whiteboard is already running at", url)
		if !*noOpen {
			openBrowser(url)
		}
		return
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *portFlag))
	if err != nil {
		log.Fatalf("cannot listen on port %d (port in use by another program?): %v", *portFlag, err)
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
	cursorSpawner := &cursor.Spawner{Bin: *cursorBin, AppRoot: p.Root, Home: home}
	cm := chats.New(chats.Deps{Store: st, Bridge: br, Boards: bs, DefaultCwd: *cwd, BaseURL: base,
		Namer: chats.ClaudeNamer{Bin: *claudeBin},
		Spawners: map[model.AgentKind]agent.Spawner{
			model.Claude: &claude.Spawner{Bin: *claudeBin, AppRoot: p.Root, Home: home, Prompt: prompts.Claude()},
			model.Cursor: cursorSpawner,
		}})
	if err := bs.Load(); err != nil { // before chats: board chats look up their board
		log.Fatalf("loading boards: %v", err)
	}
	if err := cm.Load(); err != nil {
		log.Fatalf("loading chats: %v", err)
	}
	go refreshCursorCatalog(cursorSpawner, st, br)
	a = &app.App{St: st, Boards: bs, Chats: cm, Bridge: br, Home: home, DefaultCwd: *cwd, DataDir: p.Root}
	if err := cursor.EnsureDenyRules(p.Root); err != nil {
		log.Printf("cursor deny rules: %v", err)
	}
	srv := &server.Server{App: a, Relay: &boardapi.Relay{Bridge: br, Chats: cm, Boards: bs}, Bridge: br,
		Client: *client, Port: port}
	if err := store.WriteServerFile(p, port); err != nil {
		log.Printf("server.json: %v", err)
	}
	go onSignal(func() {
		br.StopAndFlush(2 * time.Second) // the client writes pending board changes
		cm.Shutdown()                    // history written; agents end
		store.RemoveServerFile(p)
		os.Exit(0)
	}, syscall.SIGINT, syscall.SIGTERM)

	if *client != "" && !*noOpen {
		openBrowser(base + "/")
	}
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
	c := &http.Client{Timeout: time.Second}
	for _, pt := range ports {
		base := fmt.Sprintf("http://127.0.0.1:%d", pt)
		if isOurs(c, base) {
			return base + "/", true
		}
	}
	return "", false
}

func isOurs(c *http.Client, base string) bool {
	resp, err := c.Get(base + "/api/hello")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var hello struct {
		App string `json:"app"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&hello); err != nil {
		return false
	}
	return hello.App == "ai-whiteboard"
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

func openBrowser(url string) { exec.Command("open", url).Start() }
