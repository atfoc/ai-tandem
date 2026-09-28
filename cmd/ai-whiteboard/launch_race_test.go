package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestLaunchRace starts two `launch` at the same moment for one data folder: both must print the
// same URL and exactly one server must run.
func TestLaunchRace(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the binary and starts servers")
	}
	bin := filepath.Join(t.TempDir(), "ai-whiteboard")
	if out, err := exec.Command("go", "build", "-o", bin, "ai-whiteboard/cmd/ai-whiteboard").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	for round := 1; round <= 3; round++ {
		t.Run(fmt.Sprintf("round%d", round), func(t *testing.T) { launchRace(t, bin) })
	}
}

func launchRace(t *testing.T, bin string) {
	dir := t.TempDir()
	port := freePort(t)
	portArg := strconv.Itoa(port)
	t.Cleanup(func() {
		exec.Command(bin, "stop", "-home", dir, "-port", portArg).Run()
		exec.Command("pkill", "-KILL", "-f", "--", "-home "+dir).Run()
	})

	type result struct {
		out    string
		stderr string
		err    error
	}
	results := make([]result, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, bin, "launch", "-home", dir, "-port", portArg, "-client", "")
			<-start
			out, err := cmd.Output()
			r := result{out: string(out), err: err}
			if ee, ok := err.(*exec.ExitError); ok {
				r.stderr = string(ee.Stderr)
			}
			results[i] = r
		}()
	}
	close(start)
	wg.Wait()

	want := fmt.Sprintf("http://127.0.0.1:%d/", port)
	for i, r := range results {
		if r.err != nil {
			t.Fatalf("launcher %d: %v\n%s", i, r.err, r.stderr)
		}
		if r.out != want+"\n" {
			t.Fatalf("launcher %d printed %q, want the single line %q", i, r.out, want)
		}
	}

	resp, err := http.Get(want + "api/hello")
	if err != nil {
		t.Fatalf("hello: %v", err)
	}
	defer resp.Body.Close()
	var hello struct {
		App string `json:"app"`
		Pid int    `json:"pid"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&hello); err != nil {
		t.Fatalf("hello: %v", err)
	}
	if hello.App != "ai-whiteboard" {
		t.Fatalf("hello app = %q", hello.App)
	}

	out, err := exec.Command("pgrep", "-f", "--", "serve -home "+dir).Output()
	if err != nil {
		t.Fatalf("pgrep: %v", err)
	}
	pids := strings.Fields(string(out))
	if len(pids) != 1 || pids[0] != strconv.Itoa(hello.Pid) {
		t.Fatalf("servers for %s: pids %v, want only %d (the one /api/hello reports)", dir, pids, hello.Pid)
	}
}
