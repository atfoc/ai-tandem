package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"ai-whiteboard/internal/server"
	"ai-whiteboard/internal/store"
)

// bundleResources returns Contents/Resources when this program runs from inside an app bundle
// (X.app/Contents/MacOS/ai-whiteboard), else "".
func bundleResources() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	return resourcesFor(exe)
}

func resourcesFor(exe string) string {
	macos := filepath.Dir(exe)
	contents := filepath.Dir(macos)
	if filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" ||
		!strings.HasSuffix(filepath.Dir(contents), ".app") {
		return ""
	}
	return filepath.Join(contents, "Resources")
}

// launch finds the running server, or starts `serve` with launch's flags detached from this
// process (its own session, output to server.log, working folder the home folder) and waits for it
// to answer. Either way it writes the server's URL to out as its only line, so the Electron app and
// scripts can read it, and exits: the server must outlive it.
func launch(o options, args []string, out io.Writer) {
	p := o.paths
	if url, ok := findRunning(p, o.port); ok {
		fmt.Fprintln(out, url)
		return
	}

	usePath(loginPath()) // apps started by Finder or Spotlight get only /usr/bin:/bin:/usr/sbin:/sbin
	exe, err := os.Executable()
	if err != nil {
		fail("cannot find its own program", err.Error())
	}
	cmd, logPath, from, err := startDetached(p, exe, "serve", args, "launch")
	if err != nil {
		fail("cannot start the server", err.Error())
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	// When another launcher raced this one, this serve exits (it saw the other server, or could not
	// bind the port) while the other server may still be starting: keep polling for as long as
	// something accepts connections on the port.
	var stopped bool
	var stopErr error
	deadline := time.After(30 * time.Second)
	for {
		if url, ok := findRunning(p, o.port); ok {
			fmt.Fprintln(out, url)
			return
		}
		if stopped && !listening(o.port) {
			fail("the server stopped while starting", fmt.Sprintf("%v\n\n%s", stopErr, logTail(logPath, from)))
		}
		select {
		case err := <-exited:
			stopped, stopErr = true, err
		case <-deadline:
			fail("the server did not answer within 30 seconds", "See "+logPath)
		case <-time.After(100 * time.Millisecond):
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

// relaunch is stop + launch: it stops the server running for this data folder, if any, then does
// everything launch does. Like launch, it writes only the server's URL to out; the stop step writes
// nothing there.
func relaunch(o options, args []string, out io.Writer) {
	refuseBadRemote(o)
	if url, ok := findRunning(o.paths, o.port); ok {
		stopServer(strings.TrimSuffix(url, "/"))
	}
	launch(o, args, out)
}

// stopServer sends SIGTERM to the server answering at base (the pid its /api/hello reports) and
// waits up to 10 s for it to stop answering. It takes its normal SIGTERM path: flush the boards,
// end the agents, remove server.json, exit.
func stopServer(base string) {
	h, ok := helloOf(httpClient(), base)
	if !ok {
		return // it stopped meanwhile
	}
	if h.Pid <= 0 {
		fail("cannot stop the running server", fmt.Sprintf("%s reports pid %d", base, h.Pid))
	}
	if err := syscall.Kill(h.Pid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		fail(fmt.Sprintf("cannot stop the running server (pid %d)", h.Pid), err.Error())
	}
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if !isOurs(httpClient(), base) {
			return
		}
	}
	fail("the running server did not stop within 10 seconds", fmt.Sprintf("pid %d at %s", h.Pid, base))
}

// startRelaunch starts `<this program> relaunch <args>` detached, for POST /api/restart: the new
// process stops this server and starts the program now on disk, which after an in-place install is
// the new build. It reports server.ErrBinaryMissing when the program is no longer there.
func startRelaunch(p store.Paths, args []string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if _, err := os.Stat(exe); err != nil {
		return fmt.Errorf("%w: %v", server.ErrBinaryMissing, err)
	}
	cmd, _, _, err := startDetached(p, exe, "relaunch", args, "restart requested by the page")
	if err != nil {
		return err
	}
	go cmd.Wait() // reap it
	return nil
}

// listening reports whether something accepts connections on the local port.
func listening(port int) bool {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// stop sends SIGTERM to the running server and waits for it to finish shutting down.
func stop(o options) {
	pid, port, ok := store.ReadServerFile(o.paths)
	if !ok || !isOurs(httpClient(), fmt.Sprintf("http://127.0.0.1:%d", port)) {
		fmt.Println("AI Whiteboard is not running")
		return
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		log.Fatalf("stopping pid %d: %v", pid, err)
	}
	for i := 0; i < 100; i++ { // shutdown flushes boards (up to 2 s) and ends the agents
		if !isOurs(httpClient(), fmt.Sprintf("http://127.0.0.1:%d", port)) {
			fmt.Println("AI Whiteboard stopped")
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	log.Fatalf("pid %d did not stop within 10 seconds", pid)
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

// fail reports a launch error on stderr and exits 1.
func fail(title, detail string) {
	fmt.Fprintf(os.Stderr, "AI Whiteboard: %s\n%s\n", title, detail)
	os.Exit(1)
}
