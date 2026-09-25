package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

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

// launch opens the running server, or starts `serve -no-open` detached from this process (its own
// session, output to server.log, working folder the home folder) and opens it once it answers.
// It always exits: macOS runs one copy of an app, so a second Spotlight launch only reaches a
// running launcher if the launcher stays, and the server must outlive it anyway.
func launch(o options, args []string) {
	p := o.paths
	if url, ok := findRunning(p, o.port); ok {
		if !o.noOpen {
			openBrowser(url)
		}
		return
	}

	usePath(loginPath()) // apps started by Finder or Spotlight get only /usr/bin:/bin:/usr/sbin:/sbin
	exe, err := os.Executable()
	if err != nil {
		fail("cannot find its own program", err.Error())
	}
	if err := os.MkdirAll(p.Root, 0o700); err != nil {
		fail("cannot create the data folder "+p.Root, err.Error())
	}
	logPath := filepath.Join(p.Root, "server.log")
	logf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		fail("cannot open "+logPath, err.Error())
	}
	from, _ := logf.Seek(0, io.SeekEnd)
	fmt.Fprintf(logf, "\n--- %s launch\n", time.Now().Format(time.RFC3339))

	home, _ := os.UserHomeDir()
	cmd := exec.Command(exe, append([]string{"serve", "-no-open"}, args...)...)
	cmd.Dir = home // default working folder for new chats, unless -cwd is given
	cmd.Stdout, cmd.Stderr = logf, logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		fail("cannot start the server", err.Error())
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	deadline := time.After(30 * time.Second)
	for {
		if url, ok := findRunning(p, o.port); ok {
			if !o.noOpen {
				openBrowser(url)
			}
			return
		}
		select {
		case err := <-exited:
			fail("the server stopped while starting", fmt.Sprintf("%v\n\n%s", err, logTail(logPath, from)))
		case <-deadline:
			fail("the server did not answer within 30 seconds", "See "+logPath)
		case <-time.After(100 * time.Millisecond):
		}
	}
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

// fail reports a launch error on stderr and, since a Spotlight launch has no terminal, in an alert.
func fail(title, detail string) {
	fmt.Fprintf(os.Stderr, "AI Whiteboard: %s\n%s\n", title, detail)
	exec.Command("osascript",
		"-e", "on run argv",
		"-e", "display alert (item 1 of argv) message (item 2 of argv) as critical",
		"-e", "end run",
		"AI Whiteboard: "+title, detail).Run()
	os.Exit(1)
}
