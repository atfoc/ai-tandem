// Package aliasestest has fakes of what the accounts service (package aliases) depends on:
// Docker, the chat manager, an account's Claude Code, and the stream it broadcasts on. No real
// Docker and no real Claude is used.
package aliasestest

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/container"
)

var _ aliases.Containers = (*Containers)(nil)

// box is one fake container.
type box struct {
	state container.State // StateStopped or StateRunning
	spec  container.Spec
}

// watcher is one running Watch call: the answers it has yet to report.
type watcher struct {
	queue  []error
	signal chan struct{}
}

// Containers is a fake aliases.Containers. Its zero value is not usable: use NewContainers.
type Containers struct {
	mu        sync.Mutex
	avail     error
	boxes     map[string]*box
	building  map[string]bool
	createErr error
	startErr  error
	block     chan struct{} // non-nil while Ensure is blocked
	imgBlock  chan struct{} // non-nil while EnsureImage is blocked
	imageErr  error
	calls     []string
	execs     []container.ExecOptions
	kills     []string
	program   func(alias string, o container.ExecOptions) *exec.Cmd
	watchers  map[*watcher]struct{}
}

// NewContainers returns a fake Docker that is usable and has no containers.
func NewContainers() *Containers {
	return &Containers{
		boxes:    map[string]*box{},
		building: map[string]bool{},
		watchers: map[*watcher]struct{}{},
	}
}

func errText(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	return err.Error(), true
}

func sameAnswer(a, b error) bool {
	ta, oka := errText(a)
	tb, okb := errText(b)
	return oka == okb && ta == tb
}

// SetAvailable sets what Available and Refresh answer: nil means Docker is usable. A change of
// the answer is reported to every running Watch call.
func (f *Containers) SetAvailable(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if sameAnswer(f.avail, err) {
		f.avail = err
		return
	}
	f.avail = err
	for w := range f.watchers {
		w.queue = append(w.queue, err)
		select {
		case w.signal <- struct{}{}:
		default:
		}
	}
}

// SetState puts the account's container in state st, as if it was made from spec (its spec
// label is spec.Hash()). StateNone removes it.
func (f *Containers) SetState(alias string, st container.State, spec container.Spec) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if st == container.StateNone || st == "" {
		delete(f.boxes, alias)
		return
	}
	spec.Alias = alias
	f.boxes[alias] = &box{state: st, spec: spec}
}

// State is the state of the account's container.
func (f *Containers) State(alias string) container.State {
	f.mu.Lock()
	defer f.mu.Unlock()
	if b := f.boxes[alias]; b != nil {
		return b.state
	}
	return container.StateNone
}

// Spec is the spec the account's current container was made from; false when there is none.
func (f *Containers) Spec(alias string) (container.Spec, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if b := f.boxes[alias]; b != nil {
		return b.spec, true
	}
	return container.Spec{}, false
}

// SetBuilding sets what Building(image) answers.
func (f *Containers) SetBuilding(image string, on bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.building[image] = on
}

// FailCreate makes every create (Ensure's or Recreate's) fail with err, until FailCreate(nil).
func (f *Containers) FailCreate(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createErr = err
}

// FailStart makes the start after every create (Ensure's or Recreate's) fail with err, until
// FailStart(nil): the container is left made from the spec, stopped, as Docker leaves it when a
// mount is refused at the start ("mounts denied"). Ensure then answers created true with the error,
// as container.Manager.Ensure does.
func (f *Containers) FailStart(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.startErr = err
}

// BlockEnsure makes Ensure calls wait until release is called (or their ctx ends). release may
// be called more than once.
func (f *Containers) BlockEnsure() (release func()) {
	ch := make(chan struct{})
	f.mu.Lock()
	f.block = ch
	f.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			f.mu.Lock()
			if f.block == ch {
				f.block = nil
			}
			f.mu.Unlock()
			close(ch)
		})
	}
}

