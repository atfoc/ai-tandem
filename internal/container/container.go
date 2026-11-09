// Package container talks to Docker through its command-line program (the -docker flag): whether
// Docker can be used now, the one long-running container of each Claude account (inspect, create,
// start, stop, remove, recreate), the commands that run in it, the kill of a tagged run in it, and
// the images: the default one, built on this machine when first needed, and any other, pulled.
//
// It knows nothing of accounts beyond their ids and the Spec it is handed (internal/aliases owns
// the accounts), and nothing of Claude (internal/claude runs it through an agent.Runner).
//
// The docker command lines it runs are listed in run.go; docker.go runs them and tells why
// Docker cannot be used; image.go builds the default image from image/Dockerfile, or pulls
// another image, when it is missing.
package container

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"ai-whiteboard/internal/version"
)

// NamePrefix starts the name of every container of the app: NamePrefix + the account's id.
const NamePrefix = "aiwb-alias-"

// The labels every container of the app carries.
const (
	LabelAlias = "aiwb.alias" // the account's id
	LabelSpec  = "aiwb.spec"  // Spec.Hash of what it was created with
)

// DefaultImageRepo is the repository of the default image, which is tagged with the app's version.
const DefaultImageRepo = "aiwb/claude"

// Name is the container name of the account id.
func Name(alias string) string { return NamePrefix + alias }

// DefaultImage is the default image of this version of the app: aiwb/claude:<version>.
func DefaultImage() string { return DefaultImageRepo + ":" + version.Version }

// State is where an account's container is.
type State string

const (
	StateNone    State = "none"    // there is no container of the account
	StateStopped State = "stopped" // created or exited, not running
	StateRunning State = "running"
)

// Spec is what an account's container is created with.
type Spec struct {
	Alias  string   // the account's id
	Image  string   // the image; never "" (the caller resolves "" to DefaultImage())
	Dir    string   // the account's folder on the host (<data>/aliases/<id>), mounted at the same path
	Mounts []string // the folders chosen for the account, each mounted at the same path
	// User is "uid:gid" the container's processes run as ("" = the image's own user), so that what
	// they write in a mounted folder belongs to the person.
	User string
}

// Hash names what a container made from s is: the same for the same image, folder, user and set
// of mounts (their order and a trailing slash do not count). It is the container's LabelSpec, so
// that a container found after a restart can be told apart from what the account wants now.
func (s Spec) Hash() string {
	mounts := make([]string, len(s.Mounts))
	for i, m := range s.Mounts {
		mounts[i] = filepath.Clean(m)
	}
	slices.Sort(mounts)
	mounts = slices.Compact(mounts)
	h := sha256.Sum256([]byte(strings.Join(append([]string{s.Image, filepath.Clean(s.Dir), s.User}, mounts...), "\x00")))
	return hex.EncodeToString(h[:6])
}

// Info is what Docker says of an account's container.
type Info struct {
	Name   string
	State  State
	Alias  string   // its LabelAlias
	Spec   string   // its LabelSpec ("" for a container that has none)
	Image  string   // the image it was created from, as it was named
	Mounts []string // the host paths of its bind mounts, the account's folder included
}

// Why Docker cannot be used: the Kind of an *Unavailable.
const (
	NotInstalled = "not_installed" // the docker program is not found
	NotRunning   = "not_running"   // the program is there and its daemon does not answer (in time)
	Unsupported  = "unsupported"   // this server's system cannot run the accounts (Windows)
	Failed       = "failed"        // Docker answered with an error that is none of the above
)

// Unavailable says why Docker cannot be used now. Its Reason is the sentence people read:
// "Docker is not installed", "Docker is not running", or Docker's own error line.
type Unavailable struct {
	Kind   string
	Reason string
}

func (u *Unavailable) Error() string { return u.Reason }

// IsUnavailable reports whether err says that Docker cannot be used, and returns it.
func IsUnavailable(err error) (*Unavailable, bool) {
	var u *Unavailable
	ok := errors.As(err, &u)
	return u, ok
}

// QuickTimeout is the time limit of a call to Docker that should answer at once (version,
// inspect, start, kill): a daemon that does not answer in it counts as not running.
const QuickTimeout = 5 * time.Second

