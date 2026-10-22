//go:build !windows

package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func TestRelaunchWithNoServerIsLaunch(t *testing.T) {
	serverTest(t, "TestServeOnADataFolderWithRunData (this package: a whole server); TestLaunchFindsTheRunningServer (this package: launch against a stand-in)")
	in := newInstance(t)
	l := in.launchJSON(t, "relaunch")
	if l.State != "running" || l.Address != in.base() || l.Fingerprint != in.fpr || l.Home != in.dir {
		t.Fatalf("relaunch -json: %+v", l)
	}
	if in.hello(t).Pid != l.PID {
		t.Fatalf("the pid %d, hello says %d", l.PID, in.hello(t).Pid)
	}
}

// launch and relaunch write the address and the fingerprint for a person, and one JSON line for
// the app; a launch of a running server changes nothing; a relaunch replaces the server.
func TestLaunchAndRelaunchOutput(t *testing.T) {
	serverTest(t, "TestLaunchFindsTheRunningServer, TestLaunchKeepsTheOlderBuild (this package: against stand-ins)")
	in := newInstance(t)
	want := fmt.Sprintf("AI Whiteboard is running.\nAddress: %s\nFingerprint: %s\n", in.base(), in.fpr)
	if got := in.run(t, "launch"); got != want {
		t.Fatalf("launch wrote %q, want %q", got, want)
	}
	first := in.hello(t)
	if first.InstanceID == "" || first.FeatureLevel != 7 {
		t.Fatalf("hello: %+v", first)
	}

	l := in.launchJSON(t, "launch")
	if l.State != "running" || l.Address != in.base() || l.Fingerprint != in.fpr || l.PID != first.Pid || l.InstanceID != first.InstanceID ||
		l.FeatureLevel != 7 || l.Version != first.Version || l.Home != in.dir {
		t.Fatalf("launch -json: %+v, hello %+v", l, first)
	}
	// The fingerprint it states is the certificate the server presents, and the address is
	// reached with it.
	if status, _, err := in.request(context.Background(), testClient, "GET", "/api/hello", nil); err != nil || status != 200 {
		t.Fatalf("hello at the address launch gave: %d, %v", status, err)
	}

	if got := in.run(t, "relaunch"); got != want {
		t.Fatalf("relaunch wrote %q, want %q", got, want)
	}
	second := in.hello(t)
	if second.Pid == first.Pid || second.InstanceID != first.InstanceID {
		t.Fatalf("after relaunch: pid %d (was %d), instance %q (was %q)", second.Pid, first.Pid, second.InstanceID, first.InstanceID)
	}
	waitGone(t, first.Pid)
}

// A server that was never set up refuses to start, with the message that names the command that
// sets it up, binds nothing and writes no server.json; once it is set up, the same commands start
// it. The same through serve, launch and relaunch.
func TestNotSetUpRefusesThenStarts(t *testing.T) {
	smokeTest(t)
	in := newBareInstance(t)
	want := fmt.Sprintf("AI Whiteboard is not set up on this machine. Set it up once with: %q remote setup -home %q", in.exe(t), in.dir)

	for _, command := range []string{"serve", "launch", "relaunch"} {
		out, errOut, code := in.ends(t, command)
		if code != 1 || out != "" || !strings.Contains(errOut, want+"\n") {
			t.Fatalf("%s: code %d, stdout %q, stderr %q; want it to hold %q", command, code, out, errOut, want)
		}
		in.noServer(t)
		if listening(in.mcpPort) {
			t.Fatalf("%s: the MCP port %d is bound", command, in.mcpPort)
		}
	}
	// launch and relaunch name why before they start anything; they put nothing in server.log.
	if _, err := os.Stat(filepath.Join(in.dir, "server.log")); !os.IsNotExist(err) {
		t.Fatalf("server.log: %v, want none", err)
	}

	in.setUp(t)
	l := in.launchJSON(t, "launch")
	if l.State != "running" || l.Address != in.base() || l.Fingerprint != fingerprintOf(t, in.dir) {
		t.Fatalf("launch -json after the set-up: %+v", l)
	}
	run := in.waitServing(t)
	st, _ := run.statusOf()
	if st.Client.Fingerprint != in.fpr || st.Client.Port != in.port {
		t.Fatalf("the running server's status: %+v", st)
	}
}