// BlockImage makes EnsureImage calls wait until release is called (or their ctx ends), with
// Building(image) true for the image waited on meanwhile, as a slow build or pull. release may be
// called more than once.
func (f *Containers) BlockImage() (release func()) {
	ch := make(chan struct{})
	f.mu.Lock()
	f.imgBlock = ch
	f.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			f.mu.Lock()
			if f.imgBlock == ch {
				f.imgBlock = nil
			}
			f.mu.Unlock()
			close(ch)
		})
	}
}

// FailImage makes every EnsureImage fail with err, until FailImage(nil).
func (f *Containers) FailImage(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.imageErr = err
}

// EnsureImage records "image <image>" and waits while BlockImage holds it (Building(image) is true
// then); a ctx that ends first returns its error. It fails with the FailImage error, if any.
func (f *Containers) EnsureImage(ctx context.Context, image string) error {
	f.mu.Lock()
	if f.avail != nil {
		err := f.avail
		f.mu.Unlock()
		return err
	}
	f.record("image " + image)
	block := f.imgBlock
	if block != nil {
		f.building[image] = true
	}
	f.mu.Unlock()
	if block != nil {
		defer func() {
			f.mu.Lock()
			f.building[image] = false
			f.mu.Unlock()
		}()
		select {
		case <-block:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.imageErr
}

// Calls is every call made, in order, as "<method> <id>" ("kill <id> <runID>" for KillRun).
func (f *Containers) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

// Count is how many Calls start with prefix, e.g. "create a_x".
func (f *Containers) Count(prefix string) int {
	n := 0
	for _, c := range f.Calls() {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

// Execs is the options of every Exec call, in order.
func (f *Containers) Execs() []container.ExecOptions {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]container.ExecOptions(nil), f.execs...)
}

// Kills is the run id of every KillRun call, in order.
func (f *Containers) Kills() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.kills...)
}

// ExecProgram sets what Exec returns. By default it runs o.Argv on this computer, in o.Dir,
// with this process's environment and o.Env.
func (f *Containers) ExecProgram(fn func(alias string, o container.ExecOptions) *exec.Cmd) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.program = fn
}

func (f *Containers) record(call string) { f.calls = append(f.calls, call) }

func (f *Containers) info(alias string) container.Info {
	b := f.boxes[alias]
	if b == nil {
		return container.Info{Name: container.Name(alias), State: container.StateNone, Alias: alias}
	}
	return container.Info{
		Name:   container.Name(alias),
		State:  b.state,
		Alias:  alias,
		Spec:   b.spec.Hash(),
		Image:  b.spec.Image,
		Mounts: append([]string{b.spec.Dir}, b.spec.Mounts...),
	}
}

// create makes the account's container from spec and starts it, unless FailCreate is set.
func (f *Containers) create(spec container.Spec) error {
	f.record("create " + spec.Alias)
	if f.createErr != nil {
		return f.createErr
	}
	f.record("start " + spec.Alias)
	if f.startErr != nil {
		f.boxes[spec.Alias] = &box{state: container.StateStopped, spec: spec}
		return f.startErr
	}
	f.boxes[spec.Alias] = &box{state: container.StateRunning, spec: spec}
	return nil
}

// Available is the SetAvailable value.
func (f *Containers) Available() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.avail
}

// Refresh returns the SetAvailable value.
func (f *Containers) Refresh(ctx context.Context) error { return f.Available() }

// Watch waits until stop is closed, calling changed (no lock held) with each new answer that
// SetAvailable gives. every is ignored.
func (f *Containers) Watch(every time.Duration, stop <-chan struct{}, changed func(error)) {
	w := &watcher{signal: make(chan struct{}, 1)}
	f.mu.Lock()
	f.watchers[w] = struct{}{}
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		delete(f.watchers, w)
		f.mu.Unlock()
	}()
	for {
		select {
		case <-stop:
			return
		case <-w.signal:
		}
		f.mu.Lock()
		q := w.queue
		w.queue = nil
		f.mu.Unlock()
		for _, err := range q {
			select {
			case <-stop:
				return
			default:
			}
			changed(err)
		}
	}
}

