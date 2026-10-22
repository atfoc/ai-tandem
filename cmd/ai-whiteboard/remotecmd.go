package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/store"
)

// ownCommand runs the commands that parse their own flags: remote (setup), secret, status and
// stop. ok is false for every other command, which main goes on to. code is the exit code: 0 done;
// 1 refused, failed or "the server will not start"; 2 usage.
func ownCommand(cmd string, args []string, stdout, stderr io.Writer) (code int, ok bool) {
	switch cmd {
	case "remote":
		return remoteCommand(args, stdout, stderr), true
	case "secret":
		return secretCommand(args, stdout, stderr), true
	case "status":
		return statusCommand(args, stdout, stderr), true
	case "stop":
		return stopCommand(args, stdout, stderr), true
	}
	return 0, false
}

const remoteUsage = "usage: ai-whiteboard remote setup [-port N] [-name X]... [-new-cert] [-home DIR]"

// goneRemote is what "remote status" and "remote off" say: the first is "status" now, and the
// second has no replacement.
const goneRemote = `"remote status" is now "status"; "remote off" is gone: a server always serves its clients over HTTPS with the secret.`

func remoteCommand(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, remoteUsage)
		return 2
	}
	switch sub, rest := args[0], args[1:]; sub {
	case "setup":
		return remoteSetup(rest, stdout, stderr)
	case "status", "off":
		fmt.Fprintln(stderr, goneRemote)
		return 2
	default:
		fmt.Fprintf(stderr, "unknown command %q (setup)\n%s\n", "remote "+sub, remoteUsage)
		return 2
	}
}

// ownFlags are the flags of one of these commands: its own set, with -home.
type ownFlags struct {
	*flag.FlagSet
	home string

	// Set by parse.
	root    string // the data folder, absolute
	msgHome string // root when -home was given, else "": for the commands a message names
	exe     string // this binary's full path, symlinks resolved
}

func newOwnFlags(name string, stderr io.Writer) *ownFlags {
	f := &ownFlags{FlagSet: flag.NewFlagSet("ai-whiteboard "+name, flag.ContinueOnError)}
	f.SetOutput(stderr)
	f.StringVar(&f.home, "home", "~/.ai-whiteboard", "data folder")
	return f
}

// parse returns the exit code and false when the command must end: 2 for a usage error, 0 for -h.
func (f *ownFlags) parse(args []string, stderr io.Writer) (int, bool) {
	if err := f.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0, false
		}
		return 2, false
	}
	if f.NArg() > 0 {
		fmt.Fprintf(stderr, "%s: unexpected argument %q\n", f.Name(), f.Arg(0))
		return 2, false
	}
	home, _ := os.UserHomeDir()
	root, err := filepath.Abs(expand(f.home, home))
	if err != nil {
		fmt.Fprintf(stderr, "data folder: %v\n", err)
		return 1, false
	}
	f.root = root
	f.Visit(func(fl *flag.Flag) {
		if fl.Name == "home" {
			f.msgHome = root
		}
	})
	f.exe = exePath()
	return 0, true
}

// notSetUp is what a command says that needs a configuration and finds none.
func (f *ownFlags) notSetUp(stderr io.Writer) int {
	fmt.Fprintf(stderr, "Remote access is not set up: run %s\n", f.command("remote setup"))
	return 1
}

// command is a command line for a message, as the check's message writes them.
func (f *ownFlags) command(words string) string {
	s := fmt.Sprintf("%q %s", f.exe, words)
	if f.msgHome != "" {
		s += fmt.Sprintf(" -home %q", f.msgHome)
	}
	return s
}

