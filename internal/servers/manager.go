package servers

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
)

// Hooks are what the manager tells the code that follows the remote servers' chats. They are
// set once, before Start. The calls for one entry come in order, from that entry's goroutine,
// with no lock of the manager held; a hook may call the manager, but not Close.
type Hooks struct {
	Snapshot func(entry string, raw json.RawMessage)      // the API snapshot of every stream start, before any Event of that stream
	Event    func(entry, typ string, raw json.RawMessage) // every event after the snapshot
	State    func(entry string, from, to State)
	Back     func(entry string) // connected again after having been connected in this process; after Snapshot
	Removed  func(entry string) // the entry was removed: the last call for it
}

// Lists are what a remote server offers for a new chat, from its last snapshot and the events
// since: its usable agents, their model lists, its home folder and its default folder.
type Lists struct {
	Agents     []model.AgentKind
	Catalogs   map[model.AgentKind]*model.Catalog
	Home       string
	DefaultCwd string
}

// Input is the form of a new entry, as typed.
type Input struct {
	Name, Address, Secret string
	SelfSigned            bool
	Pin                   string
}

// Patch is the form of an edit: a nil field keeps the stored value, and so does an empty secret.
type Patch struct {
	Name, Address, Secret *string
	SelfSigned            *bool
	Pin                   *string
}

// apply writes the given fields into e.
func (p Patch) apply(e *Entry) {
	if p.Name != nil {
		e.Name = *p.Name
	}
	if p.Address != nil {
		e.Address = *p.Address
	}
	if p.Secret != nil && strings.TrimSpace(*p.Secret) != "" {
		e.Secret = *p.Secret
	}
	if p.SelfSigned != nil {
		e.SelfSigned = *p.SelfSigned
	}
	if p.Pin != nil {
		e.Pin = *p.Pin
	}
}

// linkGiven reports whether the patch gives a field a connection is made from.
func (p Patch) linkGiven() bool {
	return p.Address != nil || p.Secret != nil || p.SelfSigned != nil || p.Pin != nil
}

// sameLink reports whether a and b make the same connection: all but the name and the instance id.
func sameLink(a, b Entry) bool {
	return a.Address == b.Address && a.Secret == b.Secret && a.SelfSigned == b.SelfSigned && a.Pin == b.Pin
}

func targetOf(e Entry) Target {
	return Target{Address: e.Address, Secret: e.Secret, SelfSigned: e.SelfSigned, Pin: e.Pin}
}

// vet is the form checks of an entry without a write: e normalized, or the error Add and Update
// would give. An e.ID names the entry that is edited, which may keep its own address.
func (l *List) vet(e Entry) (Entry, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	err := l.check(&e)
	return e, err
}

// errBadPath is Do's answer for a path that does not begin with "/": nothing was sent.
var errBadPath = errors.New("servers: the path of a call begins with /")

// Manager holds the server list and one connection per remote entry. Lock order: save, then mu,
// then the list's own lock. Hooks and Options.Notify are called with none of them held.
type Manager struct {
	// Counts gives the number of chats and runs this app keeps for an entry. It is set by the
	// code that keeps them, before the routes are served; nil counts as 0, 0.
	Counts func(id string) (chats, runs int)

	o       Options // Timing with its defaults
	list    *List
	ctx     context.Context // ends every connection and the sender
	cancel  context.CancelFunc
	started chan struct{} // closed by Start
	wg      sync.WaitGroup

	save sync.Mutex // held by Add and Edit over their test and their save

	mu      sync.Mutex
	hooks   Hooks
	running bool
	closed  bool
	conns   map[string]*conn // by entry id: the entry's current connection
	before  map[string]bool  // the entries that were connected in this process
	told    map[string]State // the state Hooks.State was last told, by entry id
	queue   []any            // events for Notify, in order
	wake    chan struct{}    // capacity 1: the queue is not empty
}

// Open reads the list in o.Root. It dials nothing: the connections start with Start.
func Open(o Options) (*Manager, error) {
	list, err := OpenList(o.Root)
	if err != nil {
		return nil, err
	}
	o.Timing = o.Timing.withDefaults()
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		o: o, list: list, ctx: ctx, cancel: cancel, started: make(chan struct{}),
		conns: map[string]*conn{}, before: map[string]bool{}, told: map[string]State{},
		wake: make(chan struct{}, 1),
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range list.Entries() {
		m.connectLocked(e)
	}
	if o.Notify != nil {
		m.wg.Add(1)
		go m.sender()
	}
	return m, nil
}

// SetHooks sets the hooks. It is called once, before Start.
func (m *Manager) SetHooks(h Hooks) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.hooks = h
}

