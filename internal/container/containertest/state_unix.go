//go:build !windows

package containertest

import "ai-whiteboard/internal/container/fakedocker/fdstate"

type state = fdstate.State

var (
	readState   = fdstate.Read
	updateState = fdstate.Update
	calls       = fdstate.Calls
	normImage   = fdstate.NormImage
	groupAlive  = fdstate.GroupAlive
)
