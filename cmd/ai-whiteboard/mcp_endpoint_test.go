package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The app must answer MCP on the hidden test-only port override, and never on the real 6006 in
// tests (there is no user-facing port flag; production is fixed at 6006, plan D10).
func TestMCPEndpointAnswersOnOverridePort(t *testing.T) {
	serverTest(t, "TestMCPPortSetting (this package)", "TestMCPHandlerRoutesAndHost (internal/server)")
	in := newInstance(t)
	if got := in.run(t, "launch"); got != in.url+"\n" {
		t.Fatalf("launch printed %q", got)
	}
	in.hello(t)

	// initialize is permissive with no credential (D8); the URL spelling is the advertised
	// localhost one.
	body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"probe","version":"1"}}}`
	req, _ := http.NewRequest("POST", in.mcpURL, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", in.mcpURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("initialize status %d, want 200", resp.StatusCode)
	}
	var out struct {
		Result struct {
			ServerInfo struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Result.ServerInfo.Name != "board" {
		t.Fatalf("serverInfo.name = %q, want board", out.Result.ServerInfo.Name)
	}

	// The MCP listener serves only POST /mcp.
	if resp, err := http.Get(in.mcpURL); err == nil {
		resp.Body.Close()
		if resp.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("GET /mcp status %d, want 405", resp.StatusCode)
		}
	}
}

// A second instance must fail fast when the MCP port is taken: it names the port, the likely
// holder and the remedy, writes no server.json, and leaves the running instance untouched
// (plan D11).
func TestMCPPortConflictFailsFast(t *testing.T) {
	serverTest(t)
	bin := buildBinary(t)
	mcpPort := freePort(t)
	portA, portB := freePort(t), freePort(t)
	dirA, dirB := t.TempDir(), t.TempDir()
	env := serverEnv(t, mcpPort)
	claude := noClaude(t)

	start := func(dir string, port int) (*exec.Cmd, *bytes.Buffer) {
		t.Helper()
		cmd := exec.Command(bin, "serve", "-home", dir, "-port", strconv.Itoa(port), "-client", "",
			"-claude", claude, "-cursor", claude, "-pi", claude)
		cmd.Env = env
		var stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stderr, &stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		return cmd, &stderr
	}

	a, _ := start(dirA, portA)
	aURL := fmt.Sprintf("http://127.0.0.1:%d", portA)
	t.Cleanup(func() {
		stop := exec.Command(bin, "stop", "-home", dirA, "-port", strconv.Itoa(portA))
		stop.Env = env
		stop.Run()
		a.Process.Kill()
	})
	for deadline := time.Now().Add(20 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if _, ok := helloOf(httpClient(), aURL); ok {
			break
		} else if time.Now().After(deadline) {
			t.Fatal("the first instance did not answer within 20 s")
		}
	}
	aPid := func() int {
		h, _ := helloOf(httpClient(), aURL)
		return h.Pid
	}()

	b, stderr := start(dirB, portB)
	done := make(chan error, 1)
	go func() { done <- b.Wait() }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("the second instance started even though the MCP port was taken")
		}
	case <-time.After(30 * time.Second):
		b.Process.Kill()
		t.Fatal("the second instance did not exit after the MCP port conflict")
	}
	msg := stderr.String()
	for _, want := range []string{strconv.Itoa(mcpPort), "another AI Whiteboard instance", "another program", "free port"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("conflict message %q does not contain %q", msg, want)
		}
	}

	if _, err := os.Stat(filepath.Join(dirB, "server.json")); !os.IsNotExist(err) {
		t.Fatalf("the failed instance wrote server.json (stat err %v)", err)
	}
	if h, ok := helloOf(httpClient(), aURL); !ok || h.Pid != aPid {
		t.Fatalf("the running instance was disturbed: hello=%+v ok=%v, want pid %d", h, ok, aPid)
	}
}
