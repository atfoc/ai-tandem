// Package aliaschats makes the Claude accounts (internal/aliases) the chat manager's
// chats.Accounts. It is its own package because aliases must not import chats.
package aliaschats

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"sync"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// nameTimeout bounds one naming run: making the account's container ready and the claude
// process.
const nameTimeout = 60 * time.Second

// Accounts makes svc a chats.Accounts: Spawner and CheckFolder are svc's; Namer names a chat
// with the account's own Claude, run in its container through svc.RunnerFor(kind).
func Accounts(svc *aliases.Service) chats.Accounts { return accounts{svc} }

type accounts struct{ svc *aliases.Service }

var _ chats.Accounts = accounts{}

func (a accounts) Spawner(kind model.AgentKind) agent.Spawner { return a.svc.Spawner(kind) }

// Prepare makes the account's container ready (Service.Prepare).
func (a accounts) Prepare(kind model.AgentKind) error { return a.svc.Prepare(kind) }

func (a accounts) CheckFolder(kind model.AgentKind, cwd string) error {
	return a.svc.CheckFolder(kind, cwd)
}

// Namer is the namer of the account kind; an untyped nil when kind is no account.
func (a accounts) Namer(kind model.AgentKind) chats.Namer {
	r := a.svc.RunnerFor(kind)
	if r == nil {
		return nil
	}
	return namer{runner: r, dir: a.svc.DirOf(kind), timeout: nameTimeout}
}

// namer runs chats.ClaudeNamer's arguments through an account's runner, in the account's folder.
type namer struct {
	runner  agent.Runner
	dir     string
	timeout time.Duration
}

func (n namer) Name(text string) (string, error) {
	out, err := n.output(append([]string{"claude"}, chats.ClaudeNamer{}.Args(text)...))
	if err != nil {
		return "", err
	}
	title := chats.CleanTitle(string(out))
	if title == "" || len(title) > 60 {
		return "", errors.New("no usable title")
	}
	return title, nil
}

// output runs argv through the runner within n.timeout and returns its stdout, as Cmd.Output
// does (a failed exit's stderr is in its *exec.ExitError). The run's Kill is called once at the
// end, and on the timeout the host process is killed with it.
func (n namer) output(argv []string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), n.timeout)
	defer cancel()
	run, err := n.runner.Command(ctx, n.dir, nil, argv)
	if err != nil {
		return nil, err
	}
	var once sync.Once
	kill := func() {
		once.Do(func() {
			if run.Kill != nil {
				run.Kill()
			}
		})
	}
	defer kill()

	cmd := run.Cmd
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-ctx.Done():
		cmd.Process.Kill()
		kill()
		<-done
		return nil, ctx.Err()
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		ee.Stderr = stderr.Bytes()
	}
	if err != nil {
		return nil, err
	}
	return stdout.Bytes(), nil
}