// Manager is this server's Docker. Its methods may be called from any goroutine. Its zero value
// with only Bin set is ready to use; it must not be copied once used.
//
// The calls of one account wait for one another where they change its container (Ensure,
// Recreate, Stop, Remove: one lock per account), and are not held while a command runs in it.
type Manager struct {
	Bin string // the docker program, as the -docker flag names it; "" = "docker"
	// Timeout is the time limit of the quick calls (version, inspect, ps, start, image inspect,
	// the kill of a run; stop gets 3 s more); 0 = QuickTimeout. Tests make it short.
	Timeout time.Duration

	mu       sync.Mutex
	looked   bool         // a call to Docker has told whether it can be used
	avail    *Unavailable // what it told (nil: it can)
	watchers map[chan struct{}]struct{}
	locks    map[string]*sync.Mutex // the accounts' locks
	images   map[string]*imageFlight
}

// inspectJSON is the part of `docker inspect` the Manager reads.
type inspectJSON struct {
	Name  string
	State struct {
		Status string
	}
	Config struct {
		Image  string
		Labels map[string]string
	}
	Mounts []struct {
		Type   string
		Source string
	}
}

func (c inspectJSON) info() Info {
	i := Info{
		Name:   strings.TrimPrefix(c.Name, "/"),
		Alias:  c.Config.Labels[LabelAlias],
		Spec:   c.Config.Labels[LabelSpec],
		Image:  c.Config.Image,
		Mounts: []string{},
	}
	switch c.State.Status {
	case "running", "restarting", "paused":
		i.State = StateRunning
	default:
		i.State = StateStopped
	}
	for _, mt := range c.Mounts {
		if mt.Type == "bind" {
			i.Mounts = append(i.Mounts, mt.Source)
		}
	}
	return i
}

// inspect is `docker inspect` of the containers named or ids: the ones Docker has (those it does
// not are left out).
func (m *Manager) inspect(ctx context.Context, names ...string) ([]Info, error) {
	out, err := m.docker(ctx, true, nil, append([]string{"inspect", "--type", "container"}, names...)...)
	if err != nil && !hasLine(err, "No such container") {
		return nil, err
	}
	var cs []inspectJSON
	if len(bytes.TrimSpace(out)) > 0 {
		if jerr := json.Unmarshal(out, &cs); jerr != nil {
			return nil, &Error{Op: "inspect", Line: "docker inspect printed what is not its JSON: " + jerr.Error()}
		}
	}
	infos := make([]Info, 0, len(cs))
	for _, c := range cs {
		infos = append(infos, c.info())
	}
	return infos, nil
}

// Inspect is the account's container as Docker has it; State StateNone when there is none.
func (m *Manager) Inspect(ctx context.Context, alias string) (Info, error) {
	infos, err := m.inspect(ctx, Name(alias))
	if err != nil {
		return Info{}, err
	}
	for _, i := range infos {
		if i.Name == Name(alias) {
			return i, nil
		}
	}
	return Info{Name: Name(alias), State: StateNone}, nil
}

// List is every container of the app (those with a LabelAlias), whatever their state.
func (m *Manager) List(ctx context.Context) ([]Info, error) {
	out, err := m.docker(ctx, true, nil, "ps", "-a", "-q", "--no-trunc", "--filter", "label="+LabelAlias)
	if err != nil {
		return nil, err
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		return []Info{}, nil
	}
	return m.inspect(ctx, ids...)
}

func checkSpec(spec Spec) error {
	switch {
	case spec.Alias == "":
		return errors.New("container: the spec has no account id")
	case spec.Image == "":
		return errors.New("container: the spec has no image")
	case spec.Dir == "":
		return errors.New("container: the spec has no account folder")
	}
	return nil
}

