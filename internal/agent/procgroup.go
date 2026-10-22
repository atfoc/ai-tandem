package agent

import (
	"errors"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// Each agent process runs as the leader of a process group of its own, so that when the server
// stops it can end the agent together with everything the agent started (Cursor's worker-server,
// language servers, ...), which would otherwise outlive the server. What the agent started in
// groups of their own is found and remembered too (Adopt, in proctree.go).

// ErrStopping is what StartGroup reports once EndAll has begun.
var ErrStopping = errors.New("the server is stopping")

var groups = struct {
	sync.Mutex
	pgids map[int]bool // the groups of agent processes started, and the groups Adopt found, not known to be empty
	// adopted holds, per leader's pgid, the groups Adopt found under it: groups that a descendant
	// of the leader leads, such as Claude's detached shells. Each is in pgids as well.
	adopted map[int]map[int]bool
	ending  bool
}{pgids: map[int]bool{}, adopted: map[int]map[int]bool{}}

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
	// Groups adopted under an earlier leader that had this number are no longer that leader's to
	// end through this one; they stay remembered for EndAll until they are empty.
	delete(groups.adopted, cmd.Process.Pid)
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
	watch(pgid)
}

// watch forgets the remembered group pgid, on a goroutine, once it is gone. It reads forgetEvery
// before it returns.
func watch(pgid int) {
	every := forgetEvery
	go func() {
		for !forget(pgid) {
			time.Sleep(every)
		}
	}()
}

// forgetEvery is how often a remembered group that may still have processes is looked at again
// (Exited, Adopt). A variable so that a test need not wait it out.
var forgetEvery = time.Second

// forget drops pgid if its group is gone, and reports whether the group is no longer remembered.
func forget(pgid int) bool {
	groups.Lock()
	defer groups.Unlock()
	if errors.Is(syscall.Kill(-pgid, 0), syscall.ESRCH) {
		dropLocked(pgid)
	}
	return !groups.pgids[pgid]
}

// dropLocked forgets the group pgid, as one of its own and as one adopted under a leader.
// groups held.
func dropLocked(pgid int) {
	delete(groups.pgids, pgid)
	for leader, set := range groups.adopted {
		delete(set, pgid)
		if len(set) == 0 {
			delete(groups.adopted, leader)
		}
	}
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
	return signalLocked(pgid, sig)
}

// signalLocked sends sig to the remembered group pgid and reports whether it was there to take
// it; a group found gone is forgotten. groups held.
func signalLocked(pgid int, sig syscall.Signal) bool {
	if err := syscall.Kill(-pgid, sig); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			dropLocked(pgid)
		}
		return false
	}
	return true
}

// EndAll ends every group StartGroup started, and every group a descendant of one of their
// leaders leads (see Adopt): SIGTERM, then SIGKILL to what is still there after grace. StartGroup
// fails from now on.
func EndAll(grace time.Duration) {
	groups.Lock()
	groups.ending = true
	groups.Unlock()
	adoptAll()
	groups.Lock()
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
