package aliases

import (
	"context"
	"errors"
	"log"
	"os"
	"slices"
	"sync"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/model"
)

// Time limits of the Docker calls that may take longer than container.QuickTimeout.
const (
	// stopTimeout bounds a stop or a remove of a container (Docker waits for its processes).
	stopTimeout = time.Minute
)

// Service is the Claude accounts of a server: their records, their containers, their logins,
// and what the client API, the chat manager and the agent list ask of them. Its methods may be
// called from any goroutine.
//
// Locks: mu guards the runtime state (held briefly, never while Docker, Claude, Work,
// Broadcast or Changed is called). Each account has an op lock, held while its container is
// inspected or changed (ensure, recreate, stop, remove) and while its record is written over,
// never while a claude process runs, never while an image is built or pulled (that is done
// before the lock is taken: EnsureImage), and never while Work is called (the chat manager may be
// waiting on an ensure of the same account while it holds its own lock).
//
// A chat's process is started with the chat's lock held, so its runner bounds its wait for the
// container to Waits.Run (ensureQuick) and answers ErrPreparing past it; the chat manager makes
// the container ready beforehand, with no lock held, through Prepare.
//
// While Restart, Edit or Stop ends an account's processes and recreates or stops its container,
// the account is marked restarting (whileRestarting): Check and the chats' runner refuse new runs
// with ErrRestarting, so that none starts in the old container to be killed a moment later.
type Service struct {
	o        Options
	root     string
	store    Store
	cont     Containers
	claudeFn func(a Alias, sp *claude.Spawner) Claude
	waits    Waits
	logf     func(format string, args ...any)

	// base is cancelled by Shutdown: background refreshes run under it.
	base   context.Context
	cancel context.CancelFunc
	bg     sync.WaitGroup // the background goroutines

	mu         sync.Mutex
	work       Work
	rt         map[string]*entry        // per account id
	ops        map[string]chan struct{} // per account id: the op locks (a token in a channel of 1)
	host       Login                    // the computer's own Claude Code, as auth status last said
	checked    time.Time                // when the last full refresh (containers and logins) ended
	refreshing bool                     // a full refresh runs now
	closed     bool                     // Shutdown was called
	runSeq     uint64                   // the key of the next registered run
	logins     map[string]*loginSession // per account id: its open login session (login.go)
}

// entry is what the service knows of one account beyond its record, for this server run.
type entry struct {
	state      container.State // the container's state from the last inspect or op; "" = not known yet
	err        string          // the last create or start failure, Docker's line; "" = none
	login      *Login          // the last auth status answer; nil = not asked in this run
	loginAsked uint64          // tickets of auth status runs given out (refreshLogin)
	loginKept  uint64          // the ticket of the answer in login: an older answer is dropped
	spawner    *claude.Spawner // the account's spawner, made on first ask
	runs       map[uint64]*run // the live runs of the account's runner
	seen       bool            // the container was seen running in this server run
	// restarting counts the Restart, Edit and Stop calls ending the account's processes and
	// recreating or stopping its container now: while it is not 0, new runs are refused
	// (ErrRestarting).
	restarting int
}

// run is one live process of an account's runner.
type run struct {
	id   string       // its AIWB_RUN tag
	kill func() error // its Run.Kill
}

// New makes the service of o. It neither calls Docker nor Claude: the first List (or Watch)
// looks.
func New(o Options) (*Service, error) {
	if o.Root == "" {
		return nil, errors.New("accounts: no data folder")
	}
	if o.Containers == nil {
		return nil, errors.New("accounts: no Docker")
	}
	if o.Logf == nil {
		o.Logf = log.Printf
	}
	if o.ClaudeBin == "" {
		o.ClaudeBin = "claude"
	}
	if o.Claude == nil {
		o.Claude = func(_ Alias, sp *claude.Spawner) Claude { return ClaudeOf(sp) }
	}
	o.Waits = o.Waits.withDefaults()
	if o.Store == nil {
		st, err := OpenStore(o.Root, o.Logf)
		if err != nil {
			return nil, err
		}
		o.Store = st
	}
	base, cancel := context.WithCancel(context.Background())
	return &Service{
		o: o, root: o.Root, store: o.Store, cont: o.Containers, claudeFn: o.Claude,
		waits: o.Waits, logf: o.Logf, base: base, cancel: cancel,
		work: o.Work, rt: map[string]*entry{}, ops: map[string]chan struct{}{},
		logins: map[string]*loginSession{},
	}, nil
}

