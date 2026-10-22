package agent

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/testset"
)

// Environment variable that turns the test binary into the subprocess of TestEndAllEndsAdoptedGroups.
const envTreeEndAll = "AGENT_TEST_ENDALL" // set: TestEndAllEndsAdoptedGroups is the subprocess that calls EndAll

func TestMain(m *testing.M) {
	// A process built with -race would otherwise sleep 1 s before every exit (the race detector's
	// atexit_sleep_ms); the subprocess here is meant to exit when asked.
	if old := os.Getenv("GORACE"); !strings.Contains(old, "atexit_sleep_ms") {
		os.Setenv("GORACE", strings.TrimSpace(old+" atexit_sleep_ms=0"))
	}
	os.Exit(m.Run())
}

// leaderScript is the leader of a tree: perl, which is on every macOS and Linux and starts in a
// few milliseconds, where each program a test starts takes a third of a second on a busy machine.
// It forks (no exec) a sleeping child in its own group and one that leads a session and group of
// its own, prints "<pid> <pid>" once the second leads its group, reaps its children (SIGCHLD
// ignored, so that one that is killed does not stay behind as a zombie in its group) and exits
// when its stdin closes.
const leaderScript = `use POSIX; $|=1; $SIG{CHLD}="IGNORE";
my $a = fork; if (!$a) { select(undef, undef, undef, 60); exit }
my $b = fork; if (!$b) { POSIX::setsid(); select(undef, undef, undef, 60); exit }
select(undef, undef, undef, 0.005) until getpgrp($b) == $b;
print "$a $b\n"; 1 while <STDIN>;`

// leaderCommand is the command of leaderScript.
func leaderCommand() *exec.Cmd { return exec.Command("perl", "-e", leaderScript) }

// killIfLeads kills pid if it is in the group pgid. The group a process was started in is not
// another program's, whatever the number now belongs to.
func killIfLeads(pid, pgid int) {
	if g, err := syscall.Getpgid(pid); pid > 1 && err == nil && g == pgid {
		syscall.Kill(pid, syscall.SIGKILL)
	}
}

// killTree kills the three processes of startLeader by their pids, each only while it is still in
// the group it was started in.
func killTree(leader, inGroup, detached int) {
	killIfLeads(leader, leader)
	killIfLeads(inGroup, leader)
	killIfLeads(detached, detached)
}

// startLeader starts a leaderCommand under StartGroup and returns it, its stdin, the child in its
// group and the child that leads a session and group of its own. When the leader has been waited
// for, onExit (nil: nothing) runs before Exited. When the test ends, every process of the three
// that is still there is killed by its pid, and the leader's wait is waited for, so that no test's Exited runs while the next one sets forgetEvery.
func startLeader(t *testing.T, onExit func(*exec.Cmd)) (cmd *exec.Cmd, stdin io.WriteCloser, inGroup, detached int) {
	t.Helper()
	cmd = leaderCommand()
	stdin, err1 := cmd.StdinPipe()
	out, err2 := cmd.StdoutPipe()
	if err1 != nil || err2 != nil {
		t.Fatal(err1, err2)
	}
	if err := StartGroup(cmd); err != nil {
		t.Fatal(err)
	}
	leader := cmd.Process.Pid
	waited := make(chan struct{})
	t.Cleanup(func() {
		stdin.Close()
		killTree(leader, inGroup, detached)
		select {
		case <-waited:
		case <-time.After(10 * time.Second):
			t.Error("the leader was not waited for")
		}
	})
	line, _ := bufio.NewReader(out).ReadString('\n')
	if n, _ := fmt.Sscan(line, &inGroup, &detached); n != 2 || inGroup <= 1 || detached <= 1 {
		t.Fatalf("the leader did not start its children: %q", line)
	}
	go func() {
		defer close(waited)
		cmd.Wait()
		if onExit != nil {
			onExit(cmd)
		}
		Exited(cmd)
	}()
	// The leader printed their pids once the second led its group.
	if g, err := syscall.Getpgid(detached); err != nil || g != detached {
		t.Fatalf("the detached child %d does not lead its group: %d, %v", detached, g, err)
	}
	if g, err := syscall.Getpgid(inGroup); err != nil || g != leader {
		t.Fatalf("the child %d is not in the leader's group: %d, %v", inGroup, g, err)
	}
	return cmd, stdin, inGroup, detached
}

func TestDescendantsWalk(t *testing.T) {
	ps := []procInfo{
		{1, 0, 1},
		{10, 1, 10},  // the root
		{11, 10, 10}, // a chain: 11, 12, 13
		{12, 11, 12},
		{13, 12, 12},
		{14, 10, 14}, // a fork under the root
		{15, 14, 14},
		{16, 14, 16},
		{20, 1, 20}, // an unrelated tree
		{21, 20, 20},
		{30, 31, 30}, // a loop, below the root through 32
		{31, 30, 30},
		{32, 13, 32},
		{30, 32, 30}, // a second line for 30 (the listing changed while it was read)
	}
	pids := func(root int) []int {
		var out []int
		for _, p := range descendants(root, ps) {
			out = append(out, p.pid)
		}
		slices.Sort(out)
		return out
	}
	for _, c := range []struct {
		root int
		want []int
	}{
		{10, []int{11, 12, 13, 14, 15, 16, 30, 31, 32}},
		{14, []int{15, 16}},
		{20, []int{21}},
		{30, []int{31}},
		{16, nil},
		{99, nil},
	} {
		if got := pids(c.root); !slices.Equal(got, c.want) {
			t.Errorf("descendants(%d) = %v, want %v", c.root, got, c.want)
		}
	}
}

