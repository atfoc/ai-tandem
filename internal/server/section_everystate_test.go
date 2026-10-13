package server

import (
	"context"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
)

// A section in every state the server list has for an entry, through the real handler and a
// real connection. Connecting, connected and not connected are TestSectionCallsOfAnEntryThatCannotBeAsked;
// this is every other one, a changed certificate among them. In each the page is told that no
// tree is held, its snapshot names the state and has no tree of the entry, every call for a
// thing of the entry has its answer and sends nothing, and the tree is back once the state is
// cured.
func TestSectionInEveryOtherStateOfAnEntry(t *testing.T) {
	t.Parallel()
	f := newRowsFar(t, remotes.Limits{})
	p := f.page("P")
	ctx := context.Background()
	const notConnected = "Studio is not connected."

	// again makes the entry connect anew with what it has, as an edit of the entry does.
	again := func() {
		t.Helper()
		secret := standin.DefaultSecret
		if _, _, _, err := f.m.Edit(ctx, f.entry, servers.Patch{Secret: &secret}, true); err != nil {
			t.Fatal(err)
		}
	}
	edit := func(patch servers.Patch) {
		t.Helper()
		if _, _, _, err := f.m.Edit(ctx, f.entry, patch, true); err != nil {
			t.Fatal(err)
		}
	}
	accept := func() {
		t.Helper()
		if _, err := f.m.Accept(f.entry, f.st.Fingerprint()); err != nil {
			t.Fatal(err)
		}
	}
	hello := func(status int, kind, body string) {
		f.st.SetHello(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", kind)
			w.WriteHeader(status)
			io.WriteString(w, body)
		})
	}
	off, none := false, ""

	cases := []struct {
		state    servers.State
		sentence string
		enter    func() // from connected
		cure     func()
	}{
		{servers.StateSecretNotAccepted, notConnected, func() {
			f.st.SetSecret(strings.Repeat("b", 64))
			f.st.DropStreams()
		}, func() {
			f.st.SetSecret(standin.DefaultSecret)
			again()
		}},
		{servers.StateCertificateChanged, notConnected, func() {
			f.st.SwapCert([]string{"127.0.0.1"}, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
			f.st.DropStreams()
		}, accept},
		{servers.StateFingerprintNotAccepted, notConnected, func() { edit(servers.Patch{Pin: &none}) }, accept},
		{servers.StateCertificateNotAccepted, notConnected, func() { edit(servers.Patch{SelfSigned: &off}) }, accept},
		{servers.StateNameNotKnown, notConnected, func() {
			hello(http.StatusForbidden, "application/json", `{"error":"bad host"}`)
			f.st.DropStreams()
		}, func() {
			f.st.SetHello(nil)
			again()
		}},
		{servers.StateNotAIWB, notConnected, func() {
			hello(http.StatusOK, "text/html; charset=utf-8", "<!doctype html><title>Something else</title>")
			f.st.DropStreams()
		}, func() {
			f.st.SetHello(nil)
			again()
		}},
		{servers.StateAnotherServer, notConnected, func() {
			f.st.SetInstanceID("5e000000-0000-4000-8000-00000000000f")
			f.st.DropStreams()
		}, func() {
			f.st.SetInstanceID(standin.DefaultInstanceID)
			again()
		}},
		{servers.StateTooOld, "Studio is too old: update the server on that machine.", func() {
			f.st.SetFeatureLevel(standin.Level(servers.MinFeatureLevel - 1))
			f.st.DropStreams()
		}, func() {
			f.st.SetFeatureLevel(standin.Level(servers.MinFeatureLevel))
			again()
		}},
	}
	trees := f.trees.Load()
	for _, c := range cases {
		gone := f.nulls.Load() + 1
		c.enter()
		f.wait("the entry is "+string(c.state)+" and its tree is gone", func() bool { return f.state() == c.state && f.nulls.Load() >= gone })
		when := "the entry is " + string(c.state)

		// What a page is handed: the state in the server list, and no tree.
		snap := decode[struct {
			Servers  []servers.View
			Sections map[string]*remotes.Tree
		}](t, mustOK(t, f, p, "GET", "/api/state", ""))
		shown := servers.State("")
		for _, v := range snap.Servers {
			if v.ID == f.entry {
				shown = v.State
			}
		}
		if shown != c.state || snap.Sections == nil || len(snap.Sections) != 0 {
			t.Errorf("%s: the snapshot names the state %q and has the sections %v", when, shown, snap.Sections)
		}

		// Every call has its answer, and nothing is sent for it.
		asked := len(f.st.Requests())
		f.untouched(when, func() {
			for _, call := range stateCalls() {
				call.refused(f, p, f.entry, when, http.StatusServiceUnavailable, "server_unreachable", c.sentence)
			}
			for _, rest := range []string{"/chats/" + farChatA + "/unfollow", "/runs/" + farRunA + "/unfollow"} {
				if got := f.good(p, "POST", f.on(rest), ""); !reflect.DeepEqual(got, map[string]any{"ok": true}) {
					t.Errorf("%s, %s: %v", when, rest, got)
				}
			}
			if got := f.good(p, "POST", f.on("/boards/"+farBoardA+"/release"), ""); !reflect.DeepEqual(got, map[string]any{"state": "none"}) {
				t.Errorf("%s, the release of a board no page holds: %v", when, got)
			}
			f.refuses(p, http.StatusBadRequest, "not_here", "POST", f.on("/boards/"+farBoardA+"/reveal"), "")
		})
		// The entry's own tries apart, which ask the hello and nothing else.
		for _, r := range f.st.Requests()[asked:] {
			if r.Path != servers.HelloPath {
				t.Errorf("%s: the stand-in was sent %s %s", when, r.Method, r.Path)
			}
		}
		if f.state() != c.state || f.section(p) != nil {
			t.Errorf("%s: after the calls the entry is %s, with a tree: %v", when, f.state(), f.section(p) != nil)
		}

		// Cured, the section is that server's tree again and the calls are made.
		c.cure()
		trees++
		f.returned(trees)
		f.wait("the entry is connected after "+string(c.state), func() bool { return f.state() == servers.StateConnected })
		if tree := f.section(p); tree == nil || len(tree.Chats) != 1 || tree.Chats[0].ID != farChatA {
			t.Fatalf("after %s the section is %+v", c.state, tree)
		}
		f.good(p, "GET", f.on("/chats/"+farChatA), "")
	}
}