// Ensure makes the account's container run and returns it: a running one is used as it is, even
// when it was made from another spec (the change waits for a restart); a stopped one made from
// spec is started; a stopped one made from another spec, or none, is (re)created from spec and
// started. created says it was (re)created from spec, so the caller records spec as applied; it
// is also true, with the error, when the start after a (re)create failed (the container left is
// made from spec, and the next Ensure only starts it).
// When a container is about to be created, spec's image is made sure of first (EnsureImage: the
// default image is built, another one pulled, when it is not there), under the account's lock; a
// caller that holds a lock of its own calls EnsureImage before, without it, so that this is one
// quick look. A running or a same-spec stopped container never calls Docker about the image.
// A create or start that Docker refuses returns Docker's line (an *Error).
func (m *Manager) Ensure(ctx context.Context, spec Spec) (info Info, created bool, err error) {
	if err := checkSpec(spec); err != nil {
		return Info{}, false, err
	}
	defer m.lock(spec.Alias)()
	info, err = m.Inspect(ctx, spec.Alias)
	if err != nil {
		return Info{}, false, err
	}
	switch {
	case info.State == StateRunning:
		return info, false, nil
	case info.State == StateStopped && info.Spec == spec.Hash():
		if err := m.start(ctx, spec.Alias); err != nil {
			return info, false, err
		}
		info, err = m.Inspect(ctx, spec.Alias)
		return info, false, err
	}
	// The image is made sure of only now, for a container about to be created: a running
	// container, or a stopped one of the same spec, is used without waiting on a build or pull
	// (after an update of the app, the new version's image is built when the container is next
	// recreated).
	if err := m.EnsureImage(ctx, spec.Image); err != nil {
		return info, false, err
	}
	if info.State == StateStopped {
		if err := m.rm(ctx, spec.Alias); err != nil {
			return info, false, err
		}
	}
	info, err = m.createStart(ctx, spec)
	return info, err == nil || info.State != StateNone, err
}

// createStart creates the container from spec and starts it (the account's lock held).
func (m *Manager) createStart(ctx context.Context, spec Spec) (Info, error) {
	if _, err := m.docker(ctx, false, nil, CreateArgs(spec)...); err != nil {
		return Info{Name: Name(spec.Alias), State: StateNone}, err
	}
	if err := m.start(ctx, spec.Alias); err != nil {
		return Info{Name: Name(spec.Alias), State: StateStopped, Alias: spec.Alias, Spec: spec.Hash(), Image: spec.Image}, err
	}
	return m.Inspect(ctx, spec.Alias)
}

func (m *Manager) start(ctx context.Context, alias string) error {
	_, err := m.docker(ctx, true, nil, "start", Name(alias))
	return err
}

// rm is `docker rm -f`: no container is no error.
func (m *Manager) rm(ctx context.Context, alias string) error {
	_, err := m.docker(ctx, true, nil, "rm", "-f", Name(alias))
	if hasLine(err, "No such container") {
		return nil
	}
	return err
}

// Recreate stops and removes the account's container, if there is one, and creates and starts a
// new one from spec. The account's folder is a mount, so nothing in it is lost. What runs in the
// old container is ended with it; the caller decides beforehand whether that may be. Spec's image
// is made sure of first (EnsureImage), under the account's lock, before the old container is
// removed: a build or pull that fails leaves it as it was. As with Ensure, a caller that holds a
// lock of its own calls EnsureImage before, without it.
func (m *Manager) Recreate(ctx context.Context, spec Spec) (Info, error) {
	if err := checkSpec(spec); err != nil {
		return Info{}, err
	}
	defer m.lock(spec.Alias)()
	if err := m.EnsureImage(ctx, spec.Image); err != nil {
		return Info{}, err
	}
	if err := m.rm(ctx, spec.Alias); err != nil {
		return Info{}, err
	}
	return m.createStart(ctx, spec)
}

// Stop stops the account's container (what runs in it ends). No container, or a stopped one, is
// no error.
func (m *Manager) Stop(ctx context.Context, alias string) error {
	defer m.lock(alias)()
	_, err := m.docker(ctx, true, nil, "stop", "-t", "3", Name(alias))
	if hasLine(err, "No such container") || hasLine(err, "is not running") {
		return nil
	}
	return err
}

// Remove stops and removes the account's container. No container is no error. The account's
// folder is the caller's to delete.
func (m *Manager) Remove(ctx context.Context, alias string) error {
	defer m.lock(alias)()
	return m.rm(ctx, alias)
}

