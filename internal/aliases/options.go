package aliases

import (
	"time"

	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/model"
)

// Options is what New needs. Root, Containers are required; the rest has defaults.
type Options struct {
	Root string // the app's data folder: aliases.json and aliases/<id> are in it
	// Home is the person's home folder: ~/.claude is Home/.claude, which no account may mount.
	Home string
	// Containers is this server's Docker (*container.Manager).
	Containers Containers
	// Work is the chat manager's view for the accounts ((*chats.Manager).AccountWork()): who
	// works in an account's container. nil until SetWork: then no agent counts as working and
	// nothing is stopped.
	Work Work
	// Store keeps the records; nil = OpenStore(Root, Logf).
	Store Store

	// ClaudeBin is the claude program as the container's PATH finds it; "" = "claude".
	ClaudeBin string
	// Prompt is the whiteboard prompt of a Claude process (prompts.Claude()).
	Prompt string
	// MCPURL is the board's MCP endpoint as a container reaches it:
	// http://host.docker.internal:<port>/mcp.
	MCPURL string
	// Host is the computer's own Claude Code, for List().Host; nil = not known.
	Host HostAuth
	// Claude makes the Claude of an account from its spawner; nil = ClaudeOf. Tests give fakes.
	Claude func(a Alias, sp *claude.Spawner) Claude

	// Broadcast sends a stream event to every client ({"type": EventAliases, "aliases": List});
	// nil = none. It is never called with a lock of the service held.
	Broadcast func(ev any)
	// Changed is called after every change that may change which accounts can be used (a record,
	// a container, a login, Docker): the server refreshes its agent list. nil = none.
	Changed func()
	// Ready is called, from a goroutine of its own, after an account's login succeeded and when
	// its container is first started (or found running) in this run of the server: the server
	// probes the account's model catalog. nil = none.
	Ready func(kind model.AgentKind)
	// Logf logs a line; nil = log.Printf. Nothing of a login's URL or code is ever logged.
	Logf func(format string, args ...any)

	// Waits are the service's time limits; a zero field is its default. Tests shorten them.
	Waits Waits
}

// Waits are the time limits of the service.
type Waits struct {
	Stale      time.Duration // a login state older than this is asked again on List (30 s)
	Status     time.Duration // one `claude auth status` (15 s)
	LoginStart time.Duration // POST …/login waits this long for the URL (60 s, D29)
	Code       time.Duration // POST …/login/code waits this long for Claude (30 s, D29)
	LoginLimit time.Duration // a login run is ended after this (10 min, D21)
	Prepare    time.Duration // a container made ready for a login, its image built included (20 min)
	// Start bounds Prepare (the method): a container made ready for a chat's process, its image
	// built or pulled included, before the chat's lock is taken (5 min, as a chat's runner
	// preparation was bounded before).
	Start time.Duration
	// Run bounds what a chat's process waits for its container, with the chat's lock held (10 s):
	// past it, ErrPreparing.
	Run    time.Duration
	Logout time.Duration // one `claude auth logout` (30 s)
}

// withDefaults is w with every zero field set to its default.
func (w Waits) withDefaults() Waits {
	set := func(d *time.Duration, def time.Duration) {
		if *d <= 0 {
			*d = def
		}
	}
	set(&w.Stale, 30*time.Second)
	set(&w.Status, 15*time.Second)
	set(&w.LoginStart, 60*time.Second)
	set(&w.Code, 30*time.Second)
	set(&w.LoginLimit, 10*time.Minute)
	set(&w.Prepare, 20*time.Minute)
	set(&w.Start, 5*time.Minute)
	set(&w.Run, 2*container.QuickTimeout)
	set(&w.Logout, 30*time.Second)
	return w
}
