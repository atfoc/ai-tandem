package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

// bridgeFake is the bridge's Docker and network for the tests: lookup answers from gws (the last
// answer repeats), listen listens on 127.0.0.1 with a free port whatever address is asked.
type bridgeFake struct {
	mu     sync.Mutex
	gws    []string // "" with err = lookup fails
	errs   []error
	asked  []string
	logs   []string
	listen chan bridgeListen
}

type bridgeListen struct {
	asked string
	ln    net.Listener
}

func newBridgeFake() *bridgeFake { return &bridgeFake{listen: make(chan bridgeListen, 8)} }

func (f *bridgeFake) answer(gw string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gws, f.errs = append(f.gws, gw), append(f.errs, err)
}

func (f *bridgeFake) bridge(every time.Duration) *mcpBridge {
	return &mcpBridge{
		lookup: func(ctx context.Context) (string, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.gws) == 0 {
				return "", errors.New("no answer yet")
			}
			gw, err := f.gws[0], f.errs[0]
			if len(f.gws) > 1 {
				f.gws, f.errs = f.gws[1:], f.errs[1:]
			}
			return gw, err
		},
		listen: func(network, addr string) (net.Listener, error) {
			f.mu.Lock()
			f.asked = append(f.asked, addr)
			f.mu.Unlock()
			ln, err := net.Listen(network, "127.0.0.1:0")
			if err == nil {
				f.listen <- bridgeListen{addr, ln}
			}
			return ln, err
		},
		every:   every,
		handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "mcp") }),
		port:    6006,
		logf: func(format string, args ...any) {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.logs = append(f.logs, fmt.Sprintf(format, args...))
		},
	}
}

// start runs b until the test ends; the returned function stops it and waits for run to return.
func startBridge(t *testing.T, b *mcpBridge) func() {
	stop, done := make(chan struct{}), make(chan struct{})
	go func() { b.run(stop); close(done) }()
	var once sync.Once
	end := func() {
		once.Do(func() {
			close(stop)
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("the bridge did not stop")
			}
		})
	}
	t.Cleanup(end)
	return end
}

func (f *bridgeFake) nextListen(t *testing.T) bridgeListen {
	t.Helper()
	select {
	case l := <-f.listen:
		return l
	case <-time.After(5 * time.Second):
		t.Fatal("the bridge did not listen")
		return bridgeListen{}
	}
}

func bridgeGet(ln net.Listener) (string, error) {
	c := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	resp, err := c.Get("http://" + ln.Addr().String() + "/mcp")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return string(b), err
}

func wantServes(t *testing.T, ln net.Listener) {
	t.Helper()
	if body, err := bridgeGet(ln); err != nil || body != "mcp" {
		t.Fatalf("GET on the bridge listener: %q, %v", body, err)
	}
}

func wantClosed(t *testing.T, ln net.Listener) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		c, err := net.DialTimeout("tcp", ln.Addr().String(), time.Second)
		if err != nil {
			return
		}
		c.Close()
		if time.Now().After(deadline) {
			t.Fatalf("listener %s still open", ln.Addr())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestBridgeBindsAndServes(t *testing.T) {
	f := newBridgeFake()
	f.answer("172.17.0.1\n", nil)
	stop := startBridge(t, f.bridge(time.Hour))
	l := f.nextListen(t)
	if l.asked != "172.17.0.1:6006" {
		t.Fatalf("listened on %q, want 172.17.0.1:6006", l.asked)
	}
	wantServes(t, l.ln)
	stop()
	wantClosed(t, l.ln)
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.logs) != 1 {
		t.Fatalf("logs %q, want one line", f.logs)
	}
}

func TestBridgeRetriesUntilDocker(t *testing.T) {
	f := newBridgeFake()
	for range 3 {
		f.answer("", errors.New("Cannot connect to the Docker daemon"))
	}
	f.answer("127.0.0.1", nil) // loopback: skipped
	f.answer("", nil)          // no gateway: skipped
	f.answer("172.17.0.1", nil)
	startBridge(t, f.bridge(5*time.Millisecond))
	l := f.nextListen(t)
	if l.asked != "172.17.0.1:6006" {
		t.Fatalf("listened on %q", l.asked)
	}
	wantServes(t, l.ln)
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.asked) != 1 {
		t.Fatalf("listen asked %q, want once", f.asked)
	}
	// one line for "no Docker" (not one per retry), one for "no gateway", one for serving
	if len(f.logs) != 3 {
		t.Fatalf("logs %q, want 3 lines", f.logs)
	}
}

