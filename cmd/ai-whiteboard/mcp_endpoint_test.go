//go:build !windows

package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The server must answer MCP on the hidden test-only port override, and never on the real 6006 in
// tests (there is no user-facing port flag; production is fixed at 6006, plan D10).
func TestMCPEndpointAnswersOnOverridePort(t *testing.T) {
	serverTest(t, "TestMCPPortSetting (this package)", "TestMCPHandlerRoutesAndHost (internal/server)")
	in := newInstance(t)
	in.launchJSON(t, "launch")

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

	// `status` reports the listener's identity (its port, its URL, that it is up) and the last
	// contact per chat; the MCP port is no place to read it: nothing else is served there.
	var status struct {
		Running struct {
			MCP struct {
				Listener struct {
					Port int
					URL  string
					Up   bool
				}
				Chats []any
			}
		}
	}
	jsonOut := in.run(t, "status", "-json")
	if err := json.Unmarshal([]byte(jsonOut), &status); err != nil {
		t.Fatalf("status -json: %v in %s", err, jsonOut)
	}
	l := status.Running.MCP.Listener
	if l.Port != in.mcpPort || l.URL != in.mcpURL || !l.Up || status.Running.MCP.Chats == nil {
		t.Fatalf("status -json: the MCP listener %+v, chats %v; want port %d, %s, up", l, status.Running.MCP.Chats, in.mcpPort, in.mcpURL)
	}
	for _, path := range []string{"/api/mcp/status", "/api/state", "/"} {
		resp, err := http.Get("http://127.0.0.1:" + strconv.Itoa(in.mcpPort) + path)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				t.Fatalf("GET %s on the MCP port: status 200", path)
			}
		}
	}
}

// A second instance must fail fast when the MCP port is taken: it names the port, the likely
// holder and the remedy, writes no server.json, and leaves the running instance untouched
// (plan D11).
func TestMCPPortConflictFailsFast(t *testing.T) {
	serverTest(t)
	a := newInstance(t)
	a.launchJSON(t, "launch")
	aPid := a.hello(t).Pid

	// B: a data folder and a client port of its own, the same MCP port.
	b := newInstance(t)
	b.mcpPort = a.mcpPort
	b.vars = append(b.vars, "AIWB_MCP_PORT="+strconv.Itoa(a.mcpPort))

	stdout, stderr, code := b.ends(t, "serve")
	if code == 0 || stdout != "" {
		t.Fatalf("the second instance started even though the MCP port was taken: code %d, stdout %q", code, stdout)
	}
	for _, want := range []string{strconv.Itoa(a.mcpPort), "another AI Whiteboard instance", "another program", "free port"} {
		if !strings.Contains(stderr, want) {
			t.Fatalf("conflict message %q does not contain %q", stderr, want)
		}
	}
	b.noServerFiles(t)
	if _, err := os.Stat(filepath.Join(b.dir, "server.json")); !os.IsNotExist(err) {
		t.Fatalf("the failed instance wrote server.json (stat err %v)", err)
	}
	if got := a.hello(t).Pid; got != aPid {
		t.Fatalf("the running instance was disturbed: pid %d, want %d", got, aPid)
	}
	a.helloOK(t, a.secret)
}