// A running server of the build before is found: launch says so and starts none, relaunch stops
// it by its pid and starts one of this build.
func TestRelaunchReplacesTheBuildBefore(t *testing.T) {
	serverTest(t, "TestLaunchKeepsTheOlderBuild, TestStopCommand (this package: against stand-ins)")
	in := newInstance(t)
	asThisFolders(t, in.dir, standInID)
	old := (&standIn{version: "0.9.0"}).withPid(t)
	old.older(t, in.dir, true)

	l := in.launchJSON(t, "launch")
	if l.State != "old_build" || l.Version != "0.9.0" || l.PID != old.pid || l.FeatureLevel != 5 || l.Address != "" || l.Fingerprint != "" {
		t.Fatalf("launch -json against the build before: %+v", l)
	}
	if !old.alive() {
		t.Fatal("launch stopped the server of the build before")
	}
	if in.listeningAnywhere() {
		t.Fatal("launch started a second server beside the one of the build before")
	}

	// relaunch: SIGTERM to the pid, then a server of this build. The stand-in stops answering
	// when its process is gone, and server.json (which has no control socket) is the old one's;
	// the new server writes its own.
	l = in.launchJSON(t, "relaunch")
	if l.State != "running" || l.PID == old.pid || old.alive() {
		t.Fatalf("relaunch -json: %+v, the old process alive: %v", l, old.alive())
	}
	in.waitServing(t)
}

// listeningAnywhere reports whether a server of the instance serves: the client port or the MCP
// port accepts.
func (in *instance) listeningAnywhere() bool {
	return listening(in.port) || listening(in.mcpPort)
}

// A server that stops while it starts is a launch that fails: nothing on stdout, the title and the
// last lines of the log on stderr, exit 1. Here another program holds the MCP port.
func TestLaunchShowsWhyTheServerStopped(t *testing.T) {
	serverTest(t, "TestLaunchOfAFolderNeverSetUp (this package: a launch that fails before it starts a server)")
	in := newInstance(t)
	holder, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", in.mcpPort))
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	out, errOut, code := in.ends(t, "launch", "-json")
	if code != 1 || out != "" || !strings.HasPrefix(errOut, "AI Whiteboard: the server stopped while starting\n") ||
		!strings.Contains(errOut, "cannot serve the MCP endpoint on port "+strconv.Itoa(in.mcpPort)) {
		t.Fatalf("launch: code %d, stdout %q, stderr %q", code, out, errOut)
	}
	in.noServerFiles(t)
	// relaunch the same, and a later launch with the port free starts the server.
	if _, errOut, code := in.ends(t, "relaunch"); code != 1 || !strings.HasPrefix(errOut, "AI Whiteboard: the server stopped while starting\n") {
		t.Fatalf("relaunch: code %d, stderr %q", code, errOut)
	}
	holder.Close()
	if l := in.launchJSON(t, "launch"); l.State != "running" {
		t.Fatalf("launch after the port was freed: %+v", l)
	}
}

// serve finds a server running, of this build or the one before, says so, exits 0 and binds
// nothing.
func TestServeFindsTheRunningServer(t *testing.T) {
	serverTest(t, "TestFindRunningThisBuild, TestFindRunningOlderBuild (this package)")
	in := newInstance(t)
	l := in.launchJSON(t, "launch")
	out, errOut, code := in.ends(t, "serve")
	if code != 0 || errOut != "" || out != fmt.Sprintf("AI Whiteboard is already running (pid %d)\n", l.PID) {
		t.Fatalf("serve beside a server of this build: code %d, stdout %q, stderr %q", code, out, errOut)
	}
	if in.hello(t).Pid != l.PID {
		t.Fatal("serve replaced the running server")
	}

	other := newInstance(t)
	asThisFolders(t, other.dir, standInID)
	old := (&standIn{version: "0.9.0"}).withPid(t)
	old.older(t, other.dir, true)
	out, errOut, code = other.ends(t, "serve")
	if code != 0 || errOut != "" || out != fmt.Sprintf("AI Whiteboard is already running (pid %d)\n", old.pid) {
		t.Fatalf("serve beside a server of the build before: code %d, stdout %q, stderr %q", code, out, errOut)
	}
	if listening(other.mcpPort) || listening(other.port) {
		t.Fatal("serve bound a port beside the server of the build before")
	}
	if !old.alive() {
		t.Fatal("serve stopped the server of the build before")
	}
}

