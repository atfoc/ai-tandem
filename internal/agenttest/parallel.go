package agenttest

import (
	"flag"
	"runtime"
	"strconv"
)

// SpawnBound is how many tests of a binary whose tests mostly wait for processes they start run
// at once on macOS. A Mac starts some 800 processes a second, for everybody on it, and four tests
// that start processes one after the other already take all of that: with more at once the
// binary is done no sooner, and each test takes that much longer against its wall-clock waits.
const SpawnBound = 4

// LimitParallel makes at most SpawnBound tests of the binary run at once on macOS, unless the
// command line says how many (-parallel) or fewer would anyway. It changes nothing elsewhere.
// Call it from TestMain, before m.Run.
func LimitParallel() {
	if runtime.GOOS != "darwin" {
		return
	}
	if !flag.Parsed() {
		flag.Parse()
	}
	given := false
	flag.Visit(func(f *flag.Flag) { given = given || f.Name == "test.parallel" })
	if given || runtime.GOMAXPROCS(0) <= SpawnBound {
		return
	}
	flag.Set("test.parallel", strconv.Itoa(SpawnBound))
}
