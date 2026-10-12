package remotes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"ai-whiteboard/internal/library"
	"ai-whiteboard/internal/servers"
)

// The prompt libraries of the other servers. Every server has its own library, and a server of
// the server list that offers one (servers.LibraryLevel) sends it to this one over the stream
// this server holds to it anyway: whole in the snapshot of every stream's start ("library") and
// whole again in an "own_library" event after every change, whoever made it. The relay keeps the
// last one of each entry, in memory only, and passes it on to the pages as that entry's library
// ("library" events, and Libraries for the snapshot). No page and no timer asks for anything.
//
// A copy is held to the rules of a library before it is kept (library.Check): one that breaks
// them is not kept and not shown. A copy is never written to a file, and nothing of it reaches
// this computer's own library, which is another object (app.App.Library) with other routes.
//
// When an entry's connection ends, its copy stays and is marked not connected; nothing of it can
// be changed until the entry is connected again, when the snapshot replaces it. The copy goes
// with the entry (the page gets "library_removed"), and with this process.
//
// A page's call that changes the library of an entry is passed on to that entry's server
// (RemoteLibrary), which checks the rules of its library itself. The change comes back like
// any other: on the stream.

// libraryWait is how long a call that changed a library on its server waits for that change to
// arrive on the stream, so that the page has its "library" event before its answer, as it has
// for this computer's library. A call that waited in vain is answered all the same.
const libraryWait = 3 * time.Second

// saidMax is the most characters of a sentence of another server that are shown or logged.
const saidMax = 300

// libraries are the copies, by entry id.
type libraries struct {
	// change is held by whatever changes a copy, from the change to the send of its event: the
	// events are in the order of the changes. mu alone guards the fields below. It is never held
	// over a call of the bridge: the page's snapshot reads Libraries with the bridge's lock held.
	change  sync.Mutex
	mu      sync.Mutex
	of      map[string]keptLibrary
	offers  map[string]bool // the entries whose last snapshot gave a library: their events are taken
	waiters map[string][]*libraryWaiter
	wait    time.Duration // libraryWait; the tests lower it
}

// keptLibrary is the copy of one entry's library. Its tree is never changed, only replaced: what
// Libraries hands out stays as it is.
type keptLibrary struct {
	tree library.Tree
	up   bool   // the entry's stream is open: the copy is the server's library as it is now
	name string // the entry's name as the pages were last told
}

// libraryWaiter is one call that waits for its change to arrive: done is closed when a copy for
// which has is true was kept and sent, or when the copy went.
type libraryWaiter struct {
	has  func(library.Tree) bool
	done chan struct{}
}

func (k keptLibrary) view(entry string) library.View {
	return library.View{Server: entry, Name: k.name, Connected: k.up, Groups: k.tree.Groups, Prompts: k.tree.Prompts}
}

// Libraries are the copies as the pages get them, in the order of the server list. Never nil.
func (r *Relay) Libraries() []library.View {
	views := r.o.Servers.Views()
	l := &r.libs
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]library.View, 0, len(l.of))
	for _, v := range views {
		if k, ok := l.of[v.ID]; ok && !v.Local {
			out = append(out, k.view(v.ID))
		}
	}
	return out
}

// librarySnapshot takes the library of a stream's start: the entry has connected. A snapshot
// without one, and one of a server below servers.LibraryLevel, means that the server has no
// library: a server built before the feature shows none, and no error.
func (r *Relay) librarySnapshot(entry string, raw json.RawMessage) {
	var snap struct {
		Library *library.Tree `json:"library"`
	}
	err := json.Unmarshal(raw, &snap)
	switch {
	case r.o.Servers.Level(entry) < servers.LibraryLevel:
		r.dropLibrary(entry, nil, false)
	case err != nil:
		r.dropLibrary(entry, err, true)
	case snap.Library == nil:
		r.dropLibrary(entry, nil, false)
	default:
		r.keepLibrary(entry, *snap.Library, true)
	}
}

// libraryEvent takes an "own_library" event: the library of the entry's server after a change.
// It is taken only of an entry whose snapshot gave a library.
func (r *Relay) libraryEvent(entry string, raw json.RawMessage) {
	var t library.Tree
	if err := json.Unmarshal(raw, &t); err != nil {
		if r.libs.offered(entry) {
			r.dropLibrary(entry, err, true)
		}
		return
	}
	r.keepLibrary(entry, t, false)
}

