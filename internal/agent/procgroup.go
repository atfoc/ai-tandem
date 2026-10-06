package agent

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Each agent process runs as the leader of a process group of its own, so that when the server
// stops it can end the agent together with everything the agent started (Cursor's worker-server,
// language servers, ...), which would otherwise outlive the server.

// ErrStopping is what StartGroup reports once EndAll has begun.
var ErrStopping = errors.New("the server is stopping")

var groups = struct {
	sync.Mutex
	pgids  map[int]bool // the groups of agent processes started and not known to be empty
	ending bool
}{pgids: map[int]bool{}}

// StartGroup starts cmd as the leader of a new process group and remembers the group for
// EndAll. Call Exited once cmd.Wait has returned.
func StartGroup(cmd *exec.Cmd) error {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	groups.Lock()
	defer groups.Unlock()
	if groups.ending {
		return ErrStopping
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	groups.pgids[cmd.Process.Pid] = true
	return nil
}

// Exited forgets the group of cmd, started by StartGroup and since waited for, once nothing is
// left in it. A group that still has processes the agent started stays, for EndAll, and is
// forgotten when the last of them is gone, whoever ended it: the number of a group that no longer
// exists can become another program's, which EndAll must not signal.
func Exited(cmd *exec.Cmd) {
	pgid := cmd.Process.Pid
	if forget(pgid) {
		return
	}
	go func() {
		for !forget(pgid) {
			time.Sleep(time.Second)
		}
	}()
}

// forget drops pgid if its group is gone, and reports whether the group is no longer remembered.
func forget(pgid int) bool {
	groups.Lock()
	defer groups.Unlock()
	if errors.Is(syscall.Kill(-pgid, 0), syscall.ESRCH) {
		delete(groups.pgids, pgid)
	}
	return !groups.pgids[pgid]
}

// SignalGroup sends sig to the group of cmd, started by StartGroup, and reports whether a group
// was there to take it. Nothing is sent once the group is forgotten (it is gone, and its number
// may by now be another program's), nor for a number that names no single group (0, 1). So an
// adapter can end what its process left behind after the leader itself has exited.
func SignalGroup(cmd *exec.Cmd, sig syscall.Signal) bool {
	if cmd.Process == nil {
		return false
	}
	pgid := cmd.Process.Pid
	groups.Lock()
	defer groups.Unlock()
	if pgid <= 1 || !groups.pgids[pgid] {
		return false
	}
	if err := syscall.Kill(-pgid, sig); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			delete(groups.pgids, pgid)
		}
		return false
	}
	return true
}

// StartedGroups lists the process groups that descendants of cmd's process lead, other than its
// own. An agent CLI starts each shell command as the leader of a group of its own, which a
// signal to the agent's group does not reach; a command that detached itself (its parent is no
// longer in the agent's tree) is not found. waited is closed once cmd has been waited for: the
// list is nil unless the process was still there, running or not yet waited for, when the
// process table was read, since only until then is its pid certain to be its own.
//
// The groups are for SignalStarted, soon after: a group's number can become another program's
// once the group is empty.
func StartedGroups(cmd *exec.Cmd, waited <-chan struct{}) []int {
	if cmd.Process == nil || cmd.Process.Pid <= 1 {
		return nil
	}
	out, err := exec.Command("ps", "-A", "-o", "pid=,ppid=,pgid=").Output()
	select {
	case <-waited:
		return nil
	default:
	}
	if err != nil {
		return nil
	}
	return startedGroups(string(out), cmd.Process.Pid)
}

// startedGroups reads a process table of "pid ppid pgid" lines: the groups led by a descendant
// of root, other than root's own group.
func startedGroups(table string, root int) []int {
	kids := map[int][]int{}
	pgid := map[int]int{}
	for _, line := range strings.Split(table, "\n") {
		var pid, ppid, g int
		if n, _ := fmt.Sscan(line, &pid, &ppid, &g); n != 3 {
			continue
		}
		kids[ppid] = append(kids[ppid], pid)
		pgid[pid] = g
	}
	own, ok := pgid[root]
	if !ok {
		return nil
	}
	var out []int
	seen := map[int]bool{root: true}
	for todo := []int{root}; len(todo) > 0; todo = todo[1:] {
		for _, pid := range kids[todo[0]] {
			if seen[pid] {
				continue
			}
			seen[pid] = true
			todo = append(todo, pid)
			if pgid[pid] == pid && pid != own && pid > 1 {
				out = append(out, pid)
			}
		}
	}
	return out
}

// SignalStarted sends sig to each group StartedGroups listed and reports whether any of them is
// still there. Signal 0 only asks.
func SignalStarted(pgids []int, sig syscall.Signal) bool {
	left := false
	for _, pgid := range pgids {
		if pgid <= 1 || pgid == syscall.Getpgrp() {
			continue
		}
		if err := syscall.Kill(-pgid, sig); !errors.Is(err, syscall.ESRCH) {
			left = true
		}
	}
	return left
}

// EndAll ends every group StartGroup started: SIGTERM, then SIGKILL to what is still there after
// grace. StartGroup fails from now on.
func EndAll(grace time.Duration) {
	groups.Lock()
	groups.ending = true
	var pgids []int
	for pgid := range groups.pgids {
		pgids = append(pgids, pgid)
	}
	groups.Unlock()
	if len(pgids) == 0 {
		return
	}
	for _, pgid := range pgids {
		syscall.Kill(-pgid, syscall.SIGTERM)
	}
	for deadline := time.Now().Add(grace); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		left := false
		for _, pgid := range pgids {
			if !errors.Is(syscall.Kill(-pgid, 0), syscall.ESRCH) {
				left = true
				break
			}
		}
		if !left {
			return
		}
	}
	for _, pgid := range pgids {
		syscall.Kill(-pgid, syscall.SIGKILL)
	}
}