// Start lets every entry connect. From here on a saved entry connects by itself.
func (m *Manager) Start() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.running {
		m.running = true
		close(m.started)
	}
}

// Close ends every connection and waits for the goroutines. Nothing is sent to a server, and no
// hook and no Notify is called after it returned.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	m.mu.Unlock()
	m.cancel()
	m.wg.Wait()
}

// connectLocked makes the connection of e, in the state connecting, in place of the entry's
// connection so far. Its goroutine starts when that one's has ended, and not before Start.
func (m *Manager) connectLocked(e Entry) *conn {
	ctx, cancel := context.WithCancel(m.ctx)
	c := &conn{
		m: m, entry: e, ctx: ctx, cancel: cancel,
		done: make(chan struct{}), retry: make(chan struct{}, 1),
		shown: shown{state: StateConnecting},
	}
	if old := m.conns[e.ID]; old != nil {
		old.cancel()
		c.prev = old.done
	} else {
		m.told[e.ID] = StateConnecting
	}
	m.conns[e.ID] = c
	if m.closed {
		cancel()
		close(c.done)
		return c
	}
	m.wg.Add(1)
	go c.run()
	return c
}

// sender gives the queued events to Notify, one at a time and in order.
func (m *Manager) sender() {
	defer m.wg.Done()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-m.wake:
		}
		m.mu.Lock()
		batch := m.queue
		m.queue = nil
		m.mu.Unlock()
		for _, ev := range batch {
			if m.ctx.Err() != nil {
				return
			}
			m.o.Notify(ev)
		}
	}
}