// get is the copy of the entry.
func (l *libraries) get(entry string) (keptLibrary, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	k, ok := l.of[entry]
	return k, ok
}

// offered reports whether the entry's last snapshot gave a library.
func (l *libraries) offered(entry string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.offers[entry]
}

// keepLibrary makes t the copy of the entry's library and sends it to the pages, when it passes
// every rule of a library; the copy is dropped otherwise, until the server sends one that does.
// snapshot says that t began a stream; any other t is taken only of an entry whose snapshot gave
// a library. Either way t came over an open stream: the entry is connected.
func (r *Relay) keepLibrary(entry string, t library.Tree, snapshot bool) {
	if !snapshot && !r.libs.offered(entry) {
		return
	}
	if err := library.Check(t); err != nil {
		r.dropLibrary(entry, err, true)
		return
	}
	if t.Groups == nil {
		t.Groups = []library.Group{}
	}
	if t.Prompts == nil {
		t.Prompts = []library.Prompt{}
	}
	l := &r.libs
	l.change.Lock()
	defer l.change.Unlock()
	k := keptLibrary{tree: t, up: true, name: r.name(entry)}
	l.mu.Lock()
	l.of[entry], l.offers[entry] = k, true
	var arrived []*libraryWaiter
	l.waiters[entry] = slices.DeleteFunc(l.waiters[entry], func(w *libraryWaiter) bool {
		if w.has(t) {
			arrived = append(arrived, w)
			return true
		}
		return false
	})
	l.mu.Unlock()
	r.o.Bridge.Broadcast(library.Event{Type: library.EventLibrary, Library: k.view(entry)})
	for _, w := range arrived {
		close(w.done)
	}
}

// dropLibrary ends the copy of the entry and tells the pages, if there was one. why is what was
// wrong with what the server sent, nil when it offers no library or is no longer in the list; it
// is logged, cut, at most once a minute for an entry. offers says whether the server still
// offers a library, so that its next one is taken.
func (r *Relay) dropLibrary(entry string, why error, offers bool) {
	if why != nil && r.tell("library "+entry) {
		r.o.Logf("remotes: the prompt library of the server %s is not shown: %s", entry, plain(why.Error(), saidMax))
	}
	l := &r.libs
	l.change.Lock()
	defer l.change.Unlock()
	l.mu.Lock()
	_, had := l.of[entry]
	delete(l.of, entry)
	if offers {
		l.offers[entry] = true
	} else {
		delete(l.offers, entry)
	}
	waiting := l.waiters[entry]
	delete(l.waiters, entry)
	l.mu.Unlock()
	if had {
		r.o.Bridge.Broadcast(library.Removed{Type: library.EventRemoved, Server: entry})
	}
	for _, w := range waiting {
		close(w.done)
	}
}

// libraryDown takes the end of the entry's connection: its copy stays, marked not connected.
func (r *Relay) libraryDown(entry string) {
	l := &r.libs
	l.change.Lock()
	defer l.change.Unlock()
	l.mu.Lock()
	k, ok := l.of[entry]
	if !ok || !k.up {
		l.mu.Unlock()
		return
	}
	k.up = false
	l.of[entry] = k
	l.mu.Unlock()
	r.o.Bridge.Broadcast(library.Event{Type: library.EventLibrary, Library: k.view(entry)})
}

// ServersChanged tells the pages the library of every entry whose name is another now: a server
// that was renamed shows its new name. Whoever gives the manager's events to the pages calls it
// after each one. It may be called from any goroutine.
func (r *Relay) ServersChanged() {
	l := &r.libs
	l.change.Lock()
	defer l.change.Unlock()
	l.mu.Lock()
	n := len(l.of)
	l.mu.Unlock()
	if n == 0 {
		return
	}
	names := map[string]string{}
	for _, v := range r.o.Servers.Views() {
		if !v.Local {
			names[v.ID] = v.Name
		}
	}
	var changed []library.View
	l.mu.Lock()
	for entry, k := range l.of {
		if name, ok := names[entry]; ok && name != k.name {
			k.name = name
			l.of[entry] = k
			changed = append(changed, k.view(entry))
		}
	}
	l.mu.Unlock()
	for _, v := range changed {
		r.o.Bridge.Broadcast(library.Event{Type: library.EventLibrary, Library: v})
	}
}

