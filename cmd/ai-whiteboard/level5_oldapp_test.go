package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/server"
)

// tooOld is the answer a server of level 5 gives an app that states no level, or one below 5, on
// every route but hello.
const (
	tooOldSentence = "This app is too old for this server: update AI Whiteboard on the machine that connects."
	tooOldBody     = `{"code":"client_too_old","error":"` + tooOldSentence + `"}`
)

// An app of before level 5 is refused, with a reason (the contract's V2 and 2.1). It has the
// secret and a valid client id and states no level: the updated server gives it hello, so that it
// still shows the server's version and level, and answers everything else 400 client_too_old:
// the state, the stream, a write, and a route outside the table. Nothing of the tree reaches it
// and nothing is made for it. A level below 5, and one that is no number, are refused the same.
// The server's log holds one line for all of it, and the same client is served once it states
// level 5.
func TestLevel5RefusesAnOlderApp(t *testing.T) {
	serverTest(t, "TestRemoteListenerServes (the state for a client that states no level, or one below 5) (this package)")
	in, port := newRemoteInstance(t)
	secret, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)
	in.run(t, "launch")
	in.waitListening(t)
	// Something in the tree that the refusals must not show: a group, made by the server's own page.
	const name = "A group of the owner"
	as := func(level, method, path string, body any) (int, string) {
		t.Helper()
		status, raw := remoteCall(t, port, fp, secret, testClient, level, method, path, body)
		return status, strings.TrimSpace(string(raw))
	}
	if status, raw := as(testLevel, "POST", "/api/groups", map[string]any{"name": name, "parent": ""}); status != http.StatusOK {
		t.Fatalf("a group made by a client of level 5: status %d: %s", status, raw)
	}

	// Hello is open to every app that has the secret.
	status, raw := as("", "GET", "/api/hello", nil)
	var hello map[string]any
	if err := json.Unmarshal([]byte(raw), &hello); status != http.StatusOK || err != nil || hello["app"] != "ai-whiteboard" ||
		hello["featureLevel"] != float64(5) || server.FeatureLevel != 5 || hello["version"] == nil {
		t.Fatalf("hello for an app that states no level: status %d: %s; want 200 with the feature level 5", status, raw)
	}

	// Everything else is refused: the state first, whose line the log gets.
	const chat = "c3e1f5a7-9b2d-4e6f-8a1c-3d5e7f9a1b2c"
	for _, c := range []struct {
		what, level, method, path string
		body                      any
	}{
		{"the state", "", "GET", "/api/state", nil},
		{"the event stream", "", "GET", "/api/events", nil},
		{"a new chat", "", "POST", "/api/chats", map[string]any{"id": chat, "agent": "claude", "group": model.Ungrouped}},
		{"the creation call of before", "", "POST", "/api/chats", map[string]any{"id": chat, "agent": "claude", "cwd": t.TempDir(), "text": "A first message."}},
		{"a new group", "", "POST", "/api/groups", map[string]any{"name": "Made by an older app", "parent": ""}},
		{"a route outside the table", "", "GET", "/api/servers", nil},
		{"the state, with the level 4", "4", "GET", "/api/state", nil},
		{"the event stream, with the level 4", "4", "GET", "/api/events", nil},
		{"the state, with the level 0", "0", "GET", "/api/state", nil},
		{"the state, with a level that is no number", "five", "GET", "/api/state", nil},
		{"the state, with an empty level", " ", "GET", "/api/state", nil},
	} {
		status, raw := as(c.level, c.method, c.path, c.body)
		if status != http.StatusBadRequest || raw != tooOldBody {
			t.Errorf("%s: status %d: %s; want 400 %s", c.what, status, raw, tooOldBody)
		}
		if strings.Contains(raw, name) {
			t.Errorf("%s: the refusal holds a part of the tree: %s", c.what, raw)
		}
	}

	// One line in the log for the address, of the first refused request, and no secret in it.
	line := fmt.Sprintf("remote listener: refused 400 from 127.0.0.1: GET %q: %s\n", "/api/state", tooOldSentence)
	waitLog(t, in.dir, line)
	log := serverLog(t, in.dir)
	if n := strings.Count(log, "remote listener: refused"); n != 1 || strings.Count(log, tooOldSentence) != 1 {
		t.Fatalf("the log holds %d lines of refused requests, want the one of the state:\n%s", n, log)
	}
	noSecret(t, secret, log)

	// The same client, once it states level 5, is served; nothing was made by what was refused.
	status, raw = as(testLevel, "GET", "/api/state", nil)
	var state struct {
		Groups []model.Group
		Chats  []model.ChatView
	}
	if err := json.Unmarshal([]byte(raw), &state); status != http.StatusOK || err != nil ||
		len(state.Groups) != 1 || state.Groups[0].Name != name || len(state.Chats) != 0 {
		t.Fatalf("the state for the client at level 5: status %d: %s; want the one group and no chat", status, raw)
	}
	if status, raw := as("6", "GET", "/api/state", nil); status != http.StatusOK {
		t.Fatalf("the state for a client of a later level: status %d: %s", status, raw)
	}
	if status, _ := streamStatus(t, port, fp, secret, testClient); status != http.StatusOK {
		t.Fatalf("the stream for the client at level 5: status %d, want 200", status)
	}
}
