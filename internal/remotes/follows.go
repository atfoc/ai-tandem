package remotes

// Who follows a chat of a section. A page follows the thing here, keyed by the entry's
// id and the thing's; this server follows it on its server for all its pages together, as one
// client there. A read that follows starts both, the page's follow here first; the last page
// that unfollows here ends this server's follow there. So this server follows a thing there
// exactly while one of its pages does.
//
// The follows of one thing on its server are ordered by a lock per thing (Relay.reads): a read
// holds it shared while it is passed on, the unfollow call holds it alone, so an unfollow never
// overtakes a read. A follow ends here, with no call, when the entry's tree goes
// (Bridge.ForgetServer): that server forgot it with the stream.

import (
	"context"
	"errors"
	"net/http"
	"sync"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/servers"
)

// itemLocks is a read-write lock per item. The zero value is ready.
type itemLocks struct {
	mu   sync.Mutex
	held map[editorbridge.Item]*itemLock
}

type itemLock struct {
	mu sync.RWMutex
	n  int // holders and waiters
}

// lock takes the item's lock, shared or alone, waiting for it.
func (l *itemLocks) lock(it editorbridge.Item, shared bool) (unlock func()) {
	l.mu.Lock()
	k := l.held[it]
	if k == nil {
		if l.held == nil {
			l.held = map[editorbridge.Item]*itemLock{}
		}
		k = &itemLock{}
		l.held[it] = k
	}
	k.n++
	l.mu.Unlock()
	if shared {
		k.mu.RLock()
	} else {
		k.mu.Lock()
	}
	return func() {
		if shared {
			k.mu.RUnlock()
		} else {
			k.mu.Unlock()
		}
		l.mu.Lock()
		if k.n--; k.n == 0 {
			delete(l.held, it)
		}
		l.mu.Unlock()
	}
}

// FollowChat passes a read of the chat id of the section entry on, as Pass does within
// Limits.Call, and makes the page a follower of the chat from before the read is sent: the
// chat's content events reach the page from here on. It is for GET …/items, …/tree and
// …/subagents/{sid}/items. A read that is answered 404 not_found leaves no follow, and nor does
// one that was not sent. Its answers are those of Pass.
func (r *Relay) FollowChat(ctx context.Context, entry, page, id, pathAndQuery string) Reply {
	return r.follow(ctx, editorbridge.ChatOn(entry, id), page, pathAndQuery)
}

// follow passes a read of the item on for the page, which follows the item from here on: the
// item's lock is held shared over the follow and the call. The read makes this server a
// follower there. When the page has no stream here, so that no page's follow will ever end, the
// follow there is ended after the read, unless a page follows the item.
func (r *Relay) follow(ctx context.Context, it editorbridge.Item, page, pathAndQuery string) Reply {
	entry := it.Server
	if e := r.Ready(entry); e != nil {
		return e.Reply()
	}
	unlock := r.reads.lock(it, true)
	followed := r.o.Bridge.FollowAs(editorbridge.KindPage, page, it)
	rep, err := r.call(ctx, entry, http.MethodGet, pathAndQuery, nil, r.o.Limits.Call)
	unlock()
	if !followed && !errors.Is(err, ErrUnreachable) {
		r.spawn(func() { r.unfollow(it) })
	}
	switch {
	case errors.Is(err, ErrUnreachable):
		// Nothing was sent: that server follows nothing for it, and nor does the page here.
		r.o.Bridge.UnfollowAs(editorbridge.KindPage, page, it)
		return r.unmade(entry, err).Reply()
	case err != nil:
		return r.unmade(entry, err).Reply()
	case notFound(rep):
		r.o.Bridge.UnfollowAs(editorbridge.KindPage, page, it) // nothing follows a thing that is gone
	}
	return r.handed(entry, rep)
}

// UnfollowChat serves POST …/chats/{id}/unfollow for a chat of the section entry: the page's
// follow ends here. When it was the chat's last one, the bridge tells the relay, which ends
// this server's follow there (see Unfollowed). The answer is 200 {"ok":true} in every state of
// the entry, and 404 no_server for an id that is no entry: a follow of it never began.
func (r *Relay) UnfollowChat(entry, page, id string) Reply {
	return r.unfollowAs(page, editorbridge.ChatOn(entry, id))
}

func (r *Relay) unfollowAs(page string, it editorbridge.Item) Reply {
	if !r.Listed(it.Server) {
		return noServer().Reply()
	}
	r.o.Bridge.UnfollowAs(editorbridge.KindPage, page, it)
	return okReply
}

// Unfollowed is the function for Bridge.OnUnfollowed: items lost their last follower here. For
// each one that is a chat of another server, that server is told to end this server's
// follow, unless a page follows the item again by then or the entry is not connected. An item
// with no server is this server's own and is left alone.
func (r *Relay) Unfollowed(items []editorbridge.Item) {
	for _, it := range items {
		if it.Server == "" || it.Kind != "chat" {
			continue
		}
		r.spawn(func() { r.unfollow(it) })
	}
}

// unfollow makes the unfollow call for the item, with the item's lock held alone.
func (r *Relay) unfollow(it editorbridge.Item) {
	defer r.reads.lock(it, false)()
	if r.o.Bridge.Followed(it) || !r.held(it.Server) {
		return // followed again, or that server forgot the follow with its stream
	}
	path := chatPath(it.ID, "/unfollow")
	// Not through call: an entry that is not connected follows nothing, and is not woken for this.
	rep, err := r.o.Servers.Do(r.ctx, it.Server, http.MethodPost, path, nil, r.o.Limits.Unfollow)
	switch {
	case err == nil && (rep.Status == http.StatusOK || rep.Status == http.StatusNotFound),
		errors.Is(err, servers.ErrNotConnected), errors.Is(err, servers.ErrNotFound), r.ctx.Err() != nil:
	// The log is a file of this machine: it names the entry, and nothing of what is on its server.
	case err != nil:
		r.o.Logf("remotes: the unfollow of a %s on the server %s got no answer", it.Kind, it.Server)
	default:
		r.o.Logf("remotes: the unfollow of a %s on the server %s was answered with %d", it.Kind, it.Server, rep.Status)
	}
}