// arrived waits until the copy of the entry's library is one for which has is true, and the
// pages were sent it: at once when it is so already, for libraryWait at most, and not past the
// copy's end, ctx's or the relay's.
func (r *Relay) libraryArrived(ctx context.Context, entry string, has func(library.Tree) bool) {
	l := &r.libs
	// With change held no copy is between its keep and its send.
	l.change.Lock()
	l.mu.Lock()
	k, ok := l.of[entry]
	if !ok || has(k.tree) {
		l.mu.Unlock()
		l.change.Unlock()
		return
	}
	w := &libraryWaiter{has: has, done: make(chan struct{})}
	l.waiters[entry] = append(l.waiters[entry], w)
	l.mu.Unlock()
	l.change.Unlock()

	t := time.NewTimer(l.wait)
	defer t.Stop()
	select {
	case <-w.done:
		return
	case <-t.C:
	case <-ctx.Done():
	case <-r.ctx.Done():
	}
	l.mu.Lock()
	l.waiters[entry] = slices.DeleteFunc(l.waiters[entry], func(o *libraryWaiter) bool { return o == w })
	if len(l.waiters[entry]) == 0 {
		delete(l.waiters, entry)
	}
	l.mu.Unlock()
}

// ---- a page's calls ----

// RemoteLibrary passes the calls that change the library of one entry on to that entry's server,
// over the connection this server holds to it. Its methods are those of *library.Store, and so
// are its refusals: a call that breaks a rule of the library is refused by the library's server,
// and comes back as the *library.Refusal that server made. Every other error is an *Error: the
// entry is not connected (503 server_unreachable; nothing was sent), no answer came (504
// no_answer), or the answer cannot be used (502).
//
// What a call answers with was checked as a copy is (library.CheckGroup, library.CheckPrompt),
// and by then the pages have had the library with the change in it.
type RemoteLibrary struct {
	r     *Relay
	ctx   context.Context
	entry string
}

// Library is the library of the entry for a call of a page that ends with ctx; ok is false for
// an entry whose library is not known here: the local entry, an unknown one, a server that
// offers none and one that has not connected in this process.
func (r *Relay) Library(ctx context.Context, entry string) (l *RemoteLibrary, ok bool) {
	if _, ok := r.libs.get(entry); !ok {
		return nil, false
	}
	return &RemoteLibrary{r: r, ctx: ctx, entry: entry}, true
}

// libraryOffline is the answer of a call for the library of an entry that is not connected.
func (r *Relay) libraryOffline(entry string) *Error {
	e := r.unreachable(entry)
	e.Text = r.name(entry) + " is not connected: its prompts cannot be changed until it is back."
	return e
}

// call passes one call on and reads its answer into out. path is the part after the library's
// own, in is the body or nil.
func (l *RemoteLibrary) call(method, path string, in, out any) error {
	r := l.r
	k, ok := r.libs.get(l.entry)
	switch {
	case !ok:
		return &Error{Status: http.StatusNotFound, Code: "no_server", Text: "This server has no prompt library here."}
	case !k.up:
		r.o.Servers.Retry(l.entry)
		return r.libraryOffline(l.entry)
	}
	var body []byte
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return err
		}
	}
	// The server's own library is the one under its local entry's id.
	rep, err := r.call(l.ctx, l.entry, method, "/api/library/"+servers.LocalID+path, body, r.o.Limits.Call)
	switch {
	case errors.Is(err, ErrUnreachable), err == nil && rep.Status == http.StatusUnauthorized:
		return r.libraryOffline(l.entry)
	case err != nil:
		return r.unmade(l.entry, err)
	case rep.Status != http.StatusOK:
		return r.libraryRefused(l.entry, rep)
	}
	if out != nil && json.Unmarshal(rep.Body, out) != nil {
		return r.badAnswer(l.entry)
	}
	return nil
}

// libraryRefused is an answer that is no success. A refusal of the library's rules is handed on
// as the one it is, with its code and its sentence; any other answer is this server's 502, with
// what the other server said. The sentence is shown, so it is held to plain text and cut.
func (r *Relay) libraryRefused(entry string, rep servers.Reply) error {
	s := saidIn(rep)
	text := plain(s.Error, saidMax)
	if library.IsCode(s.Code) {
		if text == "" {
			text = r.name(entry) + " refused this."
		}
		return &library.Refusal{Code: s.Code, Text: text}
	}
	if text == "" {
		text = fmt.Sprintf("%s answered with status %d.", r.name(entry), rep.Status)
	} else {
		text = r.name(entry) + " could not do this: " + text
	}
	return &Error{Status: http.StatusBadGateway, Text: text}
}

