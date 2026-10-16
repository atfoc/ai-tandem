package headless

import (
	"os"
	"testing"

	"ai-whiteboard/internal/agenttest"
)

func TestMain(m *testing.M) {
	agenttest.LimitParallel()
	os.Exit(m.Run())
}