// SetWork sets the chat manager, for a service made before it.
func (s *Service) SetWork(w Work) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.work = w
}

// workOf is the chat manager, nil when there is none yet.
func (s *Service) workOf() Work {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.work
}

// busy is how many agents work in the account's container now. It takes no lock of the service.
func (s *Service) busy(kind model.AgentKind) int {
	if w := s.workOf(); w != nil {
		return w.Busy(kind)
	}
	return 0
}

// stopKind ends the live processes of kind (Work.StopKind), when there is a chat manager.
func (s *Service) stopKind(kind model.AgentKind) {
	if w := s.workOf(); w != nil {
		w.StopKind(kind)
	}
}

// rtLocked is the runtime entry of id, made when missing. mu is held.
func (s *Service) rtLocked(id string) *entry {
	r := s.rt[id]
	if r == nil {
		r = &entry{runs: map[uint64]*run{}}
		s.rt[id] = r
	}
	return r
}

// lockOp takes the op lock of account id and returns its unlock.
func (s *Service) lockOp(id string) func() {
	unlock, _ := s.lockOpCtx(context.Background(), id)
	return unlock
}

// lockOpCtx takes the op lock of account id, waiting no longer than ctx, and returns its unlock;
// ctx's error when it ended first.
func (s *Service) lockOpCtx(ctx context.Context, id string) (func(), error) {
	s.mu.Lock()
	m := s.ops[id]
	if m == nil {
		m = make(chan struct{}, 1)
		s.ops[id] = m
	}
	s.mu.Unlock()
	select {
	case m <- struct{}{}:
	default:
		select {
		case m <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	var once sync.Once
	return func() { once.Do(func() { <-m }) }, nil
}

// goBg runs f in a goroutine of its own that Shutdown waits for; after Shutdown it does nothing.
func (s *Service) goBg(f func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		f()
	}()
}

// account is the record id, or ErrNotFound.
func (s *Service) account(id string) (Alias, error) {
	a, ok := s.store.Get(id)
	if !ok {
		return Alias{}, ErrNotFound
	}
	return a, nil
}

// accountOf is the record of the account kind a; false when a is no account (or a removed one).
func (s *Service) accountOf(a model.AgentKind) (Alias, bool) {
	id, ok := model.AliasID(a)
	if !ok {
		return Alias{}, false
	}
	return s.store.Get(id)
}

// mkdirs makes the account's folders, 0700.
func (s *Service) mkdirs(id string) error {
	for _, d := range []string{Dir(s.root, id), ClaudeDir(s.root, id), HomeDir(s.root, id), MCPDir(s.root, id)} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
		if err := os.Chmod(d, 0o700); err != nil {
			return err
		}
	}
	return nil
}

// applied is what a container made from a's saved spec has.
func applied(a Alias) *Applied {
	return &Applied{Image: a.EffectiveImage(), Default: a.Image == "", Mounts: slices.Clone(a.Mounts)}
}

// sameApplied reports whether x and y say the same (both nil, or the same fields).
func sameApplied(x, y *Applied) bool {
	if x == nil || y == nil {
		return x == y
	}
	return x.Image == y.Image && x.Default == y.Default && slices.Equal(x.Mounts, y.Mounts)
}

// syncApplied brings the record's Applied in line with the account's container as info shows
// it: no container, nil; one labelled with the hash of the saved spec (made from it, whoever made
// it and whether its start worked), the saved spec; one of another spec, or info that knows no
// state, as it is. So Applied never misses a container left by a create whose start failed, and
// "restart needed", the pending folders and the folder checks follow the container that is
// there. The op lock is held.
func (s *Service) syncApplied(id string, info container.Info) {
	a, ok := s.store.Get(id)
	if !ok {
		return
	}
	var want *Applied
	switch {
	case info.State == container.StateNone:
	case info.State != "" && info.Spec != "" && info.Spec == a.Spec(s.root).Hash():
		want = applied(a)
	default:
		return
	}
	if sameApplied(a.Applied, want) {
		return
	}
	a.Applied = want
	if err := s.store.Put(a); err != nil {
		s.logf("accounts: %s: recording the applied spec: %v", id, err)
	}
}

// changed sends the whole List to every client and tells the server that which accounts can be
// used may have changed. No lock is held while it runs.
func (s *Service) changed() {
	l := s.list()
	if s.o.Broadcast != nil {
		s.o.Broadcast(map[string]any{"type": EventAliases, "aliases": l})
	}
	if s.o.Changed != nil {
		s.o.Changed()
	}
}