// exePath is this binary's full path with symlinks resolved.
func exePath() string {
	exe, err := os.Executable()
	if err != nil {
		return "ai-whiteboard"
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	return exe
}

// nameList is the -name flag, which may be given more than once.
type nameList []string

func (n *nameList) String() string { return strings.Join(*n, ", ") }

func (n *nameList) Set(s string) error {
	if _, ok := remote.NormalName(s); !ok {
		return errors.New("not an IPv4 address or a DNS name (no port, no scheme)")
	}
	*n = append(*n, s)
	return nil
}

func remoteSetup(args []string, stdout, stderr io.Writer) int {
	f := newOwnFlags("remote setup", stderr)
	var o remote.SetupOptions
	f.IntVar(&o.Port, "port", 0, "the remote port (default: keep it, or 4748 at the first set-up)")
	f.Var((*nameList)(&o.Names), "name", "a name or IPv4 address clients reach this machine by (may be repeated)")
	f.BoolVar(&o.NewCert, "new-cert", false, "replace the key and the certificate")
	if code, ok := f.parse(args, stderr); !ok {
		return code
	}
	if o.Port < 0 || o.Port > 65535 {
		fmt.Fprintf(stderr, "%s: -port %d is not between 1 and 65535\n", f.Name(), o.Port)
		return 2
	}
	if _, err := remote.Setup(f.root, o); errors.Is(err, remote.ErrNotSetUp) {
		return f.notSetUp(stderr)
	} else if err != nil {
		fmt.Fprintf(stderr, "remote setup: %v\n", err)
		return 1
	}

	rep := remote.Check(f.root, mcpPort())
	fmt.Fprintf(stdout, "Remote access is set up in %s.\n", f.root)
	printConfig(stdout, rep)
	if rep.OK() {
		fmt.Fprintln(stdout, "Next start: will listen")
	} else {
		fmt.Fprintln(stdout, "Next start: the server will not start")
	}
	printNotes(stdout, rep)
	return f.checkResult(rep, stderr)
}

// printConfig prints what the files say: the port, the names, the certificate's fingerprint.
// A configuration that is not valid has no port and no names; a certificate that cannot be parsed
// has no fingerprint.
func printConfig(w io.Writer, rep remote.Report) {
	if rep.Config.Port != 0 {
		fmt.Fprintf(w, "Port: %d\n", rep.Config.Port)
	}
	if len(rep.Config.Names) > 0 {
		fmt.Fprintf(w, "Names: %s\n", strings.Join(rep.Config.Names, ", "))
	}
	if rep.Fingerprint != "" {
		fmt.Fprintf(w, "Fingerprint: %s\n", rep.Fingerprint)
	}
}

func printNotes(w io.Writer, rep remote.Report) {
	for _, n := range rep.Notes {
		fmt.Fprintf(w, "Note: %s\n", n)
	}
}

// checkResult writes the check's message to stderr and returns the exit code: 1 when the server
// will not start.
func (f *ownFlags) checkResult(rep remote.Report, stderr io.Writer) int {
	if rep.OK() {
		return 0
	}
	fmt.Fprintln(stderr, rep.Message(f.exe, f.msgHome))
	return 1
}

// secretCommand prints the secret, or with -new replaces it and prints the new one. It is the
// only command that prints the secret.
func secretCommand(args []string, stdout, stderr io.Writer) int {
	f := newOwnFlags("secret", stderr)
	fresh := f.Bool("new", false, "replace the secret and print the new one")
	if code, ok := f.parse(args, stderr); !ok {
		return code
	}
	if *fresh {
		s, err := remote.NewSecret(f.root)
		if errors.Is(err, remote.ErrNotSetUp) {
			return f.notSetUp(stderr)
		} else if err != nil {
			fmt.Fprintf(stderr, "secret -new: %v\n", err)
			return 1
		}
		fmt.Fprintln(stdout, s)
		announceNewSecret(f, stderr)
		return 0
	}

	s, err := remote.ReadSecret(f.root)
	switch {
	case errors.Is(err, remote.ErrNoSecret):
		fmt.Fprintf(stderr, "Remote access: %s\nTo repair: %s\n",
			strings.TrimPrefix(err.Error(), remote.ErrNoSecret.Error()+": "), f.command("remote setup"))
		return 1
	case err != nil:
		fmt.Fprintf(stderr, "Remote access: %s\nTo repair: %s\n",
			strings.TrimPrefix(err.Error(), remote.ErrBadSecret.Error()+": "), f.command("secret -new"))
		return 1
	}
	fmt.Fprintln(stdout, s)
	return 0
}

const nextStart = "The new secret takes effect at the server's next start."

// announceNewSecret tells the running server of this data folder to read the new secret (SIGUSR1),
// and says on stderr when the new secret takes effect. It signals only the server findRunning finds
// for this folder, with a feature level that has the reload and a pid, and that listens for
// clients: this build's through the control socket, the build before's through its loopback port.
func announceNewSecret(f *ownFlags, stderr io.Writer) {
	run, ok := findRunning(store.NewPaths(f.root))
	if !ok {
		fmt.Fprintln(stderr, nextStart)
		return
	}
	if run.hello.FeatureLevel < 1 || run.hello.Pid <= 0 {
		fmt.Fprintln(stderr, "The running server is of an older build and cannot read a secret while it runs. "+nextStart)
		return
	}
	// reloads is how many times the running server read its secret again, and ok is false when it
	// cannot say or does not listen for clients.
	reloads := func() (int64, bool) {
		if run.build == olderBuild {
			st, ok := legacyRemote(run.legacy)
			return st.SecretReloads, ok && st.Listening
		}
		st, ok := run.statusOf()
		return st.Client.SecretReloads, ok && st.Client.Listening
	}
	if !reloadSupported {
		fmt.Fprintln(stderr, "On this system a running server reads a new secret only when it is restarted. "+nextStart)
		return
	}
	before, ok := reloads()
	if !ok {
		fmt.Fprintln(stderr, "The running server does not listen for clients. "+nextStart)
		return
	}
	if err := signalReload(run.hello.Pid); err != nil {
		fmt.Fprintf(stderr, "The running server could not be told (%v). %s\n", err, nextStart)
		return
	}
	// The signal alone does not say that the old secret is refused: the server's count does.
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if n, ok := reloads(); ok && n > before {
			fmt.Fprintln(stderr, "The running server accepts the new secret only, from now on. Its clients were disconnected and need the new secret.")
			return
		}
	}
	fmt.Fprintln(stderr, "The running server did not confirm the new secret. Restart it to be sure the old one is refused.")
}
