package agent

import (
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// An agent's process can start commands that leave its group: Claude runs every shell command,
// a background one too, detached, in a session and group of its own. A signal to the agent's
// group does not reach them, and once the agent's process has exited they are the children of
// init and no longer look like the agent's. So their groups are found by a walk of the process
// tree while the agent's process is still their ancestor, and remembered under its group: they
// are adopted. An adopted group is watched like a group whose leader has exited, and forgotten as
// soon as it is empty, so that a number that is remembered is never one the system may have
// given to another program by now.

type procInfo struct{ pid, ppid, pgid int }

// listProcs lists every process of the machine with its parent and its group. A line that does
// not read as three numbers is skipped.
func listProcs() ([]procInfo, error) {
	out, err := exec.Command("ps", "-A", "-o", "pid=,ppid=,pgid=").Output()
	if err != nil {
		return nil, err
	}
	var ps []procInfo
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) != 3 {
			continue
		}
		var n [3]int
		ok := true
		for i, s := range f {
			if n[i], err = strconv.Atoi(s); err != nil {
				ok = false
			}
		}
		if ok {
			ps = append(ps, procInfo{pid: n[0], ppid: n[1], pgid: n[2]})
		}
	}
	return ps, nil
}

// descendants is every process below root by the parent links of ps, root itself left out. A
// listing whose links make a loop is walked once around it.
func descendants(root int, ps []procInfo) []procInfo {
	children := map[int][]procInfo{}
	for _, p := range ps {
		children[p.ppid] = append(children[p.ppid], p)
	}
	seen := map[int]bool{root: true}
	var out []procInfo
	for queue := []int{root}; len(queue) > 0; queue = queue[1:] {
		for _, c := range children[queue[0]] {
			if !seen[c.pid] {
				seen[c.pid] = true
				out = append(out, c)
				queue = append(queue, c.pid)
			}
		}
	}
	return out
}

// Adopt records the process groups that the descendants of cmd's process lead (pid == pgid), so
// that EndTree and EndAll reach them after cmd's process is gone and they have been reparented.
// It never adopts cmd's own group, the server's own (syscall.Getpgrp()), or a pgid <= 1. Each
// adopted group is watched and forgotten once empty. A cmd whose group is not registered
// (StartGroup) is ignored.
func Adopt(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	groups.Lock()
	known := groups.pgids[cmd.Process.Pid]
	groups.Unlock()
	if !known {
		return
	}
	ps, err := listProcs()
	if err != nil {
		return
	}
	groups.Lock()
	added := adoptLocked(cmd.Process.Pid, ps)
	groups.Unlock()
	for _, pgid := range added {
		watch(pgid)
	}
}

// adoptLocked adopts under leader the groups led by the descendants of leader's process and of
// the leaders of the groups already adopted under it, and returns those that are new. A root is
// walked only while its group is remembered and the listing shows it leading that group: a
// remembered group is not empty, so its number is still its leader's, and the processes below it
// are its own. groups held.
func adoptLocked(leader int, ps []procInfo) []int {
	if !groups.pgids[leader] {
		return nil
	}
	byPid := make(map[int]procInfo, len(ps))
	for _, p := range ps {
		byPid[p.pid] = p
	}
	own := syscall.Getpgrp()
	set := groups.adopted[leader]
	var added []int
	for queue := append([]int{leader}, adoptedOf(leader)...); len(queue) > 0; queue = queue[1:] {
		root := queue[0]
		if p, ok := byPid[root]; !ok || p.pgid != root || !groups.pgids[root] {
			continue
		}
		for _, d := range descendants(root, ps) {
			// A group of another agent, or one remembered already, is not taken over.
			if d.pid != d.pgid || d.pgid <= 1 || d.pgid == leader || d.pgid == own || groups.pgids[d.pgid] {
				continue
			}
			if set == nil {
				set = map[int]bool{}
				groups.adopted[leader] = set
			}
			set[d.pgid] = true
			groups.pgids[d.pgid] = true
			added = append(added, d.pgid)
		}
	}
	return added
}

// adoptedOf is the groups adopted under leader that are still remembered, in order. groups held.
func adoptedOf(leader int) []int {
	var out []int
	for pgid := range groups.adopted[leader] {
		if groups.pgids[pgid] {
			out = append(out, pgid)
		}
	}
	slices.Sort(out)
	return out
}

// adoptAll adopts, from one listing, under every leader StartGroup started that still leads its
// group.
func adoptAll() {
	groups.Lock()
	none := len(groups.pgids) == 0
	groups.Unlock()
	if none {
		return
	}
	ps, err := listProcs()
	if err != nil {
		return
	}
	groups.Lock()
	adopted := map[int]bool{}
	for _, set := range groups.adopted {
		for pgid := range set {
			adopted[pgid] = true
		}
	}
	var added []int
	for pgid := range groups.pgids {
		if !adopted[pgid] {
			added = append(added, adoptLocked(pgid, ps)...)
		}
	}
	groups.Unlock()
	for _, pgid := range added {
		watch(pgid)
	}
}

// SignalAdopted sends sig to every group adopted under cmd that is still remembered.
func SignalAdopted(cmd *exec.Cmd, sig syscall.Signal) {
	if cmd.Process == nil {
		return
	}
	groups.Lock()
	defer groups.Unlock()
	for _, pgid := range adoptedOf(cmd.Process.Pid) {
		signalLocked(pgid, sig)
	}
}

// EndTree ends what cmd's process started, once it has exited or is about to: SIGTERM to its own
// group and to every group adopted under it, then SIGKILL after grace to those still there. It
// returns at once; the SIGKILL comes from a goroutine.
func EndTree(cmd *exec.Cmd, grace time.Duration) {
	SignalGroup(cmd, syscall.SIGTERM)
	SignalAdopted(cmd, syscall.SIGTERM)
	// Each signal goes through the registry again: a group that ended in the meantime is
	// forgotten and is not signalled.
	time.AfterFunc(grace, func() {
		SignalGroup(cmd, syscall.SIGKILL)
		SignalAdopted(cmd, syscall.SIGKILL)
	})
}

// AdoptedGroups is the pgids adopted under the group of pid, for tests.
func AdoptedGroups(pid int) []int {
	groups.Lock()
	defer groups.Unlock()
	return adoptedOf(pid)
}