// changedLater is changed in a goroutine of its own: for the paths a chat manager's call may be
// on (changed reads Work, whose lock that caller may hold).
func (s *Service) changedLater() { s.goBg(s.changed) }

// Add stores a new account (goal §1.2.3): its folder is made, no container is.
func (s *Service) Add(in Input) (View, error) {
	name := ""
	if in.Name != nil {
		name = *in.Name
	}
	name, err := CleanName(name)
	if err != nil {
		return View{}, err
	}
	var mounts []string
	if in.Mounts != nil {
		mounts = *in.Mounts
	}
	mounts, err = CleanMounts(mounts, s.o.Home, s.root)
	if err != nil {
		return View{}, err
	}
	image := ""
	if in.Image != nil {
		if image, err = CleanImage(*in.Image); err != nil {
			return View{}, err
		}
	}
	a := Alias{ID: model.NewID("a_"), Name: name, Image: image, Mounts: mounts, Created: time.Now().UTC()}
	if err := s.mkdirs(a.ID); err != nil {
		os.RemoveAll(Dir(s.root, a.ID))
		return View{}, err
	}
	if err := s.store.Put(a); err != nil {
		os.RemoveAll(Dir(s.root, a.ID))
		return View{}, err
	}
	s.changed()
	v, _ := s.view(a.ID)
	return v, nil
}

// Edit changes an account's name, folders or image (goal §1.6, §3.7). A change of folders or
// image on a running container recreates it when no agent works in it, and answers RestartBusy
// (nothing done) when some do.
func (s *Service) Edit(id string, in Input) (Change, error) {
	var name, image string
	var mounts []string
	var err error
	if in.Name != nil {
		if name, err = CleanName(*in.Name); err != nil {
			return Change{}, err
		}
	}
	if in.Mounts != nil {
		if mounts, err = CleanMounts(*in.Mounts, s.o.Home, s.root); err != nil {
			return Change{}, err
		}
	}
	if in.Image != nil {
		if image, err = CleanImage(*in.Image); err != nil {
			return Change{}, err
		}
	}

	unlock := s.lockOp(id)
	old, ok := s.store.Get(id)
	if !ok {
		unlock()
		return Change{}, ErrNotFound
	}
	a := old.deepCopy()
	if in.Name != nil {
		a.Name = name
	}
	if in.Mounts != nil {
		a.Mounts = mounts
	}
	if in.Image != nil {
		a.Image = image
	}
	same := a.Name == old.Name && a.Image == old.Image && slices.Equal(a.Mounts, old.Mounts)
	if !same {
		if err := s.store.Put(a); err != nil {
			unlock()
			return Change{}, err
		}
	}
	unlock()

	specSame := a.EffectiveImage() == old.EffectiveImage() && sameFolders(a.Mounts, old.Mounts)
	if specSame {
		if !same {
			s.changed()
		}
		return s.change(id, RestartUnchanged, 0), nil
	}

	info, ok := s.inspectRunning(id)
	if !ok {
		s.changed()
		return s.change(id, RestartDeferred, 0), nil
	}
	// The record as it is now: an ensure may have written Applied since.
	if cur, ok := s.store.Get(id); !ok {
		return Change{}, ErrNotFound
	} else if !cur.SpecDiffers() && (cur.Applied != nil || info.Spec == cur.Spec(s.root).Hash()) {
		s.changed()
		return s.change(id, RestartUnchanged, 0), nil
	}
	if n := s.busy(a.Kind()); n > 0 {
		s.changed()
		return s.change(id, RestartBusy, n), nil
	}
	err = s.whileRestarting(id, func() error {
		s.stopKind(a.Kind())
		return s.recreate(id)
	})
	if err != nil {
		return Change{}, err
	}
	return s.change(id, RestartDone, 0), nil
}

// inspectRunning inspects the account's container (QuickTimeout), caches its state, and reports
// whether it runs. Docker unavailable, or any failure, is "not running".
func (s *Service) inspectRunning(id string) (container.Info, bool) {
	if s.cont.Available() != nil {
		return container.Info{}, false
	}
	ctx, cancel := context.WithTimeout(s.base, container.QuickTimeout)
	defer cancel()
	unlock, err := s.lockOpCtx(ctx, id)
	if err != nil {
		return container.Info{}, false // the account is busy (a create, a stop): not known as running
	}
	info, err := s.inspect(ctx, id)
	unlock()
	if err != nil {
		if _, ok := container.IsUnavailable(err); !ok {
			s.logf("accounts: inspect of %s: %v", container.Name(id), err)
		}
		return container.Info{}, false
	}
	return info, info.State == container.StateRunning
}

