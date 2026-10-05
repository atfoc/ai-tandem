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
