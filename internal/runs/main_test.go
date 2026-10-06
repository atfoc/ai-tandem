package runs

import (
	"os"
	"testing"

	"ai-whiteboard/internal/agenttest"
)

func TestMain(m *testing.M) {
	agenttest.FastGit()
	agenttest.LimitParallel()
	os.Exit(m.Run())
}
