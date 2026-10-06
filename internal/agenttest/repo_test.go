package agenttest

import (
	"flag"
	"runtime"
	"strconv"
	"testing"
)

// LimitParallel caps -parallel at SpawnBound on a Mac with more cores, and leaves it alone when
// the command line set it, on a smaller machine and on every other system.
func TestLimitParallel(t *testing.T) {
	f := flag.Lookup("test.parallel")
	was := f.Value.String()
	given := false
	flag.Visit(func(g *flag.Flag) { given = given || g.Name == "test.parallel" })
	t.Cleanup(func() {
		if !given {
			f.Value.Set(was) // by its Value, so that the flag still counts as not given
		}
	})
	LimitParallel()
	want := was
	if runtime.GOOS == "darwin" && !given && runtime.GOMAXPROCS(0) > SpawnBound {
		want = strconv.Itoa(SpawnBound)
	}
	if got := f.Value.String(); got != want {
		t.Fatalf("-parallel is %s, want %s (it was %s, given on the command line: %v)", got, want, was, given)
	}
}
