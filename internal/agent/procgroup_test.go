package agent

import (
	"bufio"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// registered reports whether pgid is among the groups EndAll would signal.
func registered(pgid int) bool {
	groups.Lock()
	defer groups.Unlock()
	return groups.pgids[pgid]
}

// A group whose leader has exited stays registered while something is left in it, and is
// forgotten once the last process is gone: EndAll signals every number it remembers, and the
// number of a group that no longer exists can by then be another program's.
func TestExitedForgetsGroupOnceEmpty(t *testing.T) {
	cmd := exec.Command("sh", "-c", "sleep 300 & echo $!")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := StartGroup(cmd); err != nil {
		t.Fatal(err)
	}
	pgid := cmd.Process.Pid
	line, _ := bufio.NewReader(out).ReadString('\n')
	cmd.Wait()
	child, _ := strconv.Atoi(strings.TrimSpace(line))
	// Only the process this test started is ever signalled: the sleep, by its own pid, and only
	// while it is in the group of the test's own leader.
	ours := func() bool {
		g, err := syscall.Getpgid(child)
		return child > 1 && err == nil && g == pgid
	}
	if !ours() {
		t.Fatalf("the leader's child %q is not running in its group %d", line, pgid)
	}
	t.Cleanup(func() {
		if ours() {
			syscall.Kill(child, syscall.SIGKILL)
		}
	})

	Exited(cmd)
	if !registered(pgid) {
		t.Fatalf("group %d was forgotten while a process is left in it: EndAll would not end it", pgid)
	}

	syscall.Kill(child, syscall.SIGKILL)
	for deadline := time.Now().Add(5 * time.Second); !errors.Is(syscall.Kill(-pgid, 0), syscall.ESRCH); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("group %d is not empty after its last process was killed", pgid)
		}
	}
	for deadline := time.Now().Add(5 * time.Second); registered(pgid); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("group %d is gone and still registered: EndAll would signal whatever has that number at shutdown", pgid)
		}
	}
}