// inspect asks Docker of the account's container (within ctx and QuickTimeout), caches its
// state and brings the record's Applied in line with it (syncApplied). A container found running
// clears the stored create error. The op lock is held.
func (s *Service) inspect(ctx context.Context, id string) (container.Info, error) {
	ctx, cancel := context.WithTimeout(ctx, container.QuickTimeout)
	defer cancel()
	info, err := s.cont.Inspect(ctx, id)
	if err != nil {
		return info, err
	}
	s.syncApplied(id, info)
	s.mu.Lock()
	r := s.rtLocked(id)
	r.state = info.State
	if info.State == container.StateRunning {
		r.err = ""
	}
	s.mu.Unlock()
	return info, nil
}

// recreate recreates the account's container from its saved spec and records it applied. The
// image is made sure of first, with no lock held (a build or a pull takes minutes). A failure is
// stored as the account's container error (D17), and Applied follows what is left (syncApplied:
// dropped when the container is gone with it). The op lock is taken here; Work is not called.
func (s *Service) recreate(id string) error {
	a, ok := s.store.Get(id)
	if !ok {
		return ErrNotFound
	}
	ctx, cancel := context.WithTimeout(s.base, s.waits.Prepare)
	defer cancel()
	if err := s.cont.EnsureImage(ctx, a.EffectiveImage()); err != nil {
		s.logf("accounts: recreate of %s: %v", container.Name(id), err)
		s.noteFailure(ctx, id, err)
		return err
	}
	unlock := s.lockOp(id)
	a, ok = s.store.Get(id)
	if !ok {
		unlock()
		return ErrNotFound
	}
	if err := s.mkdirs(id); err != nil {
		unlock()
		return err
	}
	info, err := s.cont.Recreate(ctx, a.Spec(s.root))
	if err == nil {
		s.syncApplied(id, info)
		s.mu.Lock()
		r := s.rtLocked(id)
		r.state, r.err = container.StateRunning, ""
		s.mu.Unlock()
		unlock()
		s.noteRunning(id, true)
		return nil
	}
	s.logf("accounts: recreate of %s: %v", container.Name(id), err)
	s.noteFailure(ctx, id, err)
	s.inspect(s.base, id) // Applied follows what is left
	unlock()
	return err
}

// noteFailure stores err, a create or start failure of the account's container, as its error
// (D17): not Docker's unavailability (the accounts show that), nor the end of ctx.
func (s *Service) noteFailure(ctx context.Context, id string, err error) {
	if _, unavailable := container.IsUnavailable(err); unavailable || ctx.Err() != nil {
		return
	}
	s.mu.Lock()
	s.rtLocked(id).err = err.Error()
	s.mu.Unlock()
}

// whileRestarting runs f, which ends the account's processes (Work.StopKind) and recreates or
// stops its container, with the account marked restarting: Check and the account's runner refuse
// new runs with ErrRestarting until f has returned (or panicked). The change is broadcast once
// the mark is set and again once it is cleared. No lock is held while f runs.
func (s *Service) whileRestarting(id string, f func() error) error {
	s.mu.Lock()
	s.rtLocked(id).restarting++
	s.mu.Unlock()
	s.changed()
	defer func() {
		s.mu.Lock()
		if r := s.rt[id]; r != nil && r.restarting > 0 {
			r.restarting--
		}
		s.mu.Unlock()
		s.changed()
	}()
	return f()
}

// restarting reports whether the account is marked restarting (whileRestarting).
func (s *Service) restarting(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.rt[id]
	return r != nil && r.restarting > 0
}

// change is the answer of Edit, Restart and Stop, with the account's fresh view.
func (s *Service) change(id, restart string, busy int) Change {
	v, _ := s.view(id)
	return Change{Restart: restart, Busy: busy, Alias: v}
}

