package defaults

import (
	"testing"

	"ai-whiteboard/internal/model"
)

// A Claude account's model and effort are kept apart from the computer's Claude Code's: each
// resolves to its own, and the folder is shared as it is by every agent.
func TestAccountDefaultsApartFromClaude(t *testing.T) {
	ds := mkdirs(t)
	work, home := model.AliasKind("a_00000001"), model.AliasKind("a_00000002")
	var d model.Defaults
	RecordChange(&d, "g1", model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	RecordChange(&d, "g1", work, "", model.ModelChoice{Model: "haiku"})

	cwd, mc := Resolve(d, "g1", model.Claude, ds.fallback, claudeCat())
	check(t, "claude", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	cwd, mc = Resolve(d, "g1", work, ds.fallback, claudeCat())
	check(t, "work account", cwd, mc, ds.a, model.ModelChoice{Model: "haiku"})
	// An account nothing was recorded for takes its catalog's default, not Claude's choice.
	cwd, mc = Resolve(d, "g1", home, ds.fallback, claudeCat())
	check(t, "home account", cwd, mc, ds.a, model.ModelChoice{Model: "sonnet", Effort: "high"})

	// A later change of one leaves the other alone.
	RecordChange(&d, "g1", work, "", model.ModelChoice{Model: "sonnet", Effort: "low"})
	_, mc = Resolve(d, "g1", model.Claude, ds.fallback, claudeCat())
	check(t, "claude after the account's change", "", mc, "", model.ModelChoice{Model: "opus", Effort: "max"})
	_, mc = Resolve(d, "g1", work, ds.fallback, claudeCat())
	check(t, "work account after its change", "", mc, "", model.ModelChoice{Model: "sonnet", Effort: "low"})
	if by := d.Groups["g1"].Local().ByAgent; len(by) != 2 {
		t.Errorf("byAgent = %+v, want claude and the work account", by)
	}
}

// A stored Claude account is the agent a new chat starts with while it is usable; once it is not
// (removed, or unusable now) the fixed order takes over.
func TestAgentStoredAccount(t *testing.T) {
	t.Parallel()
	work := model.AliasKind("a_00000001")
	var d model.Defaults
	RecordAgent(&d, "g1", work)

	if got := Agent(d, "g1", []model.AgentKind{model.Claude, model.Cursor, model.Pi, work}); got != work {
		t.Errorf("usable account stored = %q, want it", got)
	}
	if got := Agent(d, "g1", []model.AgentKind{model.Claude, model.Cursor, model.Pi}); got != model.Claude {
		t.Errorf("account not usable = %q, want claude", got)
	}
	if got := Agent(d, "g1", []model.AgentKind{model.Pi, work}); got != work {
		t.Errorf("account usable, no claude = %q, want the account", got)
	}
	if got := Agent(d, "g1", []model.AgentKind{model.Cursor, model.Pi}); got != model.Cursor {
		t.Errorf("account and claude not usable = %q, want cursor", got)
	}
	if got := Agent(d, "g1", nil); got != model.Claude {
		t.Errorf("usable nil = %q, want claude (AgentOrder holds no account)", got)
	}

	// The ungrouped group's account stands in for a group without one.
	RecordAgent(&d, model.Ungrouped, work)
	if got := Agent(d, "g2", []model.AgentKind{model.Claude, work}); got != work {
		t.Errorf("ungrouped's account = %q, want it", got)
	}
}
