package agent

import (
	"context"
	"os/exec"
)

// Runner starts an adapter's processes somewhere else than straight on this machine: a Claude
// account's processes run in the account's container (internal/aliases makes its Runner from
// internal/container). An adapter with no Runner starts its program on the host, as before.
//
// Every process the adapter starts goes through it: a chat's, a subagent's, a fork's, the
// context-split reader's, the catalog probe's, auth status, login, logout, usage.
type Runner interface {
	// Command returns the process that runs argv in the folder dir, with env ("NAME=value") added
	// to what the place gives a process. argv[0] is the program as the place finds it ("claude"
	// on the container's PATH). dir and every path in argv and env are the same inside and out.
	// The command is not started; its Stdin, Stdout, Stderr are the caller's to set, its Env is
	// the Runner's (the host process's environment is not handed into the place).
	//
	// It may first make the place ready (create or start the container, build its image), which
	// can take minutes the first time; ctx bounds that. (An account's runner for chats bounds it
	// itself to seconds, since a chat's lock is held: the chat manager prepares the place first,
	// with chats.Accounts.Prepare.) It fails with the reason the place
	// cannot be used, whose text the person reads (Docker not running, the account was removed).
	Command(ctx context.Context, dir string, env []string, argv []string) (*Run, error)
}

// Run is one process a Runner made.
type Run struct {
	Cmd *exec.Cmd
	// ID tags the run where it runs (a container's AIWB_RUN), "" = none.
	ID string
	// Kill ends, where the process runs, the process and everything it started (in a container:
	// every process of the run, which ending the host's `docker exec` does not end). It returns
	// once the kill was delivered or failed, within a few seconds. The host process (Cmd) is the
	// caller's to end, as for a process with no Runner. nil = nothing more than that to end.
	Kill func() error
	// Release tells the Runner that the run is over and will not be killed: Cmd was never
	// started, or it has been waited for and ended by itself. The Runner may then forget the run
	// (an account's runner keeps its live runs, to kill them at a removal or the server's end).
	// The caller of Command calls either Kill or Release once the run is over; calling both, or
	// either again, is harmless. nil = nothing to tell.
	Release func()
}

// ReleaseRun calls run.Release when run has one.
func ReleaseRun(run *Run) {
	if run != nil && run.Release != nil {
		run.Release()
	}
}
