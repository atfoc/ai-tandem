package app

import (
	"os"
	"testing"

	"ai-whiteboard/internal/agenttest"
)

// The tests of the runs start git, so git is the real one and only a few tests run at once.
func TestMain(m *testing.M) {
	agenttest.FastGit()
	agenttest.LimitParallel()
	os.Exit(m.Run())
}
