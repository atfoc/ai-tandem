//go:build !windows

// Package fdstate is the state of the stand-in docker (internal/container/fakedocker), kept in a
// folder that the stand-in and the test helper (internal/container/containertest) share: a JSON
// file and a calls log, each read and written under an exclusive lock on a lock file, because
// many invocations of the stand-in run at once.
package fdstate

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// EnvState names the stand-in's state folder.
const EnvState = "AIWB_FAKEDOCKER_STATE"

// EnvPrefix starts every variable of the stand-in's own, which the processes it runs do not get.
const EnvPrefix = "AIWB_FAKEDOCKER_"

// BinName is the base name of the stand-in's binary. KillEnv never kills a process whose program
// has this name: on macOS the scan sees arguments and environment together, and the stand-in's own
// `exec -e AIWB_RUN=<id>` arguments would match.
const BinName = "fakedocker"

// The defaults of the knobs.
const DefaultSlow = 30 * time.Second

// State is everything the stand-in remembers but the calls log.
type State struct {
	Mode       string            `json:"mode,omitempty"`
	Slow       time.Duration     `json:"slow,omitempty"` // 0 = DefaultSlow
	BuildDelay time.Duration     `json:"buildDelay,omitempty"`
	PullDelay  time.Duration     `json:"pullDelay,omitempty"`
	FailOn     map[string]string `json:"failOn,omitempty"`
	Images     map[string]string `json:"images,omitempty"` // image name -> id (sha256:...)
	Builds     []Build           `json:"builds,omitempty"`
	Pulls      []string          `json:"pulls,omitempty"`      // every successful `docker pull`, the image as named
	Containers []*Container      `json:"containers,omitempty"` // in order of creation
	Runs       []*Run            `json:"runs,omitempty"`
	Kills      []string          `json:"kills,omitempty"`
}

// Build is one `docker build`.
type Build struct {
	Image      string `json:"image"`
	Dockerfile string `json:"dockerfile"`
}

// Container is one container.
type Container struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Created    time.Time         `json:"created"`
	State      string            `json:"state"` // created, running, exited
	Labels     map[string]string `json:"labels,omitempty"`
	Image      string            `json:"image"`
	Binds      []string          `json:"binds,omitempty"` // "src:dst[:opts]" in the order given
	User       string            `json:"user,omitempty"`
	Init       bool              `json:"init,omitempty"`
	ExtraHosts []string          `json:"extraHosts,omitempty"`
	Cmd        []string          `json:"cmd,omitempty"`
	Args       []string          `json:"args,omitempty"` // the create args after "create"
}

// Run is one run started through the run wrapper.
type Run struct {
	ID        string `json:"id"`
	Container string `json:"container"` // its name
	Pgid      int    `json:"pgid"`
	TTY       bool   `json:"tty,omitempty"`
	Live      bool   `json:"live"`
}

// NormImage is image with ":latest" when it has no tag.
func NormImage(image string) string {
	if i := strings.LastIndex(image, "/"); !strings.Contains(image[i+1:], ":") && !strings.Contains(image, "@") {
		return image + ":latest"
	}
	return image
}

// Find is the container named or with the id (or a unique id prefix) ref, or nil.
func (s *State) Find(ref string) *Container {
	ref = strings.TrimPrefix(ref, "/")
	for _, c := range s.Containers {
		if c.Name == ref || c.ID == ref {
			return c
		}
	}
	var found *Container
	if len(ref) >= 1 {
		for _, c := range s.Containers {
			if strings.HasPrefix(c.ID, ref) {
				if found != nil {
					return nil
				}
				found = c
			}
		}
	}
	return found
}

// Remove forgets the container named name.
func (s *State) Remove(name string) {
	for i, c := range s.Containers {
		if c.Name == name {
			s.Containers = append(s.Containers[:i], s.Containers[i+1:]...)
			return
		}
	}
}

// KillRuns kills every live run of the container named name and marks it ended.
func (s *State) KillRuns(name string) {
	for _, r := range s.Runs {
		if r.Container == name && r.Live {
			KillRun(r)
		}
	}
}

// FindRun is the last run with the id, or nil.
func (s *State) FindRun(id string) *Run {
	for i := len(s.Runs) - 1; i >= 0; i-- {
		if s.Runs[i].ID == id {
			return s.Runs[i]
		}
	}
	return nil
}

// KillRun kills every process of the run, best effort, and marks it ended: its process group,
// every process descended from that group (macOS hides the environment of its own programs, such
// as sleep and sh, from ps -E, so the environment scan alone would miss a child detached into a
// group of its own), and every process whose environment holds AIWB_RUN=<id> (KillEnv).
func KillRun(r *Run) {
	pids := descendants(r.Pgid)
	KillGroup(r.Pgid)
	self, parent := os.Getpid(), os.Getppid()
	for _, pid := range pids {
		if pid != self && pid != parent && pid > 1 {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	KillEnv(r.ID)
	r.Live = false
}

// descendants is every process descended from a process of the group pgid, the group's own
// processes not included.
func descendants(pgid int) []int {
	if pgid <= 1 {
		return nil
	}
	out, err := exec.Command("ps", "-A", "-o", "pid=,ppid=,pgid=").Output()
	if err != nil {
		return nil
	}
	children := map[int][]int{}
	var queue []int
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) != 3 {
			continue
		}
		pid, e1 := strconv.Atoi(f[0])
		ppid, e2 := strconv.Atoi(f[1])
		pg, e3 := strconv.Atoi(f[2])
		if e1 != nil || e2 != nil || e3 != nil {
			continue
		}
		children[ppid] = append(children[ppid], pid)
		if pg == pgid {
			queue = append(queue, pid)
		}
	}
	inGroup := map[int]bool{}
	for _, p := range queue {
		inGroup[p] = true
	}
	seen := map[int]bool{}
	var res []int
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]
		for _, c := range children[p] {
			if !seen[c] && !inGroup[c] {
				seen[c] = true
				res = append(res, c)
				queue = append(queue, c)
			}
		}
	}
	return res
}

