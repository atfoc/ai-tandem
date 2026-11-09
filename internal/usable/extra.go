package usable

import "ai-whiteboard/internal/model"

// Extra is a source of agent kinds beyond Claude Code, Cursor and pi: the Claude accounts
// (internal/aliases), each the kind model.AliasKind(id). A Set given one lists, after the fixed
// kinds in defaults.AgentOrder, the accounts' kinds that Check passes, in Kinds' order; its Check
// of an account kind is Extra's Check (as an *UnusableError); its Name of one is Extra's Name.
// Set.SetExtra gives it one. Whoever changes what Extra answers calls the Set's Refresh after the
// change, with none of the locks Extra's methods take held: the Set calls them during Refresh.
type Extra interface {
	// Kinds is every account's kind, in the order the accounts were added.
	Kinds() []model.AgentKind
	// Check says whether the account kind a can be used now: nil, or the reason, whose text the
	// person reads ("Not logged in", "Docker is not running", aliases.ErrRemoved for a kind that
	// is no account). It answers from what is known and never waits on Docker or Claude.
	Check(a model.AgentKind) error
	// Name is the account's name ("Claude · Work"), "" for a kind that is no account.
	Name(a model.AgentKind) string
}
