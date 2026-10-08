// Package testset decides which of the two sets of tests a `go test` run is.
//
// The default set is what plain `go test` runs. It is the fast one, for running again and again
// while working on the code: tests that are slow (they build the binary, start servers, run node or
// a real pi, or go through a whole matrix of cases) skip themselves or run a thinned version.
//
// The full set is what `AIWB_TEST_FULL=1 go test` runs: every test, each in full. It is for checking
// a change before it lands.
//
// -short never runs more than the default set: with -short the default set runs, also when
// AIWB_TEST_FULL=1 is set.
//
// A test that belongs only to the full set calls SkipUnlessFull; a test that runs fewer cases in the
// default set asks Full. Tests do not call testing.Short themselves.
package testset

import (
	"os"
	"testing"
)

// Env is the environment variable that selects the full set.
const Env = "AIWB_TEST_FULL"

// Full reports whether the full set of tests runs: AIWB_TEST_FULL=1 and no -short.
func Full() bool { return os.Getenv(Env) == "1" && !testing.Short() }

// SkipUnlessFull skips the test unless the full set runs. The reason says why the test is not in the default set.
func SkipUnlessFull(t testing.TB, reason string) {
	t.Helper()
	if !Full() {
		t.Skipf("full set only (%s=1): %s", Env, reason)
	}
}
