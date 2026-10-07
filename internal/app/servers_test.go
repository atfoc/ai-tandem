package app

import (
	"encoding/json"
	"strings"
	"testing"

	"ai-whiteboard/internal/servers"
)

// The snapshot of an app without a server list names this computer alone.
func TestSnapshotServersWithoutAManager(t *testing.T) {
	e := newEnv(t)
	got := e.a.Snapshot().Servers
	if len(got) != 1 || got[0].ID != servers.LocalID || !got[0].Local || got[0].Name != servers.LocalName || got[0].State != servers.StateConnected {
		t.Fatalf("servers: %+v", got)
	}
	raw, err := json.Marshal(e.a.Snapshot())
	if err != nil || !strings.Contains(string(raw), `"servers":[{"id":"local","local":true,"name":"This computer","state":"connected"}]`) {
		t.Fatalf("the snapshot: %s, %v", raw, err)
	}
}

// With a list the snapshot is the list's own view: the local entry first, and no secret.
func TestSnapshotServers(t *testing.T) {
	e := newEnv(t)
	m, err := servers.Open(servers.Options{Root: t.TempDir(), LocalID: "11111111-2222-4333-8444-555555555555", Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close) // never started: nothing is dialed
	if _, saved, _, err := m.Add(t.Context(), servers.Input{Name: "Studio", Address: "https://127.0.0.1:1", Secret: "not-for-the-page"}, true); err != nil || !saved {
		t.Fatalf("add: %v, saved %v", err, saved)
	}
	e.a.Servers = m
	got := e.a.Snapshot().Servers
	if len(got) != 2 || got[0].ID != servers.LocalID || got[0].Version != "test" || got[1].Name != "Studio" || got[1].Address != "https://127.0.0.1:1" {
		t.Fatalf("servers: %+v", got)
	}
	if raw, err := json.Marshal(e.a.Snapshot()); err != nil || strings.Contains(string(raw), "not-for-the-page") {
		t.Fatalf("the snapshot: %s, %v", raw, err)
	}
}