// stop ends a running server of this build, and says so; a second stop says that none runs.
func TestStopEndsTheServer(t *testing.T) {
	serverTest(t, "TestStopCommand (this package: against stand-ins)")
	in := newInstance(t)
	in.launchJSON(t, "launch")
	pid := in.hello(t).Pid
	if got := in.run(t, "stop"); got != "AI Whiteboard stopped\n" {
		t.Fatalf("stop wrote %q", got)
	}
	waitGone(t, pid)
	in.noServer(t)
	if got := in.run(t, "stop"); got != "AI Whiteboard is not running\n" {
		t.Fatalf("the second stop wrote %q", got)
	}
}

// The control socket is the owner's alone, a socket file that nobody answers is replaced at the
// next start, and nothing answers on the port the build before used.
func TestControlSocket(t *testing.T) {
	serverTest(t, "TestFindRunningThisBuild (this package: the control socket of a stand-in); TestControlHandler (internal/server)")
	in := newInstance(t)
	in.launchJSON(t, "launch")
	sock := filepath.Join(in.dir, "control.sock")
	if info, err := os.Lstat(sock); err != nil || info.Mode().Type() != os.ModeSocket || info.Mode().Perm() != 0o600 {
		t.Fatalf("the control socket: %v, %v", info, err)
	}
	if info, err := os.Stat(filepath.Join(in.dir, "server.json")); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("server.json: %v, %v", info, err)
	}
	pid := in.hello(t).Pid

	// A server that dies without a clean exit leaves its socket file and server.json.
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	waitGone(t, pid)
	if _, err := os.Lstat(sock); err != nil {
		t.Fatalf("the socket of a server that was killed: %v, want it left", err)
	}
	if _, ok := in.running(); ok {
		t.Fatal("a killed server is found running")
	}
	if got := in.run(t, "stop"); got != "AI Whiteboard is not running\n" {
		t.Fatalf("stop after the kill wrote %q", got)
	}
	l := in.launchJSON(t, "launch")
	if l.State != "running" || l.PID == pid {
		t.Fatalf("launch after the kill: %+v", l)
	}
	if info, err := os.Lstat(sock); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the control socket after the replacement: %v, %v", info, err)
	}
}

// A data folder whose path is too long for a Unix socket: the control socket is where
// store.ControlSocketPath puts it, and the commands find the server there.
func TestControlSocketOfALongPath(t *testing.T) {
	serverTest(t, "TestFindRunningThisBuild (this package); TestControlSocketPath (internal/store)")
	in := newInstance(t)
	long := filepath.Join(in.dir, strings.Repeat("a-long-folder-name-", 6), "data")
	if err := os.MkdirAll(long, 0o700); err != nil {
		t.Fatal(err)
	}
	// A data folder of its own: set up, with the long path.
	other := *in
	other.dir = long
	other.port, other.mcpPort = freePort(t), freePort(t)
	other.vars = append([]string{"AIWB_MCP_PORT=" + fmt.Sprint(other.mcpPort)}, in.vars[1:]...)
	other.setUp(t)
	t.Cleanup(func() { other.command(context.Background(), "stop").Run() })
	sock := sockPath(long)
	l := other.launchJSON(t, "launch")
	if len(sock) > 104 || strings.HasPrefix(sock, long) {
		t.Fatalf("the control socket path %q is not the short one", sock)
	}
	sf := readServerFile(t, long)
	if sf.Control != sock || l.State != "running" {
		t.Fatalf("server.json names %q, want %q; launch: %+v", sf.Control, sock, l)
	}
	if _, err := os.Stat(filepath.Dir(sock)); err != nil {
		t.Fatalf("the short folder of the socket while the server runs: %v", err)
	}
	if got := other.run(t, "stop"); got != "AI Whiteboard stopped\n" {
		t.Fatalf("stop wrote %q", got)
	}
	// The server removes what it made: the socket and the short folder, which only it needed.
	if _, err := os.Stat(filepath.Dir(sock)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the short folder of the socket after stop: %v, want it gone", err)
	}
}