// Inspect is the account's container; State StateNone, with only Name and Alias, when there is
// none.
func (f *Containers) Inspect(ctx context.Context, alias string) (container.Info, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.avail != nil {
		return container.Info{}, f.avail
	}
	f.record("inspect " + alias)
	return f.info(alias), nil
}

// Ensure follows container.Manager.Ensure: a running container is used as it is; a stopped one
// made from spec is started; else one is (re)created from spec and started (created true).
func (f *Containers) Ensure(ctx context.Context, spec container.Spec) (container.Info, bool, error) {
	f.mu.Lock()
	if f.avail != nil {
		err := f.avail
		f.mu.Unlock()
		return container.Info{}, false, err
	}
	id := spec.Alias
	f.record("ensure " + id)
	block := f.block
	f.mu.Unlock()
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return container.Info{}, false, ctx.Err()
		}
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if f.avail != nil {
		return container.Info{}, false, f.avail
	}
	b := f.boxes[id]
	switch {
	case b != nil && b.state == container.StateRunning:
		return f.info(id), false, nil
	case b != nil && b.spec.Hash() == spec.Hash():
		f.record("start " + id)
		if f.startErr != nil {
			return f.info(id), false, f.startErr
		}
		b.state = container.StateRunning
		return f.info(id), false, nil
	}
	if err := f.create(spec); err != nil {
		if f.boxes[id] != nil {
			return f.info(id), true, err // made, not started
		}
		return container.Info{}, false, err
	}
	return f.info(id), true, nil
}

// Recreate removes the account's container and creates and starts a new one from spec. When
// the create fails (FailCreate) the old container is gone all the same.
func (f *Containers) Recreate(ctx context.Context, spec container.Spec) (container.Info, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.avail != nil {
		return container.Info{}, f.avail
	}
	id := spec.Alias
	f.record("recreate " + id)
	delete(f.boxes, id)
	if err := f.create(spec); err != nil {
		if f.boxes[id] != nil {
			return f.info(id), err // made, not started
		}
		return container.Info{}, err
	}
	return f.info(id), nil
}

// Stop stops the account's container. None, or a stopped one, is no error.
func (f *Containers) Stop(ctx context.Context, alias string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.avail != nil {
		return f.avail
	}
	f.record("stop " + alias)
	if b := f.boxes[alias]; b != nil {
		b.state = container.StateStopped
	}
	return nil
}

// Remove deletes the account's container. None is no error.
func (f *Containers) Remove(ctx context.Context, alias string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.avail != nil {
		return f.avail
	}
	f.record("remove " + alias)
	delete(f.boxes, alias)
	return nil
}

// Exec records o and returns the ExecProgram command, not started. When Docker is unavailable
// the command's Err is that error, so starting it fails with it.
func (f *Containers) Exec(alias string, o container.ExecOptions) *exec.Cmd {
	f.mu.Lock()
	avail := f.avail
	program := f.program
	if avail == nil {
		f.record("exec " + alias)
		f.execs = append(f.execs, o)
	}
	f.mu.Unlock()
	var cmd *exec.Cmd
	if program != nil {
		cmd = program(alias, o)
	} else {
		cmd = defaultProgram(o)
	}
	if avail != nil {
		cmd.Err = avail
	}
	return cmd
}

func defaultProgram(o container.ExecOptions) *exec.Cmd {
	if len(o.Argv) == 0 {
		cmd := exec.Command("true")
		cmd.Err = os.ErrInvalid
		return cmd
	}
	cmd := exec.Command(o.Argv[0], o.Argv[1:]...)
	cmd.Dir = o.Dir
	cmd.Env = append(os.Environ(), o.Env...)
	return cmd
}

// KillRun records the run id. A missing container is no error; an unavailable Docker is.
func (f *Containers) KillRun(ctx context.Context, alias, runID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.avail != nil {
		return f.avail
	}
	f.record("kill " + alias + " " + runID)
	f.kills = append(f.kills, runID)
	return nil
}

// Building is the SetBuilding value.
func (f *Containers) Building(image string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.building[image]
}
