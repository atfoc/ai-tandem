package chats

import (
	"flag"
	"os"
	"testing"
)

// testParallel is how many tests of this package run at once unless -parallel says otherwise.
// The tests are parallel and nearly all of what they do is writing small files in temporary
// folders. Go's default is one test per core, and on a 14-core machine that many writers hold
// each other up inside the file system: the package then takes as long as with 4 and costs
// five times the system time (measured alone: 8 s wall and 8 s system time at 4, 6.5 s and 16 s
// at 8, 8 s and 43 s at 14), which the other test runs on the machine pay for. With three copies
// of the package running at once, fewer at a time is also the faster.
const testParallel = "4"

func TestMain(m *testing.M) {
	flag.Parse()
	given := false
	flag.Visit(func(f *flag.Flag) { given = given || f.Name == "test.parallel" })
	if !given {
		if err := flag.Set("test.parallel", testParallel); err != nil {
			panic(err)
		}
	}
	os.Exit(m.Run())
}
