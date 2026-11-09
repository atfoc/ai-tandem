package chats

import (
	"errors"
	"os"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// Accounts are the Claude accounts of this server (internal/aliases): each one is an agent kind
// of its own, model.AliasKind(id), whose processes run in the account's container. The chat
// manager reaches an account's spawner and namer through it, never through Deps.Spawners and
// Deps.Namers, which hold the fixed kinds (Claude, Cursor, pi).
type Accounts interface {
	// Spawner is the spawner of the account kind a: an agent.Spawner that is also an
	// agent.SplitReader and an agent.Forker, as Claude's own is. nil (an untyped nil) when a is
	// no account, or one that was removed.
	Spawner(a model.AgentKind) agent.Spawner
	// Namer names the chats of the account kind a, with the account's own Claude; nil = they are
	// not named.
	Namer(a model.AgentKind) Namer
	// CheckFolder says whether a process of the account kind a may work in the folder cwd: nil
	// when cwd is one of the account's applied mounts or a folder under one (the saved mounts
	// while the account has no container yet). Otherwise an error whose text is the sentence the
	// person reads: an *aliases.MountError, or aliases.ErrRemoved.
	CheckFolder(a model.AgentKind, cwd string) error
	// Prepare makes the container of the account kind a ready for a process of a (creates or
	// starts it, builds or pulls its image), waiting as long as that takes (minutes the first
	// time). It answers at once when the container runs already, and nil when a is no account or
	// one that cannot be used now (accountGate then says why). Its error is the reason the
	// container cannot be made ready (Docker's line, a failed image build), as the person reads it.
	// It is called with no lock of the chat manager held, and takes none.
	Prepare(a model.AgentKind) error
}

// spawner is the spawner of the agent kind a: Deps.Spawners' for a fixed kind, the account's for
// a Claude account (Deps.Accounts). nil when there is none.
func (m *Manager) spawner(a model.AgentKind) agent.Spawner {
	if sp := m.Spawners[a]; sp != nil {
		return sp
	}
	if model.IsAlias(a) && m.Accounts != nil {
		return m.Accounts.Spawner(a)
	}
	return nil
}

// namer is the namer of the chats of agent kind a, as spawner is its spawner. nil = not named.
func (m *Manager) namer(a model.AgentKind) Namer {
	if n := m.Namers[a]; n != nil {
		return n
	}
	if model.IsAlias(a) && m.Accounts != nil {
		return m.Accounts.Namer(a)
	}
	return nil
}

// errNoAccounts is the reason an account kind cannot be used on a manager that has no Accounts:
// no account is known there, as usable.Set says of an account kind when it has no Extra.
var errNoAccounts = errors.New("This account was removed")

// accountGate says whether a process of the agent kind a may start now in the folder cwd (goal
// §1.5.4, §1.7.3, §4.2). It is nil for every fixed kind (Claude, Cursor, pi), whose starts are
// what they always were. For a Claude account it is the first of these refusals: the account
// cannot be used now (Agents.Check: a *usable.UnusableError whose text is the reason, "Not logged
// in", Docker's reason, "This account was removed"); the manager has no Accounts (the same, with
// errNoAccounts); the folder is not one the account's container has (Accounts.CheckFolder: an
// *aliases.MountError, or aliases.ErrRemoved). The error is returned as it came, so the server
// tells the refusals apart by their own types.
//
// A folder that does not exist is not asked about: the start then fails with ErrFolderMissing,
// as any chat's does, and the chat shows "Folder not found" rather than a mount the person could
// not add.
//
// It sends nothing and is called with a chat's mu held or none: Agents.Check and
// Accounts.CheckFolder must never take a lock of the chat manager, nor one held by whoever calls
// AccountWork's methods (see StopKind). The wait for the account's container is not here: every
// start on an account is preceded by prepare, with no lock held, and the start itself (the
// account's spawner, under a chat's mu for a chat's own process) is then bounded.
func (m *Manager) accountGate(a model.AgentKind, cwd string) error {
	if !model.IsAlias(a) {
		return nil
	}
	if err := m.Agents.Check(a); err != nil {
		return err
	}
	if m.Accounts == nil {
		return &usable.UnusableError{Agent: a, Err: errNoAccounts}
	}
	if _, err := os.Stat(cwd); err != nil {
		return nil // the start says ErrFolderMissing
	}
	return m.Accounts.CheckFolder(a, cwd)
}

// prepare makes the container of the account kind a ready before a process of a is started
// (Accounts.Prepare), and returns the reason it cannot be. It does nothing for a fixed kind, on
// a manager with no Accounts, and once the manager is down (the start is then refused with
// ErrShutdown under the chat's lock). It may wait minutes, the first time an account's image is
// built: it is called with no lock of the manager or of a chat held, before the start takes the
// chat's mu, so that Views, BusyKind, StopKind and Shutdown never wait for it. Every public call
// that may start a process on an account calls it first; the account's spawner then finds the
// container ready, and its own wait for it, under the chat's mu, is short (it fails with the
// account's "being prepared" error when the container is not ready in time).
func (m *Manager) prepare(a model.AgentKind) error {
	if !model.IsAlias(a) || m.Accounts == nil || m.down.Load() {
		return nil
	}
	return m.Accounts.Prepare(a)
}

// prepareOf is prepare for a start on a chat object that lock returns with its mu held: it reads
// the object's agent, and whether the call would start a process on it (starts), in a brief hold
// of that lock, and calls prepare with it released. The kind read here may change before the
// call takes the lock again; the account's start then copes, bounded. An error of lock is not
// this one's: the call's own lock says it. With no Accounts, or once the manager is down, nothing
// is locked.
func (m *Manager) prepareOf(lock func() (*Chat, error), starts func(c *Chat) bool) error {
	if m.Accounts == nil || m.down.Load() {
		return nil
	}
	c, err := lock()
	if err != nil {
		return nil
	}
	kind, ok := c.meta.Agent, starts(c)
	c.mu.Unlock()
	if !ok {
		return nil
	}
	return m.prepare(kind)
}

// noProcess says that a message to c starts its process: c has none. c.mu held.
func noProcess(c *Chat) bool { return c.ag == nil }

// always says that the call starts a process whatever c holds. c.mu held.
func always(*Chat) bool { return true }
