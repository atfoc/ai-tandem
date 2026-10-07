package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/store"
)

// ownCommand runs the commands that parse their own flags: remote (setup, status, off) and secret.
// ok is false for every other command, which main goes on to. code is the exit code: 0 done;
// 1 refused, failed or "the server will not start"; 2 usage.
func ownCommand(cmd string, args []string, stdout, stderr io.Writer) (code int, ok bool) {
	switch cmd {
	case "remote":
		return remoteCommand(args, stdout, stderr), true
	case "secret":
		return secretCommand(args, stdout, stderr), true
	}
	return 0, false
}

const remoteUsage = "usage: ai-whiteboard remote setup [-port N] [-name X]... [-server-port N] [-new-cert] | remote status [-server-port N] | remote off"

func remoteCommand(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, remoteUsage)
		return 2
	}
	switch sub, rest := args[0], args[1:]; sub {
	case "setup":
		return remoteSetup(rest, stdout, stderr)
	case "status":
		return remoteStatus(rest, stdout, stderr)
	case "off":
		return remoteOff(rest, stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown command %q (setup, status, off)\n%s\n", "remote "+sub, remoteUsage)
		return 2
	}
}

// ownFlags are the flags of one of these commands: its own set, with -home.
type ownFlags struct {
	*flag.FlagSet
	home       string
	serverPort int

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

// withServerPort adds -server-port: the server's own port, which the remote port must differ from.
func (f *ownFlags) withServerPort() {
	f.IntVar(&f.serverPort, "server-port", 0, "the server's own port (default: the running server's, else 4747)")
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
	if f.serverPort < 0 || f.serverPort > 65535 {
		fmt.Fprintf(stderr, "%s: -server-port %d is not between 1 and 65535\n", f.Name(), f.serverPort)
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

// ownPort is the server's own port for the check: -server-port, else the port in server.json,
// else 4747.
func (f *ownFlags) ownPort() int {
	if f.serverPort != 0 {
		return f.serverPort
	}
	if _, port, ok := store.ReadServerFile(store.NewPaths(f.root)); ok {
		return port
	}
	return 4747
}

// runningPort is where the running server of this data folder is looked for: -server-port when
// given, else the port in the folder's server.json, else 0 for nowhere. Never a default port,
// where the server of another data folder may answer.
func (f *ownFlags) runningPort() int {
	if f.serverPort != 0 {
		return f.serverPort
	}
	_, port, _ := store.ReadServerFile(store.NewPaths(f.root))
	return port
}

// ownServer asks the server on port for hello. ok only when it is this data folder's: its hello
// states the id in the folder's instance-id file, and its state names this folder as its data
// folder (a copy of a data folder carries the instance id and server.json of the original). A
// folder with no instance id has had no server of a build that states one, and nothing is asked.
// base ends in "/".
func (f *ownFlags) ownServer(port int) (base string, h helloReply, ok bool) {
	b, err := os.ReadFile(remote.FilesIn(f.root).InstanceID)
	id := strings.TrimSpace(string(b))
	if port <= 0 || err != nil || !remote.ValidID(id) {
		return "", h, false
	}
	base = fmt.Sprintf("http://127.0.0.1:%d", port)
	if h, ok = helloOf(httpClient(), base); !ok || h.InstanceID != id {
		return "", h, false
	}
	if dir, ok := dataDirOf(base); !ok || realPath(dir) != realPath(f.root) {
		return "", h, false
	}
	return base + "/", h, true
}

// dataDirOf asks the server at base (no "/" at its end) for its data folder: the dataDir of
// GET /api/state. ok is false for any answer that is not 200 with JSON that names one.
func dataDirOf(base string) (string, bool) {
	resp, err := httpClient().Get(base + "/api/state")
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", false
	}
	var st struct {
		DataDir string `json:"dataDir"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil || st.DataDir == "" {
		return "", false
	}
	return st.DataDir, true
}

// realPath is path with symlinks resolved, or cleaned when it cannot be resolved.
func realPath(path string) string {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return filepath.Clean(path)
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
	f.withServerPort()
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

	ownPort := f.ownPort()
	rep := remote.Check(f.root, ownPort, mcpPort())
	fmt.Fprintf(stdout, "Remote access is set up in %s.\n", f.root)
	printConfig(stdout, rep)
	fmt.Fprintf(stdout, "Server port: %d\n", ownPort)
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

// remoteStatusReply is a server's answer to GET /api/remote/status.
type remoteStatusReply struct {
	Listening   bool     `json:"listening"`
	Port        int      `json:"port"`
	Names       []string `json:"names"`
	Fingerprint string   `json:"fingerprint"`
	// SecretReloads counts the times the server read its secret again while it runs.
	SecretReloads int64 `json:"secretReloads"`
}

// remoteStatusOf asks the server at base (which ends in "/") for its remote status. ok is false
// for any answer that is not 200 with JSON: a server of an older build has no such route.
func remoteStatusOf(base string) (remoteStatusReply, bool) {
	var st remoteStatusReply
	resp, err := httpClient().Get(base + "api/remote/status")
	if err != nil {
		return st, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return st, false
	}
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		return st, false
	}
	return st, true
}

func remoteStatus(args []string, stdout, stderr io.Writer) int {
	f := newOwnFlags("remote status", stderr)
	f.withServerPort()
	if code, ok := f.parse(args, stderr); !ok {
		return code
	}
	port := f.ownPort()

	// A server counts only when it is this data folder's: one of another folder may answer on
	// the port, and its remote access is not this folder's.
	if base, _, ok := f.ownServer(f.runningPort()); !ok {
		fmt.Fprintln(stdout, "Running: no server")
	} else if st, ok := remoteStatusOf(base); !ok {
		fmt.Fprintln(stdout, "Running: older build, reported from the files alone")
	} else if !st.Listening {
		fmt.Fprintln(stdout, "Running: off")
	} else {
		fmt.Fprintln(stdout, "Running: listening")
		fmt.Fprintf(stdout, "Running port: %d\n", st.Port)
		fmt.Fprintf(stdout, "Running names: %s\n", strings.Join(st.Names, ", "))
		fmt.Fprintf(stdout, "Running fingerprint: %s\n", st.Fingerprint)
	}

	rep := remote.Check(f.root, port, mcpPort())
	switch {
	case !rep.Configured:
		fmt.Fprintln(stdout, "Files: not set up")
		return 0
	case rep.OK():
		fmt.Fprintln(stdout, "Files: the next start will listen")
	default:
		fmt.Fprintln(stdout, "Files: the server will not start")
	}
	printConfig(stdout, rep)
	printNotes(stdout, rep)
	return f.checkResult(rep, stderr)
}

func remoteOff(args []string, stdout, stderr io.Writer) int {
	f := newOwnFlags("remote off", stderr)
	if code, ok := f.parse(args, stderr); !ok {
		return code
	}
	was, err := remote.Off(f.root)
	if err != nil {
		fmt.Fprintf(stderr, "remote off: %v\n", err)
		return 1
	}
	if was {
		fmt.Fprintf(stdout, "Remote access is off in %s. A running server keeps it until its next start.\n", f.root)
	} else {
		fmt.Fprintf(stdout, "Remote access was not set up in %s.\n", f.root)
	}
	return 0
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
// and says on stderr when the new secret takes effect. It signals only a server found through
// this folder's server.json whose hello states this folder's instance id, whose data folder is
// this one, with a feature level with the reload and a pid, and that listens for remote access: never one on a default port, which
// may be another data folder's.
func announceNewSecret(f *ownFlags, stderr io.Writer) {
	_, port, _ := store.ReadServerFile(store.NewPaths(f.root))
	base, h, ok := f.ownServer(port)
	if !ok {
		fmt.Fprintln(stderr, nextStart)
		return
	}
	if h.FeatureLevel < 1 || h.Pid <= 0 {
		fmt.Fprintln(stderr, "The running server is of an older build and cannot read a secret while it runs. "+nextStart)
		return
	}
	before, ok := remoteStatusOf(base)
	if !ok || !before.Listening {
		fmt.Fprintln(stderr, "The running server has remote access off. "+nextStart)
		return
	}
	if err := syscall.Kill(h.Pid, syscall.SIGUSR1); err != nil {
		fmt.Fprintf(stderr, "The running server could not be told (%v). %s\n", err, nextStart)
		return
	}
	// The signal alone does not say that the old secret is refused: the server's count does.
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if st, ok := remoteStatusOf(base); ok && st.SecretReloads > before.SecretReloads {
			fmt.Fprintln(stderr, "The running server accepts the new secret only, from now on. Its API clients were disconnected and need the new secret.")
			return
		}
	}
	fmt.Fprintln(stderr, "The running server did not confirm the new secret. Restart it to be sure the old one is refused.")
}