// queueLocked adds an event for the pages.
func (m *Manager) queueLocked(ev any) {
	if m.o.Notify == nil || m.closed {
		return
	}
	m.queue = append(m.queue, ev)
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// listChangedLocked queues the "servers" event: the whole list after an add, an edit, a remove
// or an accept.
func (m *Manager) listChangedLocked() {
	m.queueLocked(listEvent{Type: "servers", Servers: m.viewsLocked(), Notice: m.list.Notice()})
}

func (m *Manager) local() View { return localView(m.o.Version, m.o.LocalID) }

func (m *Manager) viewLocked(e Entry) View {
	s := shown{state: StateConnecting}
	if c := m.conns[e.ID]; c != nil {
		s = c.shown
	}
	return viewOf(e, s)
}

func (m *Manager) viewsLocked() []View {
	entries := m.list.Entries()
	out := make([]View, 0, 1+len(entries))
	out = append(out, m.local())
	for _, e := range entries {
		out = append(out, m.viewLocked(e))
	}
	return out
}

// Views is the list as the pages get it: the local entry first, then the entries in the file's
// order. A nil manager answers with the local entry alone.
func (m *Manager) Views() []View {
	if m == nil {
		return []View{localView("", "")}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.viewsLocked()
}

// Notice is "" or the sentence about a list file that was set aside when the manager opened.
func (m *Manager) Notice() string {
	if m == nil {
		return ""
	}
	return m.list.Notice()
}

// View is the entry with id, the local one for LocalID.
func (m *Manager) View(id string) (View, bool) {
	if id == LocalID {
		return m.local(), true
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.list.Get(id)
	if !ok {
		return View{}, false
	}
	return m.viewLocked(e), true
}

// ByInstance is the entry whose server has the instance id: the local one for this server's own.
func (m *Manager) ByInstance(instanceID string) (View, bool) {
	if instanceID == "" {
		return View{}, false
	}
	if instanceID == m.o.LocalID {
		return m.local(), true
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.list.Entries() {
		if e.InstanceID == instanceID {
			return m.viewLocked(e), true
		}
	}
	return View{}, false
}

// identity is what a test of the entry except, or of an unsaved form when except is "", compares
// the answering server's id with.
func (m *Manager) identity(except string) Identity {
	id := Identity{LocalID: m.o.LocalID, Others: map[string]string{}}
	for _, e := range m.list.Entries() {
		switch {
		case e.ID == except:
			id.Expect = e.InstanceID
		case e.InstanceID != "":
			id.Others[e.InstanceID] = e.Name
		}
	}
	return id
}

// holderLocked is the name of an entry other than except that has the instance id.
func (m *Manager) holderLocked(instanceID, except string) (name string, held bool) {
	for _, e := range m.list.Entries() {
		if e.ID != except && e.InstanceID == instanceID {
			return e.Name, true
		}
	}
	return "", false
}

// claim is the identity check of a connect, with the id a valid hello of c's server gave: the
// refusal is is_local, duplicate (with the other entry's name), another_server or "". The first
// id an entry's server gives is stored in the list, in the same step, so that of two entries
// with one server the second is refused. current is false for a conn that was replaced.
func (m *Manager) claim(c *conn, instanceID string) (refusal Outcome, name string, current bool) {
	id := c.entry.ID
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.list.Get(id)
	if !ok || m.conns[id] != c {
		return "", "", false
	}
	if instanceID == m.o.LocalID {
		return OutcomeIsLocal, "", true
	}
	if name, held := m.holderLocked(instanceID, id); held {
		return OutcomeDuplicate, name, true
	}
	switch {
	case e.InstanceID == "":
		// A write that fails leaves the entry without its id: the next connect stores it.
		_, _ = m.list.Update(id, func(e *Entry) error { e.InstanceID = instanceID; return nil })
	case e.InstanceID != instanceID:
		return OutcomeAnotherServer, "", true
	}
	return "", "", true
}

// duplicate is the test result that refuses a save for an id another entry got meanwhile.
func duplicate(r Result, name string) *Result {
	d := result(OutcomeDuplicate)
	d.Message += " " + name
	d.Version, d.InstanceID, d.FeatureLevel = r.Version, r.InstanceID, r.FeatureLevel
	return &d
}

// Add saves a new entry and connects to it. Without force it runs TestConnection first: when
// that is not OK nothing is saved, saved is false and r says why. With force no request is made
// before the save, only the form is checked, and the identity is enforced at the connect. err is
// a form error (ErrBadName, ErrBadAddress, ErrBadSecret, ErrBadPin, a *DuplicateError for an
// address another entry has) or a failed write.
func (m *Manager) Add(ctx context.Context, in Input, force bool) (v View, saved bool, r *Result, err error) {
	m.save.Lock()
	defer m.save.Unlock()
	e, err := m.list.vet(Entry{Name: in.Name, Address: in.Address, Secret: in.Secret, SelfSigned: in.SelfSigned, Pin: in.Pin})
	if err != nil {
		return View{}, false, nil, err
	}
	if !force {
		res := TestConnection(ctx, targetOf(e), m.identity(""), m.o)
		if r = &res; !res.OK {
			return View{}, false, r, nil
		}
		e.InstanceID = res.InstanceID
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if e.InstanceID != "" {
		if name, held := m.holderLocked(e.InstanceID, ""); held { // a connect stored it during the test
			return View{}, false, duplicate(*r, name), nil
		}
	}
	e, err = m.list.Add(e)
	if err != nil {
		return View{}, false, nil, err
	}
	m.connectLocked(e)
	m.listChangedLocked()
	return m.viewLocked(e), true, r, nil
}

// Edit changes the entry; its id stays. An edit that leaves the address, the secret, the box and
// the pin as they are runs no test and keeps the connection. Any other edit is tested as Add
// tests, unless force is set, and replaces the connection: a server with another identity than
// the entry's is refused by the test, or with force at the connect.
func (m *Manager) Edit(ctx context.Context, id string, p Patch, force bool) (v View, saved bool, r *Result, err error) {
	if id == LocalID {
		return View{}, false, nil, ErrLocalEntry
	}
	m.save.Lock()
	defer m.save.Unlock()
	old, ok := m.list.Get(id)
	if !ok {
		return View{}, false, nil, ErrNotFound
	}
	next := old
	p.apply(&next)
	if next, err = m.list.vet(next); err != nil {
		return View{}, false, nil, err
	}
	instanceID := ""
	if !sameLink(old, next) && !force {
		res := TestConnection(ctx, targetOf(next), m.identity(id), m.o)
		if r = &res; !res.OK {
			return View{}, false, r, nil
		}
		instanceID = res.InstanceID
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if instanceID != "" {
		if name, held := m.holderLocked(instanceID, id); held {
			return View{}, false, duplicate(*r, name), nil
		}
	}
	e, err := m.list.Update(id, func(e *Entry) error {
		p.apply(e)
		if e.InstanceID == "" {
			e.InstanceID = instanceID
		}
		return nil
	})
	if err != nil {
		return View{}, false, nil, err
	}
	// The connection is replaced when it is made from other values now. With the same values it
	// stays, but for one that is not up when the form gave them again: an edit leaves a stopped state.
	c := m.conns[id]
	if c == nil || !sameLink(c.entry, e) ||
		(p.linkGiven() && c.shown.state != StateConnected && c.shown.state != StateConnecting) {
		m.connectLocked(e)
	}
	m.listChangedLocked()
	return m.viewLocked(e), true, r, nil
}

// Remove takes the entry out of the list and ends its connection. The server is sent nothing.
func (m *Manager) Remove(id string) error {
	if id == LocalID {
		return ErrLocalEntry
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.list.Remove(id); err != nil {
		return err
	}
	if c := m.conns[id]; c != nil {
		c.removed = true
		c.cancel()
	}
	delete(m.conns, id)
	delete(m.before, id)
	delete(m.told, id)
	m.listChangedLocked()
	return nil
}

// Accept stores fingerprint as the entry's pin, sets its box and connects again. Any well-formed
// fingerprint is taken, also one typed from the other machine's output; ErrBadPin for another.
func (m *Manager) Accept(id, fingerprint string) (View, error) {
	if id == LocalID {
		return View{}, ErrLocalEntry
	}
	if _, err := remote.ParseFingerprint(fingerprint); err != nil {
		return View{}, ErrBadPin
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	e, err := m.list.Update(id, func(e *Entry) error {
		e.SelfSigned, e.Pin = true, fingerprint
		return nil
	})
	if err != nil {
		return View{}, err
	}
	m.connectLocked(e)
	m.listChangedLocked()
	return m.viewLocked(e), nil
}

// Test tests an unsaved form.
func (m *Manager) Test(ctx context.Context, t Target) Result {
	return TestConnection(ctx, t, m.identity(""), m.o)
}

// TestSaved tests the saved entry with the fields of over in place of the stored ones: a nil
// field, and an empty address or secret, takes the stored value. When what was tested is what is
// stored, the entry's connection then tries again, which leaves a stopped state.
func (m *Manager) TestSaved(ctx context.Context, id string, over Patch) (Result, error) {
	if id == LocalID {
		return Result{}, ErrLocalEntry
	}
	e, ok := m.list.Get(id)
	if !ok {
		return Result{}, ErrNotFound
	}
	t := targetOf(e)
	if over.Address != nil && strings.TrimSpace(*over.Address) != "" {
		t.Address = *over.Address
	}
	if over.Secret != nil && strings.TrimSpace(*over.Secret) != "" {
		t.Secret = strings.TrimSpace(*over.Secret)
	}
	if over.SelfSigned != nil {
		t.SelfSigned = *over.SelfSigned
	}
	if over.Pin != nil {
		t.Pin = *over.Pin
	}
	r := TestConnection(ctx, t, m.identity(id), m.o)
	tested := Entry{Address: t.Address, Secret: t.Secret, SelfSigned: t.SelfSigned, Pin: t.Pin}
	if address, _, _, err := ParseAddress(t.Address); err == nil {
		tested.Address = address
	}
	if pin, err := normalPin(t.SelfSigned, t.Pin); err == nil {
		tested.Pin = pin
	}
	if sameLink(tested, e) {
		m.mu.Lock()
		c := m.conns[id]
		m.mu.Unlock()
		if c != nil {
			c.Retry()
		}
	}
	return r, nil
}

// Retry makes an entry that waits in its back-off try now. It does nothing in every other state:
// for one that is connected or in an attempt, for one that waits for the user, for the local
// entry and for an unknown id. The back-off's step stays as it is.
func (m *Manager) Retry(id string) {
	if m == nil {
		return
	}
	m.mu.Lock()
	c := m.conns[id]
	backoff := c != nil && c.waiting && c.shown.state.retries()
	m.mu.Unlock()
	if backoff {
		c.Retry()
	}
}

// Do passes one call on to the entry's server, with the secret and this server's id, and returns
// the answer whatever its status. limit 0 means Timing.Call. In any state but connected it
// returns ErrNotConnected and sends nothing. path begins with "/" and may have a query; a body
// that is not nil is sent as JSON. An answer of 401 puts the entry in secret_not_accepted.
func (m *Manager) Do(ctx context.Context, id, method, path string, body []byte, limit time.Duration) (Reply, error) {
	if id == LocalID {
		return Reply{}, ErrLocalEntry
	}
	if !strings.HasPrefix(path, "/") {
		return Reply{}, errBadPath // anything else could name another host in the address's place
	}
	m.mu.Lock()
	c := m.conns[id]
	var l *link
	if c != nil {
		l = c.link
	}
	m.mu.Unlock()
	if c == nil {
		return Reply{}, ErrNotFound
	}
	if l == nil {
		return Reply{}, ErrNotConnected
	}
	return c.do(ctx, l, method, path, body, limit)
}

// Lists is what the entry's server offered when it was last connected; ok is false for the local
// entry, an unknown one and one that was not connected since it was saved or edited.
func (m *Manager) Lists(id string) (Lists, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.conns[id]
	if c == nil || !c.hasLists {
		return Lists{}, false
	}
	l := c.lists
	l.Agents = append([]model.AgentKind(nil), l.Agents...)
	catalogs := make(map[model.AgentKind]*model.Catalog, len(l.Catalogs))
	for k, v := range l.Catalogs {
		catalogs[k] = v
	}
	l.Catalogs = catalogs
	return l, true
}
