package aliases

import (
	"context"

	"ai-whiteboard/internal/claude"
)

// Claude is what the service needs of an account's own Claude Code: its auth status, logout and
// login, each run inside the account's container through the spawner's Runner. ClaudeOf makes
// it of a *claude.Spawner; tests give a fake (Options.Claude).
type Claude interface {
	AuthStatus(ctx context.Context) (claude.Auth, error)
	Logout(ctx context.Context) error
	StartLogin(ctx context.Context) (LoginRun, error)
}

// LoginRun is one run of `claude auth login` (*claude.Login has it).
type LoginRun interface {
	URL() string
	Code(ctx context.Context, code string) (claude.LoginResult, error)
	Cancel()
	Done() <-chan struct{}
}

var _ LoginRun = (*claude.Login)(nil)

// HostAuth is the computer's own Claude Code, read for the first row only (*claude.Spawner has
// it). It is never logged in or out from here.
type HostAuth interface {
	AuthStatus(ctx context.Context) (claude.Auth, error)
}

var _ HostAuth = (*claude.Spawner)(nil)

// ClaudeOf is the Claude of the account spawner sp.
func ClaudeOf(sp *claude.Spawner) Claude { return spawnerClaude{sp} }

type spawnerClaude struct{ sp *claude.Spawner }

func (c spawnerClaude) AuthStatus(ctx context.Context) (claude.Auth, error) {
	return c.sp.AuthStatus(ctx)
}

func (c spawnerClaude) Logout(ctx context.Context) error { return c.sp.Logout(ctx) }

func (c spawnerClaude) StartLogin(ctx context.Context) (LoginRun, error) {
	l, err := c.sp.StartLogin(ctx)
	if err != nil {
		return nil, err
	}
	return l, nil
}
