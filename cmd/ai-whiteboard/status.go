package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/store"
)

// statusJSON is what `status -json` writes: what the running server serves, and what the next
// start will do. Never the secret.
type statusJSON struct {
	Running *runningJSON `json:"running"`
	Files   filesJSON    `json:"files"`
}

type runningJSON struct {
	Build        string         `json:"build"` // "this" | "older"
	Version      string         `json:"version"`
	PID          int            `json:"pid"`
	FeatureLevel int            `json:"featureLevel"`
	InstanceID   string         `json:"instanceId,omitempty"`
	Client       *clientStatus  `json:"client"` // null for an older build
	MCP          map[string]any `json:"mcp"`    // null for an older build
}

type filesJSON struct {
	SetUp       bool     `json:"setUp"`
	OK          bool     `json:"ok"`
	Port        int      `json:"port,omitempty"`
	Names       []string `json:"names,omitempty"`
	Fingerprint string   `json:"fingerprint,omitempty"`
	Message     string   `json:"message,omitempty"` // only when ok is false
	Notes       []string `json:"notes"`
}

// statusCommand is `status`: what the running server of the data folder serves, and what the next
// start will do. It exits 1 when the next start would fail, a server that was never set up
// included, with the check's message on stderr.
func statusCommand(args []string, stdout, stderr io.Writer) int {
	f := newOwnFlags("status", stderr)
	asJSON := f.Bool("json", false, "write one JSON object")
	if code, ok := f.parse(args, stderr); !ok {
		return code
	}
	run, found := findRunning(store.NewPaths(f.root))
	rep := remote.Check(f.root, mcpPort())
	if *asJSON {
		return writeStatusJSON(f, run, found, rep, stdout, stderr)
	}

	switch {
	case !found:
		fmt.Fprintln(stdout, "Running: no server")
	case run.build == olderBuild:
		fmt.Fprintf(stdout, "Running: older build %s (pid %d)\n", run.hello.Version, run.hello.Pid)
	default:
		fmt.Fprintf(stdout, "Running: this build %s (pid %d)\n", run.hello.Version, run.hello.Pid)
		if st, ok := run.statusOf(); ok {
			if c := st.Client; c.Listening {
				fmt.Fprintf(stdout, "Address: %s\nPort: %d\nNames: %s\nFingerprint: %s\n", c.Address, c.Port, strings.Join(c.Names, ", "), c.Fingerprint)
			}
			mcp, _ := st.MCP["listener"].(map[string]any)
			up := "down"
			if mcp["up"] == true {
				up = "up"
			}
			fmt.Fprintf(stdout, "MCP listener: %v (%s)\n", mcp["url"], up)
		}
	}

	switch {
	case !rep.Configured:
		fmt.Fprintln(stdout, "Files: not set up")
		return f.checkResult(rep, stderr)
	case rep.OK():
		fmt.Fprintln(stdout, "Files: the next start will listen")
	default:
		fmt.Fprintln(stdout, "Files: the server will not start")
	}
	printConfig(stdout, rep)
	printNotes(stdout, rep)
	return f.checkResult(rep, stderr)
}

func writeStatusJSON(f *ownFlags, run runningServer, found bool, rep remote.Report, stdout, stderr io.Writer) int {
	out := statusJSON{Files: filesJSON{SetUp: rep.Configured, OK: rep.OK(), Port: rep.Config.Port, Names: rep.Config.Names,
		Fingerprint: rep.Fingerprint, Notes: append([]string{}, rep.Notes...)}}
	if !rep.OK() {
		out.Files.Message = rep.Message(f.exe, f.msgHome)
	}
	if found {
		r := &runningJSON{Build: string(run.build), Version: run.hello.Version, PID: run.hello.Pid,
			FeatureLevel: run.hello.FeatureLevel, InstanceID: run.hello.InstanceID}
		if st, ok := run.statusOf(); ok {
			r.Client, r.MCP = &st.Client, st.MCP
			if r.Client.Names == nil {
				r.Client.Names = []string{}
			}
		}
		out.Running = r
	}
	b, _ := json.Marshal(out)
	fmt.Fprintf(stdout, "%s\n", b)
	return f.checkResult(rep, stderr)
}