// plain is s as one line of plain text of at most max characters.
func plain(s string, max int) string {
	s = strings.Map(func(c rune) rune {
		if unicode.IsControl(c) || c == ' ' || c == ' ' {
			return ' '
		}
		return c
	}, strings.ToValidUTF8(s, ""))
	s = strings.TrimSpace(s)
	if c := []rune(s); len(c) > max {
		s = string(c[:max]) + "…"
	}
	return s
}

// group is the group a call answered with, when it is one and has arrived here.
func (l *RemoteLibrary) group(g library.Group) (library.Group, error) {
	if library.CheckGroup(g) != nil {
		return library.Group{}, l.r.badAnswer(l.entry)
	}
	l.r.libraryArrived(l.ctx, l.entry, func(t library.Tree) bool { return slices.Contains(t.Groups, g) })
	return g, nil
}

// prompt is group for a prompt.
func (l *RemoteLibrary) prompt(p library.Prompt) (library.Prompt, error) {
	if library.CheckPrompt(p) != nil {
		return library.Prompt{}, l.r.badAnswer(l.entry)
	}
	l.r.libraryArrived(l.ctx, l.entry, func(t library.Tree) bool { return slices.Contains(t.Prompts, p) })
	return p, nil
}

// noGroup and noPrompt refuse an id that is not one, here: no library has such an item, and the
// id goes into the path of the call.
func noGroup() *library.Refusal {
	return &library.Refusal{Code: library.CodeNotFound, Text: "This group no longer exists."}
}

func noPrompt() *library.Refusal {
	return &library.Refusal{Code: library.CodeNotFound, Text: "This prompt no longer exists."}
}

type groupAnswer struct {
	Group library.Group `json:"group"`
}

type promptAnswer struct {
	Prompt library.Prompt `json:"prompt"`
}

func (l *RemoteLibrary) CreateGroup(name, parent string) (library.Group, error) {
	var out groupAnswer
	if err := l.call(http.MethodPost, "/groups", library.NewGroup{Name: name, Parent: parent}, &out); err != nil {
		return library.Group{}, err
	}
	return l.group(out.Group)
}

func (l *RemoteLibrary) ChangeGroup(id string, c library.GroupChange) (library.Group, error) {
	var out groupAnswer
	if !library.IsGroupID(id) {
		return library.Group{}, noGroup()
	}
	if err := l.call(http.MethodPatch, "/groups/"+url.PathEscape(id), c, &out); err != nil {
		return library.Group{}, err
	}
	return l.group(out.Group)
}

func (l *RemoteLibrary) DeleteGroup(id string) error {
	if !library.IsGroupID(id) {
		return noGroup()
	}
	if err := l.call(http.MethodDelete, "/groups/"+url.PathEscape(id), nil, nil); err != nil {
		return err
	}
	l.r.libraryArrived(l.ctx, l.entry, func(t library.Tree) bool {
		return !slices.ContainsFunc(t.Groups, func(g library.Group) bool { return g.ID == id })
	})
	return nil
}

func (l *RemoteLibrary) CreatePrompt(name, parent, text string) (library.Prompt, error) {
	var out promptAnswer
	if err := l.call(http.MethodPost, "/prompts", library.NewPrompt{Name: name, Parent: parent, Text: text}, &out); err != nil {
		return library.Prompt{}, err
	}
	return l.prompt(out.Prompt)
}

func (l *RemoteLibrary) ChangePrompt(id string, c library.PromptChange) (library.Prompt, error) {
	var out promptAnswer
	if !library.IsPromptID(id) {
		return library.Prompt{}, noPrompt()
	}
	if err := l.call(http.MethodPatch, "/prompts/"+url.PathEscape(id), c, &out); err != nil {
		return library.Prompt{}, err
	}
	return l.prompt(out.Prompt)
}

func (l *RemoteLibrary) DeletePrompt(id string) error {
	if !library.IsPromptID(id) {
		return noPrompt()
	}
	if err := l.call(http.MethodDelete, "/prompts/"+url.PathEscape(id), nil, nil); err != nil {
		return err
	}
	l.r.libraryArrived(l.ctx, l.entry, func(t library.Tree) bool {
		return !slices.ContainsFunc(t.Prompts, func(p library.Prompt) bool { return p.ID == id })
	})
	return nil
}
