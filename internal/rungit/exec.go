package rungit

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// grace is what a process group gets between SIGTERM and SIGKILL when it has to end.
	grace = 2 * time.Second
	// settle is how long a git command that may be writing is left to finish by itself when it has
	// to end. Git removes its lock files when a signal ends it, but not one it had just created:
	// a SIGTERM in that moment leaves an index.lock or a ref's lock behind, and the next command
	// there fails. A command that is still running after settle hangs (in a hook, as a rule) and
	// is ended like any other; what it may leave is for clearStale.
	settle = 2 * time.Second
	// pipeDelay is how long the output of a command is still read after the command exited: a
	// process it left in the background may hold the pipe open for ever.
	pipeDelay = 2 * time.Second
	// maxErrText clips the text of git that an Error carries.
	maxErrText = 2000
)

// Error is a git command that failed.
type Error struct {
	Cmd    string // the subcommand: "merge", "worktree add"
	Dir    string // where it ran
	Code   int    // its exit code; -1 when it did not exit by itself
	Output string // its stderr (its stdout when stderr is empty), trimmed and clipped
	Err    error  // why it did not run to its end: the context's error or a start failure; else nil
}

func (e *Error) Error() string {
	s := "git " + e.Cmd
	switch {
	case e.Err != nil:
		s += " in " + e.Dir + ": " + e.Err.Error()
	case e.Code >= 0:
		s += fmt.Sprintf(" failed in %s (exit %d)", e.Dir, e.Code)
	default:
		s += " in " + e.Dir + " was ended by a signal"
	}
	if e.Output != "" {
		s += ":\n" + e.Output
	}
	return s
}

func (e *Error) Unwrap() error { return e.Err }

// exitCode is the exit code of the git command behind err, or -1.
func exitCode(err error) int {
	var ge *Error
	if errors.As(err, &ge) && ge.Err == nil {
		return ge.Code
	}
	return -1
}

// elsewhere are the variables that point git at a repository other than the one of the folder it
// runs in. The server may have inherited them (when it was started from a git hook, say).
var elsewhere = []string{"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX"}

// baseEnv is the environment of the server without the variables in elsewhere.
func baseEnv() []string {
	var env []string
next:
	for _, kv := range os.Environ() {
		for _, name := range elsewhere {
			if strings.HasPrefix(kv, name+"=") {
				continue next
			}
		}
		env = append(env, kv)
	}
	return env
}

// gitEnv is the environment of every git command: the server's, made non-interactive, then extra.
// Optional locks are off so that a command which only looks (status, diff) never holds the index
// lock at the moment an agent's own git command in the same work tree needs it.
func gitEnv(extra []string) []string {
	env := append(baseEnv(), "GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=true", "GIT_MERGE_AUTOEDIT=no", "GIT_OPTIONAL_LOCKS=0")
	return append(env, extra...)
}

// withConfig is env with one more setting of git's config for the commands that run with it. It
// wins over what the config files say and is added to the settings env passes the same way
// already (GIT_CONFIG_COUNT, git 2.31 or newer; an older git does not look at it).
func withConfig(env []string, key, value string) []string {
	n := 0
	for _, kv := range env { // the last one counts, as for the command
		if v, ok := strings.CutPrefix(kv, "GIT_CONFIG_COUNT="); ok {
			if n, _ = strconv.Atoi(v); n < 0 {
				n = 0
			}
		}
	}
	return append(env[:len(env):len(env)], fmt.Sprintf("GIT_CONFIG_KEY_%d=%s", n, key),
		fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", n, value), fmt.Sprintf("GIT_CONFIG_COUNT=%d", n+1))
}

// noHooks is env for commands that must not run the hooks of the repository: git looks for them
// where there are none.
func noHooks(env []string) []string { return withConfig(env, "core.hooksPath", os.DevNull) }

// gitVersions has the version of git, major and minor, by the path of the program: it is asked
// once, not per Repo or per call.
var gitVersions sync.Map

// gitAtLeast reports whether the git that the package runs is of the version major.minor or
// newer. A version that cannot be read counts as older.
func (r *Repo) gitAtLeast(ctx context.Context, major, minor int) (bool, error) {
	path, _ := exec.LookPath("git") // what exec.Command runs
	v, ok := gitVersions.Load(path)
	if !ok {
		out, err := r.run(ctx, r.root, "version")
		if err != nil {
			return false, err
		}
		v = parseVersion(out)
		gitVersions.Store(path, v)
	}
	have := v.([2]int)
	return have[0] > major || (have[0] == major && have[1] >= minor), nil
}

// parseVersion reads "git version 2.50.1 (Apple Git-155)": {2, 50}. What it cannot read is {0, 0}.
func parseVersion(out string) [2]int {
	var v [2]int
	fields := strings.Fields(out)
	if len(fields) < 3 || fields[0] != "git" || fields[1] != "version" {
		return v
	}
	parts := strings.SplitN(fields[2], ".", 3)
	if len(parts) < 2 {
		return v
	}
	major, err1 := strconv.Atoi(parts[0])
	minor, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return v
	}
	return [2]int{major, minor}
}