// Restart recreates the account's running container from its saved spec (goal §1.6.5-6). With
// agents working in it and no force it does nothing and answers RestartBusy. A container that
// does not run is left as it is: RestartDeferred (it takes the saved spec at its next start).
func (s *Service) Restart(id string, force bool) (Change, error) {
	a, err := s.account(id)
	if err != nil {
		return Change{}, err
	}
	if err := s.cont.Available(); err != nil {
		return Change{}, err
	}
	unlock := s.lockOp(id)
	info, err := s.inspect(s.base, id)
	unlock()
	if err != nil {
		return Change{}, err
	}
	if info.State != container.StateRunning {
		s.changed()
		return s.change(id, RestartDeferred, 0), nil
	}
	if n := s.busy(a.Kind()); n > 0 && !force {
		s.changed()
		return s.change(id, RestartBusy, n), nil
	}
	err = s.whileRestarting(id, func() error {
		s.stopKind(a.Kind())
		return s.recreate(id)
	})
	if err != nil {
		return Change{}, err
	}
	return s.change(id, RestartDone, 0), nil
}

// Stop stops the account's container (goal §1.6.3). With agents working in it and no force it
// does nothing and answers RestartBusy. A container that does not run is done already.
func (s *Service) Stop(id string, force bool) (Change, error) {
	a, err := s.account(id)
	if err != nil {
		return Change{}, err
	}
	if err := s.cont.Available(); err != nil {
		return Change{}, err
	}
	unlock := s.lockOp(id)
	info, err := s.inspect(s.base, id)
	unlock()
	if err != nil {
		return Change{}, err
	}
	if info.State != container.StateRunning {
		s.changed()
		return s.change(id, RestartDone, 0), nil
	}
	if n := s.busy(a.Kind()); n > 0 && !force {
		s.changed()
		return s.change(id, RestartBusy, n), nil
	}
	err = s.whileRestarting(id, func() error {
		s.cancelLogin(id)
		s.stopKind(a.Kind())
		unlock := s.lockOp(id)
		defer unlock()
		ctx, cancel := context.WithTimeout(s.base, stopTimeout)
		defer cancel()
		if err := s.cont.Stop(ctx, id); err != nil {
			return err
		}
		s.mu.Lock()
		s.rtLocked(id).state = container.StateStopped
		s.mu.Unlock()
		return nil
	})
	if err != nil {
		s.logf("accounts: stop of %s: %v", container.Name(id), err)
		return Change{}, err
	}
	return s.change(id, RestartDone, 0), nil
}

// Remove removes an account (goal §1.8.3): its login run, its agents, its container, its folder
// and its record. Its chats stay readable; anything they ask from then on is ErrRemoved.
func (s *Service) Remove(id string) error {
	a, err := s.account(id)
	if err != nil {
		return err
	}
	s.cancelLogin(id)
	s.stopKind(a.Kind())

	unlock := s.lockOp(id)
	if _, ok := s.store.Get(id); !ok {
		unlock()
		return ErrNotFound
	}
	ctx, cancel := context.WithTimeout(s.base, stopTimeout)
	err = s.cont.Remove(ctx, id)
	cancel()
	if err != nil {
		u, ok := container.IsUnavailable(err)
		if !ok || (u.Kind != container.NotInstalled && u.Kind != container.Unsupported) {
			unlock()
			s.logf("accounts: remove of %s: %v", container.Name(id), err)
			return err
		}
		s.logf("accounts: removing account %s with no Docker (%s): its container %s may remain", id, u.Reason, container.Name(id))
	}
	s.killRuns(s.takeRuns(id))
	if err := os.RemoveAll(Dir(s.root, id)); err != nil {
		unlock()
		s.logf("accounts: deleting the folder of account %s: %v", id, err)
		return err
	}
	if err := s.store.Delete(id); err != nil {
		unlock()
		return err
	}
	s.mu.Lock()
	delete(s.rt, id)
	s.mu.Unlock()
	unlock()
	s.changed()
	return nil
}

// Logout logs the account out (goal §1.3.4), in its container, which is started if need be.
func (s *Service) Logout(id string) (View, error) {
	if _, err := s.account(id); err != nil {
		return View{}, err
	}
	if err := s.cont.Available(); err != nil {
		return View{}, err
	}
	ctx, cancel := context.WithTimeout(s.base, s.waits.Prepare)
	_, err := s.ensure(ctx, id, ensureFull)
	cancel()
	if err != nil {
		return View{}, err
	}
	c, err := s.claudeOf(id, ensureFull)
	if err != nil {
		return View{}, err
	}
	ctx, cancel = context.WithTimeout(s.base, s.waits.Logout)
	err = c.Logout(ctx)
	cancel()
	if err != nil {
		s.logf("accounts: logout of account %s: %v", id, err)
	}
	s.refreshLogin(id)
	s.changed()
	if err != nil {
		return View{}, err
	}
	v, ok := s.view(id)
	if !ok {
		return View{}, ErrNotFound
	}
	return v, nil
}

