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

	// Exited reads the interval before it starts looking, so this is no race with it.
	defer func(d time.Duration) { forgetEvery = d }(forgetEvery)
	forgetEvery = 20 * time.Millisecond
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

// startTree starts a leader with one child in its own group and one child that leads a group of
// its own, and returns the three. When the test ends, what is left of the leader's group is ended
// through SignalGroup, and the other child by its own pid while it still leads its group.
func startTree(t *testing.T) (cmd *exec.Cmd, inGroup, ownGroup int) {
	t.Helper()
	// perl is on every macOS and Linux: setpgrp makes the second child a group leader.
	cmd = exec.Command("sh", "-c", `sleep 300 & echo $!; perl -e 'setpgrp(0,0); exec "sleep", "300"' & echo $!; wait`)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := StartGroup(cmd); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		SignalGroup(cmd, syscall.SIGKILL)
		if g, err := syscall.Getpgid(ownGroup); ownGroup > 1 && err == nil && g == ownGroup {
			syscall.Kill(ownGroup, syscall.SIGKILL)
		}
	})
	r := bufio.NewReader(out)
	read := func() int {
		line, _ := r.ReadString('\n')
		pid, _ := strconv.Atoi(strings.TrimSpace(line))
		if pid <= 1 {
			t.Fatalf("no child pid: %q", line)
		}
		return pid
	}
	inGroup, ownGroup = read(), read()
	go func() {
		cmd.Wait()
		Exited(cmd)
	}()
	// The second child leads its group only once perl has run.
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if g, err := syscall.Getpgid(ownGroup); err == nil && g == ownGroup {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("child %d never led a group of its own", ownGroup)
		}
	}
	return cmd, inGroup, ownGroup
}

// gone waits until none of the processes runs any more (one that was killed and not yet waited
// for by its parent is still there, as a zombie).
func gone(t *testing.T, what string, pids ...int) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		left := 0
		for _, pid := range pids {
			if syscall.Kill(pid, 0) == nil && !zombie(pid) {
				left = pid
			}
		}
		if left == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: process %d is still there", what, left)
		}
	}
}

func zombie(pid int) bool {
	out, _ := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	return strings.HasPrefix(strings.TrimSpace(string(out)), "Z")
}

// SignalGroup reaches the leader's group and not the group a child leads. It does not signal once
// its group is gone.
func TestSignalGroup(t *testing.T) {
	cmd, inGroup, ownGroup := startTree(t)
	leader := cmd.Process.Pid

	if !SignalGroup(cmd, 0) {
		t.Error("SignalGroup(0) reports the leader's group gone while it runs")
	}
	// The group's signal does not reach the child that leads its own.
	if !SignalGroup(cmd, syscall.SIGKILL) {
		t.Fatal("SignalGroup did not signal the leader's group")
	}
	gone(t, "after SignalGroup", leader, inGroup)
	if syscall.Kill(ownGroup, 0) != nil {
		t.Fatal("the child in a group of its own was ended by the leader's group signal")
	}
	for deadline := time.Now().Add(5 * time.Second); SignalGroup(cmd, 0); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("SignalGroup still finds the leader's group after it was killed")
		}
	}
	if registered(leader) {
		t.Error("the empty group is still remembered")
	}
}

// Numbers that name no single group of ours are never signalled.
func TestSignalNeverReachesOtherGroups(t *testing.T) {
	// A command that StartGroup did not start has no remembered group.
	cmd := exec.Command("sleep", "300")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	if SignalGroup(cmd, 0) {
		t.Error("SignalGroup found a group for a command StartGroup did not start")
	}
	if SignalGroup(exec.Command("true"), 0) {
		t.Error("SignalGroup found a group for a command that was never started")
	}
	// Nor has a command that leads a group but was not started by StartGroup: its group is there
	// to take a signal, and gets none.
	own := exec.Command("sleep", "300")
	own.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := own.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { own.Process.Kill(); own.Wait() }()
	if g, err := syscall.Getpgid(own.Process.Pid); err != nil || g != own.Process.Pid {
		t.Fatalf("the command does not lead a group: pgid %d, %v", g, err)
	}
	if SignalGroup(own, 0) {
		t.Error("SignalGroup found the group of a command StartGroup did not start")
	}
	if SignalGroup(own, syscall.SIGKILL) {
		t.Error("SignalGroup reports a signal to the group of a command StartGroup did not start")
	}
	time.Sleep(100 * time.Millisecond)
	if syscall.Kill(own.Process.Pid, 0) != nil || zombie(own.Process.Pid) {
		t.Error("SignalGroup killed a group StartGroup did not start")
	}
}
