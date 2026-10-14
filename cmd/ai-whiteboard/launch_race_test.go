package main

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// TestLaunchRace starts two `launch` at the same moment for one data folder: both must print the
// same address and fingerprint and exactly one server must run.
func TestLaunchRace(t *testing.T) {
	serverTest(t, "TestLaunchFindsTheRunningServer (this package: launch against a stand-in server)")
	for round := 1; round <= 3; round++ {
		t.Run(fmt.Sprintf("round%d", round), func(t *testing.T) { launchRace(t) })
	}
}

func launchRace(t *testing.T) {
	in := newInstance(t)
	type result struct {
		out    string
		stderr string
		code   int
	}
	results := make([]result, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			cmd := in.command(context.Background(), "launch", "-json")
			var out, errOut bytes.Buffer
			cmd.Stdout, cmd.Stderr = &out, &errOut
			err := cmd.Run()
			code := 0
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			} else if err != nil {
				code = -1
			}
			results[i] = result{out.String(), errOut.String(), code}
		}()
	}
	close(start)
	wg.Wait()

	for i, r := range results {
		if r.code != 0 {
			t.Fatalf("launcher %d: exit %d\n%s", i, r.code, r.stderr)
		}
		if r.out != results[0].out {
			t.Fatalf("launcher %d printed %q, launcher 0 %q", i, r.out, results[0].out)
		}
	}
	run := in.waitServing(t)
	if !strings.Contains(results[0].out, `"pid":`+strconv.Itoa(run.hello.Pid)+",") || !strings.Contains(results[0].out, `"address":"`+in.base()+`"`) {
		t.Fatalf("launch printed %q, the server runs as pid %d at %s", results[0].out, run.hello.Pid, in.base())
	}

	out, err := exec.Command("pgrep", "-f", "--", "serve -home "+in.dir).Output()
	if err != nil {
		t.Fatalf("pgrep: %v", err)
	}
	pids := strings.Fields(string(out))
	if len(pids) != 1 || pids[0] != strconv.Itoa(run.hello.Pid) {
		t.Fatalf("servers for %s: pids %v, want only %d (the one hello reports)", in.dir, pids, run.hello.Pid)
	}
}