func TestBridgeRetriesListen(t *testing.T) {
	f := newBridgeFake()
	f.answer("172.17.0.1", nil)
	b := f.bridge(5 * time.Millisecond)
	fails := 3
	listen := b.listen
	b.listen = func(network, addr string) (net.Listener, error) {
		f.mu.Lock()
		failing := fails > 0
		fails--
		f.mu.Unlock()
		if failing {
			return nil, errors.New("cannot assign requested address")
		}
		return listen(network, addr)
	}
	startBridge(t, b)
	wantServes(t, f.nextListen(t).ln)
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.logs) != 2 {
		t.Fatalf("logs %q, want 2 lines (listen failing once, serving)", f.logs)
	}
}

func TestBridgeRebindsOnGatewayChange(t *testing.T) {
	f := newBridgeFake()
	f.answer("172.17.0.1", nil)
	f.answer("", errors.New("docker restarting")) // a failed lookup keeps the listener
	f.answer("172.17.0.1", nil)
	f.answer("172.18.0.1", nil)
	startBridge(t, f.bridge(5*time.Millisecond))
	first := f.nextListen(t)
	second := f.nextListen(t)
	if first.asked != "172.17.0.1:6006" || second.asked != "172.18.0.1:6006" {
		t.Fatalf("listened on %q then %q", first.asked, second.asked)
	}
	wantClosed(t, first.ln)
	wantServes(t, second.ln)
	select {
	case l := <-f.listen:
		t.Fatalf("listened again on %q with an unchanged gateway", l.asked)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestBridgeServeFailureRetries(t *testing.T) {
	f := newBridgeFake()
	f.answer("172.17.0.1", nil)
	startBridge(t, f.bridge(5*time.Millisecond))
	first := f.nextListen(t)
	first.ln.Close() // the interface went away: Serve fails
	second := f.nextListen(t)
	if second.asked != "172.17.0.1:6006" {
		t.Fatalf("listened again on %q", second.asked)
	}
	wantServes(t, second.ln)
}

func TestBridgeOnlyOnLinux(t *testing.T) {
	h := http.NotFoundHandler()
	for _, goos := range []string{"darwin", "windows", "freebsd"} {
		if b := startMCPBridgeOn(goos, "/nonexistent/docker", 6006, h, nil); b != nil {
			t.Fatalf("%s: a bridge started", goos)
		}
	}
	stop := make(chan struct{})
	defer close(stop)
	b := startMCPBridgeOn("linux", "/nonexistent/docker", 6006, h, stop)
	if b == nil || b.every != mcpBridgeEvery || b.port != 6006 {
		t.Fatalf("linux: bridge %+v", b)
	}
}

func TestBridgePickGateway(t *testing.T) {
	for in, want := range map[string]string{
		"172.17.0.1\n":              "172.17.0.1",
		"172.17.0.1 fd00::1 ":       "172.17.0.1",
		"fd00::1 172.17.0.1":        "172.17.0.1",
		"fd00::1":                   "fd00::1",
		"":                          "",
		"127.0.0.1":                 "",
		"0.0.0.0 ::1":               "",
		"<no value>":                "",
		"garbage 192.168.65.1 more": "192.168.65.1",
	} {
		if got := pickGateway(in); got != want {
			t.Errorf("pickGateway(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBridgeDockerLookup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the stand-in docker is a shell script")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "docker")
	script := `#!/bin/sh
[ "$*" = "network inspect bridge --format {{range .IPAM.Config}}{{.Gateway}} {{end}}" ] || { echo "unexpected: $*" >&2; exit 2; }
echo "172.17.0.1 fd00::1 "
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if gw, err := dockerBridgeGateway(context.Background(), bin); err != nil || gw != "172.17.0.1" {
		t.Fatalf("gateway %q, %v", gw, err)
	}
	if _, err := dockerBridgeGateway(context.Background(), filepath.Join(dir, "missing")); err == nil {
		t.Fatal("no error without docker")
	}
}