// How an ensure may make the account's container run.
type ensureMode int

const (
	// ensureFull creates or starts the container as need be, its image built or pulled first,
	// within the caller's ctx (Prepare, a login, a logout).
	ensureFull ensureMode = iota
	// ensureQuick is ensureFull within Waits.Run: the ensure of a chat's process, whose chat's
	// lock is held meanwhile (the chat manager calls Prepare first). Past it, ErrPreparing; a
	// build or a pull of the image goes on (container.Manager.EnsureImage).
	ensureQuick
	// ensureRunning only uses a container that runs, and answers ErrStopped for one that does not
	// (D22): the service's auth status, the catalog probe and the usage never start a container,
	// so they never start one the person has just stopped.
	ensureRunning
)

// ensure makes the account's container run, creating it from the saved spec or starting it, and
// returns it; mode says how far it may go. Docker unavailable returns its error at once. A create
// or start failure is stored as the account's container error. The image of a container to be
// created is made sure of with no lock held (a build or a pull takes minutes); the op lock is
// held while the container is inspected, created or started. The record's Applied follows the
// container found or made (syncApplied). The first time in this server run that the container
// runs, Ready is called and the login is asked, each in a goroutine of its own. It may be called
// from a chat manager's call: it never calls Work, and the change is broadcast from a goroutine
// of its own.
func (s *Service) ensure(ctx context.Context, id string, mode ensureMode) (container.Info, error) {
	if err := s.cont.Available(); err != nil {
		return container.Info{}, err
	}
	parent := ctx
	if mode == ensureQuick {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.waits.Run)
		defer cancel()
	}
	info, created, err := s.ensureLocked(ctx, id, mode)
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrStopped) {
		return container.Info{}, err
	}
	s.mu.Lock()
	r := s.rtLocked(id)
	before, beforeErr := r.state, r.err
	if err == nil {
		r.state, r.err = container.StateRunning, ""
	}
	s.mu.Unlock()
	if err != nil {
		s.noteFailure(ctx, id, err)
		if _, unavailable := container.IsUnavailable(err); !unavailable && ctx.Err() == nil {
			s.logf("accounts: starting %s: %v", container.Name(id), err)
		}
	}
	s.mu.Lock()
	moved := r.state != before || r.err != beforeErr || created
	s.mu.Unlock()
	if moved {
		s.changedLater()
	}
	if err != nil {
		if mode == ensureQuick && ctx.Err() != nil && parent.Err() == nil {
			return container.Info{}, ErrPreparing
		}
		return container.Info{}, err
	}
	s.noteRunning(id, true)
	return info, nil
}

// ensureLocked is the Docker part of ensure: the op lock is taken here, and let go while the
// image of a container to be created is made sure of. created: the container was (re)created.
func (s *Service) ensureLocked(ctx context.Context, id string, mode ensureMode) (info container.Info, created bool, err error) {
	unlock, err := s.lockOpCtx(ctx, id)
	if err != nil {
		return container.Info{}, false, err
	}
	defer func() { unlock() }()
	a, ok := s.store.Get(id)
	if !ok {
		return container.Info{}, false, ErrNotFound
	}
	if mode != ensureRunning {
		if err := s.mkdirs(id); err != nil {
			return container.Info{}, false, err
		}
	}
	if info, err = s.inspect(ctx, id); err != nil {
		return container.Info{}, false, err
	}
	switch {
	case info.State == container.StateRunning:
		return info, false, nil
	case mode == ensureRunning:
		return container.Info{}, false, ErrStopped
	case info.State == container.StateStopped && info.Spec == a.Spec(s.root).Hash():
		// started below: no image is needed
	default:
		// A create: the image first, with the op lock let go.
		unlock()
		if err := s.cont.EnsureImage(ctx, a.EffectiveImage()); err != nil {
			unlock = func() {}
			return container.Info{}, false, err
		}
		if unlock, err = s.lockOpCtx(ctx, id); err != nil {
			unlock = func() {}
			return container.Info{}, false, err
		}
		if a, ok = s.store.Get(id); !ok {
			return container.Info{}, false, ErrNotFound
		}
	}
	info, created, err = s.cont.Ensure(ctx, a.Spec(s.root))
	s.syncApplied(id, info)
	return info, created, err
}