// CreateArgs are the arguments of `docker create` for spec, after the program's name, starting
// with "create": --name, --init, the labels, the account's folder and every mount at the same
// path (and nothing else of the disk; each cleaned, a repeat or the account's folder again left
// out), --add-host host.docker.internal:host-gateway, --user when spec has one, "--" (so that an
// image such as "--privileged" is never taken as an option), the image and `sleep infinity`.
func CreateArgs(spec Spec) []string {
	dir := filepath.Clean(spec.Dir)
	args := []string{"create", "--name", Name(spec.Alias), "--init",
		"--label", LabelAlias + "=" + spec.Alias, "--label", LabelSpec + "=" + spec.Hash(),
		"-v", dir + ":" + dir}
	seen := map[string]bool{dir: true}
	for _, mt := range spec.Mounts {
		mt = filepath.Clean(mt)
		if seen[mt] {
			continue
		}
		seen[mt] = true
		args = append(args, "-v", mt+":"+mt)
	}
	args = append(args, "--add-host", "host.docker.internal:host-gateway")
	if spec.User != "" {
		args = append(args, "--user", spec.User)
	}
	return append(args, "--", spec.Image, "sleep", "infinity")
}

// ExecOptions is one command to run in an account's running container.
type ExecOptions struct {
	Dir   string   // its working folder, the same path as on the host
	Env   []string // "NAME=value", handed in with -e
	RunID string   // the run's tag (NewRunID): the process is started as a run that KillRun ends
	Argv  []string // the program and its arguments
	TTY   bool     // the program gets a pseudo-terminal inside the container (a login)
}

// Exec returns the `docker exec -i` command that runs o in the account's container, not started:
// the run wrapper there starts o.Argv in a new session and process group recorded under
// o.RunID, with AIWB_RUN=<RunID> in its environment, so that KillRun finds all of it. The command's
// own environment is this process's (DOCKER_HOST and the rest reach the docker program).
//
// With no RunID, o.Argv runs as it is, without the wrapper (so with no pseudo-terminal, even with
// TTY): KillRun cannot end it. On Windows the command fails at Start with the Unsupported
// *Unavailable, and when the docker program is not found, with the NotInstalled one (which
// Available then returns too).
func (m *Manager) Exec(alias string, o ExecOptions) *exec.Cmd {
	args := []string{"exec", "-i"}
	if o.Dir != "" {
		args = append(args, "-w", o.Dir)
	}
	for _, e := range o.Env {
		args = append(args, "-e", e)
	}
	if o.RunID != "" {
		args = append(args, "-e", "AIWB_RUN="+o.RunID)
	}
	args = append(args, Name(alias))
	switch {
	case o.RunID == "":
		args = append(args, o.Argv...)
	case o.TTY:
		args = append(append(args, "/bin/sh", "-c", RunScript, RunTTYName, shellQuote(o.Argv)), o.Argv...)
	default:
		args = append(append(args, "/bin/sh", "-c", RunScript, RunName), o.Argv...)
	}
	cmd := exec.Command(m.bin(), args...)
	cmd.Env = os.Environ()
	switch {
	case windows():
		cmd.Err = unavailable(errUnsupported)
	case cmd.Err != nil && errors.Is(cmd.Err, exec.ErrNotFound):
		cmd.Err = unavailable(errNotInstalled)
		m.setAvailable(unavailable(errNotInstalled))
	case cmd.Err == nil && strings.ContainsRune(m.bin(), filepath.Separator):
		if _, err := os.Stat(m.bin()); err != nil {
			cmd.Err = unavailable(errNotInstalled)
			m.setAvailable(unavailable(errNotInstalled))
		}
	}
	return cmd
}

// KillRun kills, inside the account's container, every process of the run runID: its process
// group, and every process that carries AIWB_RUN=<runID> (the shells it detached included). A run
// that has ended, or a container that is gone, is no error. It returns within QuickTimeout (the
// Manager's Timeout).
func (m *Manager) KillRun(ctx context.Context, alias, runID string) error {
	if runID == "" {
		return nil
	}
	_, err := m.docker(ctx, true, nil, "exec", Name(alias), "/bin/sh", "-c", KillScript, KillName, runID)
	if hasLine(err, "No such container") || hasLine(err, "is not running") {
		return nil
	}
	return err
}
