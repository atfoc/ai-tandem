package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/server"
)

// tooOld is the answer a server of level 6 gives an app that states no level, or one below 6, on
// every route but hello.
const (
	tooOldSentence = "This app is too old for this server: update AI Whiteboard on the machine that connects."
	tooOldBody     = `{"code":"client_too_old","error":"` + tooOldSentence + `"}`
)

// An app of before level 6 is refused, with a reason. It has the secret and a valid client id and
// states no level, or level 5 as the app of before did: the server gives it hello, so that it still
// shows the server's version and level, and answers everything else 400 client_too_old: the state,
// the stream, a write, and a route outside the table. Nothing of the tree reaches it and nothing
// is made for it. A level below 6, and one that is no number, are refused the same. The server's
// log holds one line for all of it, and the same client is served once it states level 6.
func TestOldAppIsRefused(t *testing.T) {
	serverTest(t, "TestClientListenerServes (the state for a client that states no level, or one below 6) (this package)")
	in := newInstance(t)
	secret := in.secret
	in.launchJSON(t, "launch")
	// Something in the tree that the refusals must not show: a group, made by a client of level 6.
	const name = "A group of the owner"
	as := func(level, method, path string, body any) (int, string) {
		t.Helper()
		status, raw, err := requestAt(context.Background(), in.base(), in.fpr, in.secret, testClient, level, method, path, body)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		return status, strings.TrimSpace(string(raw))
	}
	if status, raw := as(testLevel, "POST", "/api/groups", map[string]any{"name": name, "parent": ""}); status != http.StatusOK {
		t.Fatalf("a group made by a client of level 6: status %d: %s", status, raw)
	}

	// Hello is open to every app that has the secret.
	status, raw := as("", "GET", "/api/hello", nil)
	var hello map[string]any
	if err := json.Unmarshal([]byte(raw), &hello); status != http.StatusOK || err != nil || hello["app"] != "ai-whiteboard" ||
		hello["featureLevel"] != float64(6) || server.FeatureLevel != 6 || hello["version"] == nil {
		t.Fatalf("hello for an app that states no level: status %d: %s; want 200 with the feature level 6", status, raw)
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
		{"the state, with the level 5 of the app of before", "5", "GET", "/api/state", nil},
		{"the event stream, with the level 5", "5", "GET", "/api/events", nil},
		{"the state, with the level 4", "4", "GET", "/api/state", nil},
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

	// The same client, once it states level 6, is served; nothing was made by what was refused.
	status, raw = as(testLevel, "GET", "/api/state", nil)
	var state struct {
		Groups []model.Group
		Chats  []model.ChatView
	}
	if err := json.Unmarshal([]byte(raw), &state); status != http.StatusOK || err != nil ||
		len(state.Groups) != 1 || state.Groups[0].Name != name || len(state.Chats) != 0 {
		t.Fatalf("the state for the client at level 6: status %d: %s; want the one group and no chat", status, raw)
	}
	if status, raw := as("7", "GET", "/api/state", nil); status != http.StatusOK {
		t.Fatalf("the state for a client of a later level: status %d: %s", status, raw)
	}
	in.page(t, testClient).Welcome() // the stream for the client at level 6 opens
}