// noteRunning is told that the account's container runs. The first time in this server run, it
// calls Ready and, with askLogin, asks the login then broadcasts; each in a goroutine.
func (s *Service) noteRunning(id string, askLogin bool) {
	s.mu.Lock()
	r := s.rtLocked(id)
	first := !r.seen
	r.seen = true
	s.mu.Unlock()
	if !first {
		return
	}
	if s.o.Ready != nil {
		kind := model.AliasKind(id)
		s.goBg(func() { s.o.Ready(kind) })
	}
	if askLogin {
		s.goBg(func() {
			s.refreshLogin(id)
			s.changed()
		})
	}
}

// claudeOf is the account's own Claude (Options.Claude of a copy of its spawner), or
// ErrNotFound; mode is how its runs ensure the container (ensureFull for a login or a logout,
// ensureRunning for auth status). The copy's runner is not refused while the account restarts:
// auth status, login and logout are the service's own runs, which wait for the container behind
// the op lock (a login opened during a restart starts in the new container), rather than chats'
// runs that would be killed by the restart.
func (s *Service) claudeOf(id string, mode ensureMode) (Claude, error) {
	a, ok := s.store.Get(id)
	if !ok {
		return nil, ErrNotFound
	}
	sp := *s.spawnerOf(id)
	sp.Runner = &accountRunner{s: s, id: id, own: true, mode: mode}
	return s.claudeFn(a, &sp), nil
}

// spawnerOf is the account's spawner, made on first ask and kept until the account is removed.
// Its Home is "" on purpose (D20): the app folder rules are written with absolute paths, since
// the container's ~ is the account's home folder, not the person's.
func (s *Service) spawnerOf(id string) *claude.Spawner {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.rtLocked(id)
	if r.spawner == nil {
		r.spawner = &claude.Spawner{
			Bin: s.o.ClaudeBin, AppRoot: s.root, Home: "", Prompt: s.o.Prompt,
			Runner: &accountRunner{s: s, id: id, mode: ensureQuick}, MCPURL: s.o.MCPURL, MCPDir: MCPDir(s.root, id),
		}
	}
	return r.spawner
}

// Spawner is the spawner of the account kind a (chats.Accounts); an untyped nil when a is no
// account.
func (s *Service) Spawner(a model.AgentKind) agent.Spawner {
	al, ok := s.accountOf(a)
	if !ok {
		return nil
	}
	return s.spawnerOf(al.ID)
}

// RunningSpawner is the spawner of the account kind a for what only reads in a container that
// runs (the catalog probe, the plan usage): its runs never create nor start the container, and
// fail with ErrStopped when it does not run (D22, D24). An untyped nil when a is no account.
func (s *Service) RunningSpawner(a model.AgentKind) agent.Spawner {
	al, ok := s.accountOf(a)
	if !ok {
		return nil
	}
	sp := *s.spawnerOf(al.ID)
	sp.Runner = &accountRunner{s: s, id: al.ID, mode: ensureRunning}
	return &sp
}

// RunnerFor is the runner of the account kind a: where its processes run; nil when a is no
// account.
func (s *Service) RunnerFor(a model.AgentKind) agent.Runner {
	al, ok := s.accountOf(a)
	if !ok {
		return nil
	}
	return s.spawnerOf(al.ID).Runner
}

// DirOf is the folder of the account kind a (Dir); "" when a is no account.
func (s *Service) DirOf(a model.AgentKind) string {
	al, ok := s.accountOf(a)
	if !ok {
		return ""
	}
	return Dir(s.root, al.ID)
}

// CheckFolder says whether a process of the account kind a may work in cwd (D8, chats.Accounts):
// against the applied mounts while a container from another spec runs, else against the saved
// ones (the next ensure makes the container from them). It never calls Docker.
func (s *Service) CheckFolder(a model.AgentKind, cwd string) error {
	al, ok := s.accountOf(a)
	if !ok {
		return ErrRemoved
	}
	s.mu.Lock()
	running := false
	if r := s.rt[al.ID]; r != nil {
		running = r.state == container.StateRunning
	}
	s.mu.Unlock()
	refuse := &MountError{Account: al.Name, Folder: cwd}
	if running && al.SpecDiffers() {
		if Under(al.Applied.Mounts, cwd) {
			return nil
		}
		refuse.Pending = Under(al.Mounts, cwd)
		return refuse
	}
	if Under(al.Mounts, cwd) {
		return nil
	}
	return refuse
}

