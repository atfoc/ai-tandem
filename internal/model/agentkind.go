package model

import (
	"regexp"
	"strings"
)

// AliasPrefix starts the agent kind of a Claude account (an alias): "claude:" + the account's id,
// e.g. "claude:a_k3j2m9x0". Claude stays "claude": the computer's own Claude Code.
const AliasPrefix = "claude:"

// aliasID is the form of an account's id: "a_" and 8 base36 characters (NewID("a_")).
var aliasID = regexp.MustCompile(`^a_[0-9a-z]{8}$`)

// AliasKind is the agent kind of the Claude account id.
func AliasKind(id string) AgentKind { return AgentKind(AliasPrefix + id) }

// AliasID is the account id of a Claude account's kind; ok is false for every other kind,
// Claude's own included, and for a kind whose id does not have the form of one.
func AliasID(a AgentKind) (id string, ok bool) {
	id, ok = strings.CutPrefix(string(a), AliasPrefix)
	if !ok || !aliasID.MatchString(id) {
		return "", false
	}
	return id, true
}

// IsAlias reports whether a is the kind of a Claude account (not Claude's own).
func IsAlias(a AgentKind) bool {
	_, ok := AliasID(a)
	return ok
}

// Family is the kind whose adapter runs a: Claude for Claude and for every Claude account, a
// itself for Cursor, pi and anything else. Code that asks how an agent behaves (its session ids,
// its forks, its context split, its catalog) asks it of the family; code that asks which agent
// it is (its name, its usability, its defaults, its catalog's slot) asks it of the kind.
func (a AgentKind) Family() AgentKind {
	if IsAlias(a) {
		return Claude
	}
	return a
}

// IsClaude reports whether a is Claude Code: the computer's own (Claude) or a Claude account.
func IsClaude(a AgentKind) bool { return a == Claude || IsAlias(a) }

// ValidKind reports whether a has the form of an agent kind: Claude, Cursor, pi, or a Claude
// account's kind. It says nothing of whether that account exists or can be used (usable.Set).
func ValidKind(a AgentKind) bool {
	return a == Claude || a == Cursor || a == Pi || IsAlias(a)
}