// run runs git in dir and returns its trimmed stdout. A failure is an *Error.
func (r *Repo) run(ctx context.Context, dir string, args ...string) (string, error) {
	out, _, err := runGit(ctx, r.env, dir, args...)
	return out, err
}

// runZ runs a git command that prints a list with -z and returns the entries.
func (r *Repo) runZ(ctx context.Context, dir string, args ...string) ([]string, error) {
	out, _, err := runRaw(ctx, r.env, dir, args...)
	list := []string{}
	for _, s := range strings.Split(out, "\x00") {
		if s != "" {
			list = append(list, s)
		}
	}
	return list, err
}

// runGit runs git in dir with env and returns its trimmed stdout and stderr. A failure is an *Error.
func runGit(ctx context.Context, env []string, dir string, args ...string) (stdout, stderr string, err error) {
	stdout, stderr, err = runRaw(ctx, env, dir, args...)
	return strings.TrimSpace(stdout), strings.TrimSpace(stderr), err
}

// runRaw is runGit with the output as git wrote it.
func runRaw(ctx context.Context, env []string, dir string, args ...string) (stdout, stderr string, err error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = env
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if g := guardOf(ctx); g != nil {
		cmd.ExtraFiles = []*os.File{g} // see guard: the command and what it starts hold the flock
	}
	wait := settle
	if readOnly[subcommand(args)] {
		wait = 0
	}
	err = runGroup(ctx, cmd, wait)
	stdout, stderr = out.String(), errb.String()
	if err == nil {
		return stdout, stderr, nil
	}
	text := strings.TrimSpace(stderr)
	if text == "" {
		text = strings.TrimSpace(stdout)
	}
	e := &Error{Cmd: subcommand(args), Dir: dir, Code: -1, Output: clip(text, maxErrText)}
	var xe *exec.ExitError
	if errors.As(err, &xe) {
		e.Code = xe.ExitCode()
	} else {
		e.Err = err
	}
	return stdout, stderr, e
}

// subcommand names the git command in args: "merge", "worktree add".
func subcommand(args []string) string {
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "-c":
			i++
		case strings.HasPrefix(args[i], "-"):
		case args[i] == "worktree" && i+1 < len(args):
			return "worktree " + args[i+1]
		default:
			return args[i]
		}
	}
	return ""
}

// readOnly are the git commands of the package that only read and can take long in a large
// repository: they are ended at once when the context is done. Every other command may hold a
// lock file and gets settle to finish.
var readOnly = map[string]bool{"diff": true, "status": true, "log": true, "cat-file": true, "ls-files": true,
	"rev-parse": true, "show-ref": true, "for-each-ref": true, "merge-base": true, "worktree list": true,
	"merge-tree": true, "version": true}

// clip keeps the end of s, where git says what went wrong.
func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return "…" + strings.ToValidUTF8(s[len(s)-max:], "")
}

// runGroup runs cmd as the leader of a process group of its own and waits for it, as
// internal/agent does for agents. When ctx is done first, the command gets wait to finish by
// itself (0: none); then the whole group gets SIGTERM, then SIGKILL if something is left after
// grace. The error is the context's, unless the command still ended well.
func runGroup(ctx context.Context, cmd *exec.Cmd, wait time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = pipeDelay
	if err := cmd.Start(); err != nil {
		return err
	}
	pgid := cmd.Process.Pid
	exited, ended := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(ended)
		select {
		case <-exited:
			return
		case <-ctx.Done():
		}
		if wait > 0 {
			t := time.NewTimer(wait)
			defer t.Stop()
			select {
			case <-exited:
				return
			case <-t.C:
			}
		}
		select {
		case <-exited:
		default:
			endGroup(pgid)
		}
	}()
	err := cmd.Wait()
	close(exited)
	<-ended
	if errors.Is(err, exec.ErrWaitDelay) { // it exited with 0; something it started holds its output
		err = nil
	}
	if err != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// endGroup ends the process group pgid: SIGTERM, then SIGKILL to what is still there after grace.
func endGroup(pgid int) {
	if syscall.Kill(-pgid, syscall.SIGTERM) != nil {
		return
	}
	if !groupGone(pgid, grace) {
		syscall.Kill(-pgid, syscall.SIGKILL)
		groupGone(pgid, time.Second)
	}
}

// groupGone waits up to wait for the process group pgid to be empty and reports whether it is.
func groupGone(pgid int, wait time.Duration) bool {
	for deadline := time.Now().Add(wait); ; time.Sleep(10 * time.Millisecond) {
		if errors.Is(syscall.Kill(-pgid, 0), syscall.ESRCH) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
	}
}
