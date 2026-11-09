package model

import "testing"

func TestAgentKindFamilies(t *testing.T) {
	work := AliasKind("a_k3j2m9x0")
	if work != "claude:a_k3j2m9x0" {
		t.Fatalf("AliasKind = %q", work)
	}
	if id, ok := AliasID(work); !ok || id != "a_k3j2m9x0" {
		t.Fatalf("AliasID(%q) = %q, %v", work, id, ok)
	}
	cases := []struct {
		kind              AgentKind
		alias, claude, ok bool
		family            AgentKind
	}{
		{Claude, false, true, true, Claude},
		{Cursor, false, false, true, Cursor},
		{Pi, false, false, true, Pi},
		{work, true, true, true, Claude},
		{"claude:", false, false, false, "claude:"},
		{"claude:a_short", false, false, false, "claude:a_short"},
		{"claude:a_K3J2M9X0", false, false, false, "claude:a_K3J2M9X0"},
		{"claude:a_k3j2m9x0/x", false, false, false, "claude:a_k3j2m9x0/x"},
		{"cursor:a_k3j2m9x0", false, false, false, "cursor:a_k3j2m9x0"},
		{"", false, false, false, ""},
	}
	for _, c := range cases {
		if got := IsAlias(c.kind); got != c.alias {
			t.Errorf("IsAlias(%q) = %v", c.kind, got)
		}
		if got := IsClaude(c.kind); got != c.claude {
			t.Errorf("IsClaude(%q) = %v", c.kind, got)
		}
		if got := ValidKind(c.kind); got != c.ok {
			t.Errorf("ValidKind(%q) = %v", c.kind, got)
		}
		if got := c.kind.Family(); got != c.family {
			t.Errorf("%q.Family() = %q", c.kind, got)
		}
	}
	if _, ok := AliasID(Claude); ok {
		t.Error("AliasID(Claude) is ok")
	}
}
