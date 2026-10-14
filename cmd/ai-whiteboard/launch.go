package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/store"
)

// launchOut is the one line `launch -json` and `relaunch -json` write, for the app: the running
// server's address and certificate fingerprint, or the build before's version.
type launchOut struct {
	State        string `json:"state"` // "running" | "old_build"
	Address      string `json:"address,omitempty"`
	Fingerprint  string `json:"fingerprint,omitempty"`
	Version      string `json:"version"`
	FeatureLevel int    `json:"featureLevel"`
	InstanceID   string `json:"instanceId,omitempty"`
	PID          int    `json:"pid"`
	Home         string `json:"home"`
}

// launch finds the running server, or starts `serve` with launch's flags detached from this
// process (its own session, output to server.log, working folder the home folder) and waits for it
// to serve. Either way it writes where the server is (its address and certificate fingerprint, or
// with -json one line for the app) to out and exits 0: the server must outlive it. A server of the
// build before is kept, never stopped, and said to be so. A failure writes its title and detail to
// errOut and returns 1. A server that was never set up is not started: the start's check runs
// first.
func launch(o options, out, errOut io.Writer) int {
	unlock, err := lockLaunch(o.paths)
	if err != nil {
		return failure(errOut, "cannot start the server", err.Error())
	}
	defer unlock()
	return launchLocked(o, out, errOut)
}

func launchLocked(o options, out, errOut io.Writer) int {
	p := o.paths
	if _, ok := findRunning(p); ok {
		return waitServing(o, nil, "", 0, out, errOut)
	}
	if rep := remote.Check(p.Root, mcpPort()); !rep.OK() {
		return failure(errOut, "the server was not started", rep.Message(exePath(), messageHome(p.Root)))
	}

	usePath(loginPath()) // apps started by Finder or Spotlight get only /usr/bin:/bin:/usr/sbin:/sbin
	exe, err := os.Executable()
	if err != nil {
		return failure(errOut, "cannot find its own program", err.Error())
	}
	cmd, logPath, from, err := startDetached(p, exe, "serve", o.serveArgs, "launch")
	if err != nil {
		return failure(errOut, "cannot start the server", err.Error())
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	return waitServing(o, exited, logPath, from, out, errOut)
}

// waitServing waits up to 30 s for a server to serve (the one found, or the one just started,
// whose process ends on exited) and writes where it is. A server of the build before is
// reported at once. The process that ends before the server serves is a start that failed, with
// the end of the log.
func waitServing(o options, exited <-chan error, logPath string, from int64, out, errOut io.Writer) int {
	p := o.paths
	var stopped bool
	var stopErr error
	deadline := time.After(30 * time.Second)
	for {
		found, foundAny := findRunning(p)
		if foundAny {
			if info, ok := serving(o, found); ok {
				return writeLaunch(o, info, out)
			}
		}
		// A process that ended with no error saw a server running, and that one may still be starting.
		if stopped && (stopErr != nil || !foundAny) {
			return failure(errOut, "the server stopped while starting", fmt.Sprintf("%v\n\n%s", stopErr, logTail(logPath, from)))
		}
		select {
		case err := <-exited:
			stopped, stopErr = true, err
			continue // look once more: the process may have seen another start win the race
		case <-deadline:
			return failure(errOut, "the server did not answer within 30 seconds", "See "+filepath.Join(p.Root, "server.log"))
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// serving is what a found server answers launch with: for the build before, its hello; for this
// build, hello and the client listener's address and fingerprint once it serves.
func serving(o options, run runningServer) (launchOut, bool) {
	l := launchOut{State: "old_build", Version: run.hello.Version, FeatureLevel: run.hello.FeatureLevel, PID: run.hello.Pid, Home: o.paths.Root}
	if run.build == olderBuild {
		return l, true
	}
	st, ok := run.statusOf()
	if !ok || !st.Client.Listening || st.Client.Fingerprint == "" {
		return l, false
	}
	l.State, l.Address, l.Fingerprint, l.InstanceID = "running", st.Client.Address, st.Client.Fingerprint, run.hello.InstanceID
	return l, true
}

// writeLaunch writes launch's answer: one JSON line for the app, else the words for a person.
func writeLaunch(o options, l launchOut, out io.Writer) int {
	switch {
	case o.json:
		b, _ := json.Marshal(l)
		fmt.Fprintf(out, "%s\n", b)
	case l.State == "running":
		fmt.Fprintf(out, "AI Whiteboard is running.\nAddress: %s\nFingerprint: %s\n", l.Address, l.Fingerprint)
	default:
		fmt.Fprintf(out, "An AI Whiteboard server of an older build (version %s, pid %d) is running. Restart it with: %s\n",
			l.Version, l.PID, programCommand("relaunch", o.paths.Root))
	}
	return 0
}

// programCommand is a command line for a message: this program, the words and the data folder
// when it is not the default one.
func programCommand(words, root string) string {
	s := fmt.Sprintf("%q %s", exePath(), words)
	if home := messageHome(root); home != "" {
		s += fmt.Sprintf(" -home %q", home)
	}
	return s
}

// lockLaunch takes the data folder's launch lock, which makes two launchers (the app's and a
// person's) take turns: the second finds the server the first started, and starts none. It waits
// up to a minute. The lock ends with the process; unlock ends it earlier.
func lockLaunch(p store.Paths) (unlock func(), err error) {
	if err := os.MkdirAll(p.Root, 0o700); err != nil {
		return nil, fmt.Errorf("cannot create the data folder %s: %w", p.Root, err)
	}
	f, err := os.OpenFile(filepath.Join(p.Root, "launch.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	for deadline := time.Now().Add(time.Minute); ; time.Sleep(50 * time.Millisecond) {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { f.Close() }, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EINTR) || time.Now().After(deadline) {
			f.Close()
			return nil, fmt.Errorf("another start of the server did not finish within a minute (%v)", err)
		}
	}
}

// startDetached starts `exe command args...` in its own session, with the home folder as its
// working folder (the default for new chats, unless -cwd is given) and its output appended to
// server.log in the data folder after a "--- <time> <what>" line. It does not wait for it. It
// returns the process, the log's path and the log's size before that line.
func startDetached(p store.Paths, exe, command string, args []string, what string) (*exec.Cmd, string, int64, error) {
	if err := os.MkdirAll(p.Root, 0o700); err != nil {
		return nil, "", 0, fmt.Errorf("cannot create the data folder %s: %w", p.Root, err)
	}
	logPath := filepath.Join(p.Root, "server.log")
	logf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, logPath, 0, fmt.Errorf("cannot open %s: %w", logPath, err)
	}
	defer logf.Close() // the child has its own copy
	from, _ := logf.Seek(0, io.SeekEnd)
	fmt.Fprintf(logf, "\n--- %s %s\n", time.Now().Format(time.RFC3339), what)

	home, _ := os.UserHomeDir()
	cmd := exec.Command(exe, append([]string{command}, args...)...)
	cmd.Dir = home
	cmd.Stdout, cmd.Stderr = logf, logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return nil, logPath, from, err
	}
	return cmd, logPath, from, nil
}

// relaunch is stop + launch: it stops the server running for this data folder, of this build or
// the one before, if any, then does everything launch does. It refuses before it stops anything
// when the start's check would end the new server's start.
func relaunch(o options, out, errOut io.Writer) int {
	if rep := remote.Check(o.paths.Root, mcpPort()); !rep.OK() {
		return failure(errOut, "the server was not restarted", rep.Message(exePath(), messageHome(o.paths.Root)))
	}
	unlock, err := lockLaunch(o.paths)
	if err != nil {
		return failure(errOut, "cannot start the server", err.Error())
	}
	defer unlock()
	if run, ok := findRunning(o.paths); ok {
		if title, detail := stopServer(o.paths, run); title != "" {
			return failure(errOut, title, detail)
		}
	}
	return launchLocked(o, out, errOut)
}

// stopServer sends SIGTERM to the running server (the pid its hello reports) and waits up to 10 s
// for it to stop answering. It takes its normal SIGTERM path: flush the boards, end the agents,
// remove server.json, exit. title is "" when the server is gone, else the title and detail of the
// failure.
func stopServer(p store.Paths, run runningServer) (title, detail string) {
	pid := run.hello.Pid
	if pid <= 0 {
		return "cannot stop the running server", fmt.Sprintf("it reports pid %d", pid)
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Sprintf("cannot stop the running server (pid %d)", pid), err.Error()
	}
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		if again, ok := findRunning(p); !ok || again.hello.Pid != pid {
			break
		}
		if time.Now().After(deadline) {
			return "the running server did not stop within 10 seconds", fmt.Sprintf("pid %d", pid)
		}
	}
	// The server stops answering just before it exits, and the new server binds the ports it held.
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			break
		}
	}
	return "", ""
}

