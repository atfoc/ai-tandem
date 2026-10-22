//go:build !windows

package agent

import (
	"errors"
	"os/exec"
	"syscall"
)

// setNewGroup makes cmd the leader of a process group of its own when it starts.
func setNewGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// KillGroup sends sig to the process group pgid. Signal 0 only asks whether the group has a
// process; an error for which errors.Is(err, syscall.ESRCH) holds says it has none.
func KillGroup(pgid int, sig syscall.Signal) error {
	return syscall.Kill(-pgid, sig)
}

// KillGroupAfterExit is KillGroup for a group whose leader has already been waited for (cmd.Wait
// returned). On Unix it is KillGroup: the group still exists while a member is left, and its number
// cannot be reused while it does.
func KillGroupAfterExit(pgid int, sig syscall.Signal) error {
	return KillGroup(pgid, sig)
}

// ownGroup is the process group of this program, which Adopt never takes over.
func ownGroup() int { return syscall.Getpgrp() }

// ProcessAlive reports whether a process with the number pid exists (one this user may not
// signal counts as existing).
func ProcessAlive(pid int) bool {
	return !errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
}