func TestListProcsSeesItself(t *testing.T) {
	ps, err := listProcs()
	if err != nil {
		t.Fatal(err)
	}
	pgid, _ := syscall.Getpgid(0)
	for _, p := range ps {
		if p.pid == os.Getpid() {
			if p.ppid != os.Getppid() || p.pgid != pgid {
				t.Errorf("own line %+v, want ppid %d and pgid %d", p, os.Getppid(), pgid)
			}
			return
		}
	}
	t.Fatalf("the listing of %d processes does not hold %d", len(ps), os.Getpid())
}

// adoptAll (the walk EndAll makes of every leader) and Adopt take the group a descendant leads,
// and neither the leader's own group nor the test's.
func TestAdoptRecordsDetachedGroups(t *testing.T) {
	cmd, _, _, detached := startLeader(t, nil)
	t.Cleanup(func() { SignalAdopted(cmd, syscall.SIGKILL); SignalGroup(cmd, syscall.SIGKILL) })
	adoptAll()
	got := AdoptedGroups(cmd.Process.Pid)
	if !slices.Equal(got, []int{detached}) {
		t.Fatalf("adopted %v, want only the detached child's group %d (leader %d, test %d)",
			got, detached, cmd.Process.Pid, syscall.Getpgrp())
	}
	if !registered(detached) {
		t.Error("the adopted group is not among those EndAll ends")
	}
	// A second walk finds nothing new.
	Adopt(cmd)
	if got := AdoptedGroups(cmd.Process.Pid); !slices.Equal(got, []int{detached}) {
		t.Errorf("after a second Adopt: %v", got)
	}
}

// A command that StartGroup did not start is not walked: no group is adopted under it, and no ps
// is made for it.
func TestAdoptIgnoresACommandStartGroupDidNotStart(t *testing.T) {
	plain := leaderCommand()
	// In a group of its own, so that what it started can be told from the test's.
	plain.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	plainIn, _ := plain.StdinPipe()
	plainOut, _ := plain.StdoutPipe()
	if err := plain.Start(); err != nil {
		t.Fatal(err)
	}
	line, _ := bufio.NewReader(plainOut).ReadString('\n')
	var a, b int
	fmt.Sscan(line, &a, &b)
	t.Cleanup(func() {
		plainIn.Close()
		killTree(plain.Process.Pid, a, b)
		plain.Wait()
	})
	Adopt(plain)
	if got := AdoptedGroups(plain.Process.Pid); len(got) != 0 || registered(b) {
		t.Errorf("Adopt took %v under a command StartGroup did not start", got)
	}
}

// The leader exits by itself after Adopt: its detached child, now the child of init, is ended by
// EndTree, and so is the child left in its group.
func TestEndTreeEndsAdoptedAfterLeaderExit(t *testing.T) {
	cmd, stdin, inGroup, detached := startLeader(t, func(cmd *exec.Cmd) { EndTree(cmd, 2*time.Second) })
	Adopt(cmd)
	if got := AdoptedGroups(cmd.Process.Pid); !slices.Equal(got, []int{detached}) {
		t.Fatalf("adopted %v, want [%d]", got, detached)
	}
	stdin.Close()
	gone(t, "after the leader's exit", cmd.Process.Pid, inGroup, detached)
}

// An adopted group is forgotten once it is empty, whoever ended it.
func TestAdoptedGroupForgottenWhenEmpty(t *testing.T) {
	// watch reads the interval before it starts looking, so this is no race with it. It is put
	// back after the leader's wait (a cleanup of startLeader, run before this one).
	old := forgetEvery
	t.Cleanup(func() { forgetEvery = old })
	forgetEvery = 20 * time.Millisecond
	cmd, _, _, detached := startLeader(t, nil)
	t.Cleanup(func() { SignalGroup(cmd, syscall.SIGKILL) })
	Adopt(cmd)
	if !registered(detached) {
		t.Fatalf("group %d was not adopted", detached)
	}
	syscall.Kill(detached, syscall.SIGKILL)
	for deadline := time.Now().Add(10 * time.Second); registered(detached) || len(AdoptedGroups(cmd.Process.Pid)) > 0; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("group %d is gone and still remembered: it would be signalled whatever has that number by then", detached)
		}
	}
	if !registered(cmd.Process.Pid) {
		t.Error("the leader's own group was forgotten with the adopted one")
	}
}

// EndAll walks the tree of every leader before it signals, so that it ends a detached child that
// Adopt was never called for. It runs in a subprocess, because StartGroup fails for the rest of a
// test binary once EndAll has begun.
func TestEndAllEndsAdoptedGroups(t *testing.T) {
	if os.Getenv(envTreeEndAll) != "" {
		cmd, _, inGroup, detached := startLeader(t, nil)
		fmt.Printf("PIDS %d %d %d\n", cmd.Process.Pid, inGroup, detached)
		EndAll(2 * time.Second)
		return
	}
	testset.SkipUnlessFull(t, "starts a second copy of the test binary; TestAdoptRecordsDetachedGroups covers the walk of adoptAll, and the groups it records are the ones EndAll signals")
	sub := exec.Command(os.Args[0], "-test.run", "^TestEndAllEndsAdoptedGroups$")
	sub.Env = append(os.Environ(), envTreeEndAll+"=1")
	out, err := sub.CombinedOutput()
	var pids [3]int
	for _, line := range strings.Split(string(out), "\n") {
		if rest, ok := strings.CutPrefix(line, "PIDS "); ok {
			fmt.Sscan(rest, &pids[0], &pids[1], &pids[2])
		}
	}
	t.Cleanup(func() { killTree(pids[0], pids[1], pids[2]) })
	if err != nil || pids[2] <= 1 {
		t.Fatalf("the subprocess: %v\n%s", err, out)
	}
	gone(t, "after EndAll", pids[:]...)
}