// stopCommand is `stop`: SIGTERM to the running server and a wait for it to finish shutting down.
func stopCommand(args []string, stdout, stderr io.Writer) int {
	f := newOwnFlags("stop", stderr)
	if code, ok := f.parse(args, stderr); !ok {
		return code
	}
	p := store.NewPaths(f.root)
	run, ok := findRunning(p)
	if !ok {
		fmt.Fprintln(stdout, "AI Whiteboard is not running")
		return 0
	}
	if title, detail := stopServer(p, run); title != "" {
		return failure(stderr, title, detail)
	}
	fmt.Fprintln(stdout, "AI Whiteboard stopped")
	return 0
}

// loginPath returns PATH as the user's login shell sets it, or "" if the shell doesn't answer.
func loginPath() string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	const mark = "__AIWB_PATH__"
	out, err := exec.CommandContext(ctx, shell, "-ilc", `printf '\n`+mark+`%s\n' "$PATH"`).Output()
	if err != nil && len(out) == 0 {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if v, ok := strings.CutPrefix(line, mark); ok {
			return v
		}
	}
	return ""
}

// usePath puts the login shell's PATH first, keeping any entry of the current PATH it lacks.
func usePath(login string) {
	if login == "" {
		return
	}
	parts := strings.Split(login, ":")
	seen := map[string]bool{}
	for _, d := range parts {
		seen[d] = true
	}
	for _, d := range strings.Split(os.Getenv("PATH"), ":") {
		if d != "" && !seen[d] {
			parts = append(parts, d)
		}
	}
	os.Setenv("PATH", strings.Join(parts, ":"))
}

// logTail returns the last few lines written to the log after offset from.
func logTail(path string, from int64) string {
	b, err := os.ReadFile(path)
	if err != nil || int64(len(b)) < from {
		return ""
	}
	lines := strings.Split(strings.TrimSpace(string(b[from:])), "\n")
	if len(lines) > 8 {
		lines = lines[len(lines)-8:]
	}
	return strings.Join(lines, "\n")
}

// failure reports a command's failure on w: "AI Whiteboard: <title>" and the detail. It returns 1,
// the exit code of a command that failed.
func failure(w io.Writer, title, detail string) int {
	fmt.Fprintf(w, "AI Whiteboard: %s\n%s\n", title, detail)
	return 1
}
