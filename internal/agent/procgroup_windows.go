package agent

import (
	"errors"
	"os/exec"
	"strconv"
	"syscall"
)

// Windows has no process groups to signal and no signals. A "group" here is the process tree of
// the process that leads it: it is ended with taskkill /T, and it counts as gone when its leader is
// gone. Best effort: what the leader started and what has been reparented since is not found by
// taskkill, and a signal other than 0 ends the tree whatever it is.

const (
	createNewProcessGroup = 0x00000200 // CREATE_NEW_PROCESS_GROUP
	processQueryLimited   = 0x00001000 // PROCESS_QUERY_LIMITED_INFORMATION
	stillActive           = 259        // STILL_ACTIVE, the exit code of a process that has not exited
)

// setNewGroup makes cmd start in a process group of its own, without a console window.
func setNewGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= createNewProcessGroup
	cmd.SysProcAttr.HideWindow = true
}

// KillGroup ends the process tree led by pgid; signal 0 only asks whether its leader is there.
// It returns syscall.ESRCH when the leader is gone, like the Unix call does for a group.
func KillGroup(pgid int, sig syscall.Signal) error {
	if !ProcessAlive(pgid) {
		return syscall.ESRCH
	}
	if sig == 0 {
		return nil
	}
	kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pgid))
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := kill.Run(); err != nil {
		if !ProcessAlive(pgid) {
			return syscall.ESRCH
		}
		return err
	}
	return nil
}

// KillGroupAfterExit is KillGroup for a tree whose leader has already been waited for (cmd.Wait
// returned). It does nothing on Windows and says the tree is gone (syscall.ESRCH): Wait releases the
// leader's handle, Windows may then give its pid to an unrelated process, and taskkill /T /F /PID
// would end that process and its tree. What the leader left behind is not found through its pid
// any more; the tree is ended while the leader is alive (KillGroup, SignalGroup, EndAll).
func KillGroupAfterExit(pgid int, sig syscall.Signal) error {
	return syscall.ESRCH
}

// ownGroup is -1: there is no group of this program that Adopt could take over.
func ownGroup() int { return -1 }

// ProcessAlive reports whether a process with the number pid exists and has not exited (one this
// user may not open counts as existing).
func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := syscall.OpenProcess(processQueryLimited, false, uint32(pid))
	if err != nil {
		return errors.Is(err, syscall.ERROR_ACCESS_DENIED)
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if err := syscall.GetExitCodeProcess(h, &code); err != nil {
		return true
	}
	return code == stillActive
}