// KillGroup sends SIGKILL to the process group pgid.
func KillGroup(pgid int) {
	if pgid > 1 {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	}
}

// GroupAlive reports whether the process group pgid has a process.
func GroupAlive(pgid int) bool {
	return pgid > 1 && syscall.Kill(-pgid, 0) == nil
}

// KillEnv kills, best effort, every process of this user whose environment holds AIWB_RUN=<id>
// exactly, but this process, its parent and the stand-in's own processes.
func KillEnv(id string) {
	if id == "" {
		return
	}
	self, parent := os.Getpid(), os.Getppid()
	for _, pid := range envPids("AIWB_RUN=" + id) {
		if pid != self && pid != parent && pid > 1 {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
}

func envPids(token string) []int {
	if ents, err := os.ReadDir("/proc"); err == nil && len(ents) > 0 {
		if _, err := os.Stat("/proc/self/environ"); err == nil {
			var pids []int
			for _, e := range ents {
				pid, err := strconv.Atoi(e.Name())
				if err != nil {
					continue
				}
				b, err := os.ReadFile(filepath.Join("/proc", e.Name(), "environ"))
				if err != nil {
					continue
				}
				if exe, err := os.Readlink(filepath.Join("/proc", e.Name(), "exe")); err == nil && filepath.Base(exe) == BinName {
					continue
				}
				for _, kv := range bytes.Split(b, []byte{0}) {
					if string(kv) == token {
						pids = append(pids, pid)
						break
					}
				}
			}
			return pids
		}
	}
	// macOS: ps -E puts the environment after the arguments.
	out, err := exec.Command("ps", "-axww", "-E", "-o", "pid=,command=").Output()
	if err != nil {
		return nil
	}
	var pids []int
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	for sc.Scan() {
		line := strings.TrimLeft(sc.Text(), " ")
		sp := strings.IndexByte(line, ' ')
		if sp < 0 {
			continue
		}
		pid, err := strconv.Atoi(line[:sp])
		if err != nil {
			continue
		}
		cmd := line[sp:] // starts with a space
		if f := strings.Fields(cmd); len(f) > 0 && filepath.Base(f[0]) == BinName {
			continue
		}
		for i := 0; ; {
			j := strings.Index(cmd[i:], " "+token)
			if j < 0 {
				break
			}
			end := i + j + 1 + len(token)
			if end == len(cmd) || cmd[end] == ' ' {
				pids = append(pids, pid)
				break
			}
			i = end
		}
	}
	return pids
}

func lock(dir string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(dir, "lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	for {
		err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
		if !errors.Is(err, syscall.EINTR) {
			break
		}
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

func unlock(f *os.File) {
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	f.Close()
}

func load(dir string) (*State, error) {
	s := &State{}
	b, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, s); err != nil {
		return nil, err
	}
	return s, nil
}

func save(dir string, s *State) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "state-*.tmp")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, "state.json"))
}

// Update reads the state under the lock, calls fn and, when it returns nil, writes the state back.
func Update(dir string, fn func(*State) error) error {
	l, err := lock(dir)
	if err != nil {
		return err
	}
	defer unlock(l)
	s, err := load(dir)
	if err != nil {
		return err
	}
	if err := fn(s); err != nil {
		return err
	}
	return save(dir, s)
}

// Read is the state, read under the lock.
func Read(dir string) (*State, error) {
	l, err := lock(dir)
	if err != nil {
		return nil, err
	}
	defer unlock(l)
	return load(dir)
}

// LogCall appends args to the calls log and returns the state, under the lock.
func LogCall(dir string, args []string) (*State, error) {
	l, err := lock(dir)
	if err != nil {
		return nil, err
	}
	defer unlock(l)
	if args == nil {
		args = []string{}
	}
	b, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "calls.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	_, werr := f.Write(append(b, '\n'))
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		return nil, werr
	}
	return load(dir)
}

// Calls is every logged invocation's args, in order.
func Calls(dir string) ([][]string, error) {
	l, err := lock(dir)
	if err != nil {
		return nil, err
	}
	defer unlock(l)
	b, err := os.ReadFile(filepath.Join(dir, "calls.jsonl"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var calls [][]string
	for _, line := range bytes.Split(b, []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		var c []string
		if err := json.Unmarshal(line, &c); err != nil {
			return nil, err
		}
		calls = append(calls, c)
	}
	return calls, nil
}
