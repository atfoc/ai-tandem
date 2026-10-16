package headless

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// standIn is the program the tests run in place of Node: /bin/sh runs it as headless.mjs. It reads the
// configuration line from its stdin, writes it and its surroundings to files in $STANDIN_OUT, says it is
// "connected" the way the real process does (by opening its stream: here a file named for its client id) and
// waits for its stdin to close. What it does besides is chosen by the file $STANDIN_OUT/mode:
//
//	(none)    the above, then exits when stdin closes
//	silent    never connects
//	exit3     prints a reason on stderr and exits 3 before reading anything
//	stubborn  connects, and then ignores stdin closing and SIGTERM
const standIn = `OUT="$STANDIN_OUT"
mode=$(cat "$OUT/mode" 2>/dev/null)
echo "$$" >> "$OUT/starts"
if [ "$mode" = exit3 ]; then
  echo "the board engine is not built" >&2
  exit 3
fi
read line
printf '%s\n' "$line" > "$OUT/config"
env > "$OUT/env"
ps -o command= -p $$ > "$OUT/args"
id=$(printf '%s' "$line" | sed 's/.*"clientId":"\([^"]*\)".*/\1/')
[ "$mode" = silent ] || : > "$OUT/connected.$id"
if [ "$mode" = stubborn ]; then
  trap '' TERM
  while :; do sleep 0.1; done
fi
cat > /dev/null
echo saved >> "$OUT/exits"
`

// rig is a manager over a fake bridge and the stand-in.
type rig struct {
	t      *testing.T
	m      *Manager
	b      *fakeBridge
	out    string // $STANDIN_OUT
	bundle string // the bundle folder
	logs   *logSink
	clock  *fakeClock
}

// newRig makes a manager whose runtime is /bin/sh and whose bundle holds the stand-in. Every wait is lowered.
func newRig(t *testing.T, o Options) *rig {
	t.Helper()
	dir := t.TempDir()
	r := &rig{t: t, out: filepath.Join(dir, "out"), bundle: filepath.Join(dir, "bundle"), logs: &logSink{}, clock: &fakeClock{t: time.Now()}}
	for _, d := range []string{r.out, r.bundle} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeBundle(t, r.bundle, "dev", standIn)
	r.b = &fakeBridge{out: r.out, dropped: map[string]bool{}}
	if o.Node == "" {
		o.Node = "/bin/sh"
	}
	if o.Dir == "" {
		o.Dir = r.bundle
	}
	if o.StartLimit == 0 {
		o.StartLimit = 20 * time.Second // generous: a start ends at its sign, not at this
	}
	if o.Linger == 0 {
		o.Linger = time.Hour // no idle stop unless the test asks for it
	}
	o.Env = append(o.Env, "STANDIN_OUT="+r.out)
	o.Logf = r.logs.logf
	r.m = New(r.b, Listener{Port: 4747, Fingerprint: "ab:cd", Secret: func() string { return "s3cret-value" }, InstanceID: "inst-1"}, o)
	r.m.stopGrace, r.m.termGrace = 2*time.Second, 200*time.Millisecond
	r.m.now = r.clock.now
	t.Cleanup(r.m.Close)
	return r
}

func (r *rig) mode(s string) {
	r.t.Helper()
	if err := os.WriteFile(filepath.Join(r.out, "mode"), []byte(s), 0o644); err != nil {
		r.t.Fatal(err)
	}
}

// starts is the pids of the processes started so far.
func (r *rig) starts() []string {
	b, _ := os.ReadFile(filepath.Join(r.out, "starts"))
	return strings.Fields(string(b))
}

func (r *rig) config() config {
	r.t.Helper()
	b, err := os.ReadFile(filepath.Join(r.out, "config"))
	if err != nil {
		r.t.Fatal(err)
	}
	var c config
	if err := json.Unmarshal(b, &c); err != nil {
		r.t.Fatalf("the configuration line is not JSON: %v: %s", err, b)
	}
	return c
}

func writeBundle(t *testing.T, dir, version, program string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, BundleFile), []byte(program), 0o644); err != nil {
		t.Fatal(err)
	}
	mf, _ := json.Marshal(Manifest{Version: version, OS: "darwin", Arch: "arm64"})
	if err := os.WriteFile(filepath.Join(dir, ManifestFile), mf, 0o644); err != nil {
		t.Fatal(err)
	}
}

// fakeBridge is the Bridge: a client is "known" once the stand-in has written its connected file.
type fakeBridge struct {
	out string

	mu      sync.Mutex
	away    string
	setAway []string
	atSet   []bool // for each SetAway, whether the stand-in had already read its configuration
	dropped map[string]bool
	holds   bool
	calls   bool
	looks   int
	held    int // HeldCount, when counted
	counted bool
}

func (b *fakeBridge) Known(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.dropped[id] {
		return false
	}
	_, err := os.Stat(filepath.Join(b.out, "connected."+id))
	return err == nil
}

func (b *fakeBridge) SetAway(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.away = id
	b.setAway = append(b.setAway, id)
	_, err := os.Stat(filepath.Join(b.out, "config"))
	b.atSet = append(b.atSet, err == nil)
}

func (b *fakeBridge) HoldsAny(string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.looks++
	return b.holds
}

func (b *fakeBridge) HasCalls(string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.calls
}

func (b *fakeBridge) set(f func(b *fakeBridge)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	f(b)
}

func (b *fakeBridge) awayNow() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.away
}

// countingBridge adds HeldCount.
type countingBridge struct {
	*fakeBridge
	n int
}

func (c countingBridge) HeldCount(string) int { return c.n }

type logSink struct {
	mu    sync.Mutex
	lines []string
}

func (l *logSink) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logSink) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.lines...)
}

func (l *logSink) count(sub string) int {
	n := 0
	for _, s := range l.all() {
		if strings.Contains(s, sub) {
			n++
		}
	}
	return n
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// eventually waits for cond, up to a generous limit: it is a sign being waited for, not a time.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func alive(pid string) bool {
	var n int
	for _, c := range pid {
		n = n*10 + int(c-'0')
	}
	return syscall.Kill(n, 0) == nil
}