// Prepare makes the container of the account kind a ready for a chat's process (chats.Accounts):
// created or started, its image built or pulled first, within Waits.Start. The chat manager calls
// it with none of its locks held, before the chat's lock under which the process is started (and
// whose runner then waits no longer than Waits.Run). It answers at once when the container is
// known to run, and nil when a is no account, cannot be used now (Check: the chat manager's gate
// says why), or the server is shutting down. Its error is why the container cannot be made ready
// (Docker's line, a failed build), or ErrPreparing past Waits.Start. It never calls Work.
func (s *Service) Prepare(a model.AgentKind) error {
	al, ok := s.accountOf(a)
	if !ok || s.Check(a) != nil {
		return nil
	}
	s.mu.Lock()
	r := s.rt[al.ID]
	skip := s.closed || (r != nil && r.state == container.StateRunning && r.err == "")
	s.mu.Unlock()
	if skip {
		return nil
	}
	ctx, cancel := context.WithTimeout(s.base, s.waits.Start)
	defer cancel()
	_, err := s.ensure(ctx, al.ID, ensureFull)
	switch {
	case err == nil, errors.Is(err, ErrNotFound), s.base.Err() != nil:
		return nil
	case ctx.Err() != nil:
		return ErrPreparing
	}
	return err
}

// Kinds is every account's kind, in the order they were added (usable.Extra).
func (s *Service) Kinds() []model.AgentKind {
	list := s.store.List()
	out := make([]model.AgentKind, len(list))
	for i, a := range list {
		out[i] = a.Kind()
	}
	return out
}

// Check says whether the account kind a can be used now (usable.Extra): ErrRemoved, Docker's
// reason, ErrRestarting, ErrNotLoggedIn, or nil. It answers from what is known, never waiting.
func (s *Service) Check(a model.AgentKind) error {
	al, ok := s.accountOf(a)
	if !ok {
		return ErrRemoved
	}
	if err := s.cont.Available(); err != nil {
		return err
	}
	s.mu.Lock()
	r := s.rt[al.ID]
	restarting := r != nil && r.restarting > 0
	l := loginOf(al, r)
	s.mu.Unlock()
	if restarting {
		return ErrRestarting
	}
	if l.Known && l.LoggedIn {
		return nil
	}
	return ErrNotLoggedIn
}

// Name is the name of the account kind a (usable.Extra); "" when a is no account.
func (s *Service) Name(a model.AgentKind) string {
	al, ok := s.accountOf(a)
	if !ok {
		return ""
	}
	return al.Name
}

// Watch looks at Docker and every account now, then follows Docker's availability every
// `every` until stop is closed, re-reading the containers and broadcasting after each change.
// It blocks.
func (s *Service) Watch(every time.Duration, stop <-chan struct{}) {
	// Refresh has its own quick limit: a context of the same length would end first, store
	// nothing, and leave a Docker that does not answer unknown until the next look.
	ctx, cancel := context.WithCancel(s.base)
	s.cont.Refresh(ctx)
	cancel()
	s.refresh(true)
	s.changed()
	s.cont.Watch(every, stop, func(error) {
		s.refresh(false)
		s.changed()
	})
}

// Shutdown ends the login runs and kills every live run of the accounts (each within
// QuickTimeout), and stops the background refreshes. Containers are left running. Again is a
// no-op.
func (s *Service) Shutdown() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	var runs []*run
	for _, r := range s.rt {
		for k, rn := range r.runs {
			runs = append(runs, rn)
			delete(r.runs, k)
		}
	}
	s.mu.Unlock()
	s.endLogins()
	s.killRuns(runs)
	s.cancel()
	s.bg.Wait()
}

// takeRuns unregisters and returns the account's live runs.
func (s *Service) takeRuns(id string) []*run {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.rt[id]
	if r == nil {
		return nil
	}
	var out []*run
	for k, rn := range r.runs {
		out = append(out, rn)
		delete(r.runs, k)
	}
	return out
}

// killRuns calls the Kill of every run, in parallel, and returns once all have returned.
func (s *Service) killRuns(runs []*run) {
	var wg sync.WaitGroup
	for _, rn := range runs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := rn.kill(); err != nil {
				s.logf("accounts: killing run %s: %v", rn.id, err)
			}
		}()
	}
	wg.Wait()
}
