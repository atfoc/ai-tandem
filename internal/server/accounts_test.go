package server

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// An account's refusal keeps its own code when it comes wrapped in a *usable.UnusableError (which
// is usable.ErrMissing to errors.Is); a plain reason so wrapped is a missing agent. All are 409.
func TestAccountRefusalCodes(t *testing.T) {
	t.Parallel()
	acct := model.AliasKind("a_k3j2m9x0")
	unusable := func(err error) error { return &usable.UnusableError{Agent: acct, Err: err} }
	docker := &container.Unavailable{Kind: container.NotRunning, Reason: "Docker is not running"}
	for _, c := range []struct {
		what string
		err  error
		code string
	}{
		{"removed account", unusable(aliases.ErrRemoved), aliases.CodeRemoved},
		{"Docker unavailable", unusable(docker), aliases.CodeDocker},
		{"Docker unavailable, wrapped once more", fmt.Errorf("send: %w", unusable(docker)), aliases.CodeDocker},
		{"not logged in", unusable(errors.New("Not logged in")), "agent_missing"},
		{"missing program", &usable.MissingError{Agent: model.Cursor, Bin: "agent"}, "agent_missing"},
		{"folder not mounted", &aliases.MountError{Account: "Claude · Work", Folder: "/w"}, aliases.CodeNotMounted},
		{"folder mount pending", &aliases.MountError{Account: "Claude · Work", Folder: "/w", Pending: true}, aliases.CodeMountPending},
		{"mount refusal as an account's reason", unusable(&aliases.MountError{Account: "Claude · Work", Pending: true}), aliases.CodeMountPending},
		{"bare Docker unavailable", docker, aliases.CodeDocker},
		{"bare removed", aliases.ErrRemoved, aliases.CodeRemoved},
		{"restarting account", unusable(aliases.ErrRestarting), aliases.CodeRestarting},
		{"bare restarting", aliases.ErrRestarting, aliases.CodeRestarting},
		{"usage of a stopped account", aliases.ErrStopped, aliases.CodeStopped},
		{"container being prepared", aliases.ErrPreparing, aliases.CodePreparing},
		{"container being prepared, wrapped", fmt.Errorf("spawn: %w", aliases.ErrPreparing), aliases.CodePreparing},
	} {
		if got := codeOf(c.err); got != c.code {
			t.Errorf("%s: codeOf = %q, want %q", c.what, got, c.code)
		}
		if got := statusOf(c.err, http.StatusTeapot); got != http.StatusConflict {
			t.Errorf("%s: statusOf = %d, want 409", c.what, got)
		}
	}
}

// An account's image that is not an image reference is a 400 with the code bad_image.
func TestBadImageCode(t *testing.T) {
	t.Parallel()
	err := &aliases.ImageError{Image: "--privileged"}
	if got := codeOf(err); got != aliases.CodeBadImage {
		t.Errorf("codeOf = %q", got)
	}
	if got := statusOf(err, http.StatusTeapot); got != http.StatusBadRequest {
		t.Errorf("statusOf = %d", got)
	}
}

// GET /api/usage/{agent} asks UsageFor of a kind Usage has no entry for, and answers 404 when
// neither has a call for it.
func TestUsageForAccounts(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	acct, other := model.AliasKind("a_k3j2m9x0"), model.AliasKind("a_00000000")

	var asked []model.AgentKind
	var gotFresh []bool
	e.s.Usage = map[model.AgentKind]func(bool) (model.PlanUsage, error){
		model.Claude: func(bool) (model.PlanUsage, error) {
			return model.PlanUsage{Plan: true, Limits: []model.UsageLimit{{Kind: "session", Percent: 1}}}, nil
		},
	}
	e.s.UsageFor = func(a model.AgentKind) func(bool) (model.PlanUsage, error) {
		asked = append(asked, a)
		if a != acct {
			return nil
		}
		return func(fresh bool) (model.PlanUsage, error) {
			gotFresh = append(gotFresh, fresh)
			return model.PlanUsage{Plan: true, Limits: []model.UsageLimit{{Kind: "session", Percent: 42}}}, nil
		}
	}

	if u := decode[model.PlanUsage](t, e.expect(200, "GET", "/api/usage/claude", "")); len(u.Limits) != 1 || u.Limits[0].Percent != 1 {
		t.Fatalf("claude usage %+v", u)
	}
	if len(asked) != 0 {
		t.Fatalf("UsageFor asked of %v, a kind Usage has", asked)
	}
	if u := decode[model.PlanUsage](t, e.expect(200, "GET", "/api/usage/"+string(acct)+"?fresh=1", "")); len(u.Limits) != 1 || u.Limits[0].Percent != 42 {
		t.Fatalf("account usage %+v", u)
	}
	if len(gotFresh) != 1 || !gotFresh[0] {
		t.Fatalf("fresh %v", gotFresh)
	}
	e.expect(404, "GET", "/api/usage/"+string(other), "")
	e.expect(404, "GET", "/api/usage/cursor", "")
	if want := []model.AgentKind{acct, other, model.Cursor}; fmt.Sprint(asked) != fmt.Sprint(want) {
		t.Fatalf("UsageFor asked of %v, want %v", asked, want)
	}
}
