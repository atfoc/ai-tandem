package chats_test

import (
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/runs"
)

// The manager is what a run's service and engine drive its chats through. The chats package cannot
// say so itself (runs imports it), so it is said here.
var _ runs.ChatHost = (*chats.Manager)(nil)

// And a run's service is what the manager asks about runs.
var _ chats.RunOwner = runOwner(nil)

type runOwner interface {
	RunOf(id string) (chats.RunInfo, bool)
	ChatContext(id string) string
}
