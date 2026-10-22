package main

import (
	"errors"
	"net/http"
	"os"
	"syscall"
	"time"
	"unsafe"

	"ai-whiteboard/internal/store"
)

// What the server program asks of the operating system, in its Windows form; platform_unix.go has
// the twin of each.

// reloadSupported is false: there is no signal that makes a running server read its secret
// again, so a new secret takes effect when the server is restarted.
const reloadSupported = false

const (
	lockfileFailImmediately = 0x00000001 // LOCKFILE_FAIL_IMMEDIATELY
	lockfileExclusiveLock   = 0x00000002 // LOCKFILE_EXCLUSIVE_LOCK
	errorLockViolation      = syscall.Errno(33)
	errorInvalidParameter   = syscall.Errno(87) // what OpenProcess says for a pid that is not there
	wsaEADDRINUSE           = syscall.Errno(10048)

	createNewProcessGroup = 0x00000200 // CREATE_NEW_PROCESS_GROUP
	detachedProcess       = 0x00000008 // DETACHED_PROCESS
	processTerminate      = 0x00000001 // PROCESS_TERMINATE
)

var (
	kernel32       = syscall.NewLazyDLL("kernel32.dll")
	procLockFileEx = kernel32.NewProc("LockFileEx")
	errNoReloadSig = errors.New("this system has no signal that makes a running server read its secret again; restart the server")
)

// tryLock takes an exclusive lock on f (LockFileEx, the first byte) without waiting. A lock held
// by another process is an error for which lockBusy is true. The lock ends when f is closed or the
// process ends.
func tryLock(f *os.File) error {
	var ol syscall.Overlapped
	r, _, err := procLockFileEx.Call(f.Fd(), lockfileExclusiveLock|lockfileFailImmediately, 0, 1, 0, uintptr(unsafe.Pointer(&ol)))
	if r == 0 {
		return err
	}
	return nil
}

// lockBusy says whether err from tryLock is "held by someone else, try again".
func lockBusy(err error) bool {
	return errors.Is(err, errorLockViolation)
}

// detachedAttr is the process attributes of a server that outlives its launcher: no console, and a
// process group of its own.
func detachedAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: createNewProcessGroup | detachedProcess, HideWindow: true}
}

// requestStop asks the running server to stop so that it runs its shutdown. A Windows process
// without a console cannot be asked with a signal, so it is asked over its control socket (POST
// /stop, the same shutdown as SIGTERM) and given 10 s to stop answering. Only a server that does
// not answer the request (one of the build before has no such route, or the socket is not there) or
// that is still answering after the wait is ended with TerminateProcess, which skips its shutdown;
// stopServer waits for it again. An error for which errors.Is(err, syscall.ESRCH) holds says it is
// not there.
func requestStop(p store.Paths, run runningServer) error {
	pid := run.hello.Pid
	if run.control != "" {
		if status, err := controlPost(run.control, "/stop", 3*time.Second); err == nil && status == http.StatusAccepted {
			if waitStopped(p, pid, 10*time.Second) {
				return nil
			}
		}
	}
	return terminateProcess(pid)
}

// terminateProcess ends the process pid (TerminateProcess). Its shutdown does not run. An
// error for which errors.Is(err, syscall.ESRCH) holds says it is not there.
func terminateProcess(pid int) error {
	h, err := syscall.OpenProcess(processTerminate, false, uint32(pid))
	if err != nil {
		if errors.Is(err, errorInvalidParameter) {
			return syscall.ESRCH
		}
		return err
	}
	defer syscall.CloseHandle(h)
	return syscall.TerminateProcess(h, 1)
}

// notifyReload does nothing: see reloadSupported.
func notifyReload(ch chan<- os.Signal) {}

// signalReload says that it cannot be done: see reloadSupported.
func signalReload(pid int) error { return errNoReloadSig }

// addrInUse says whether err is a bind that failed because the address is taken (WSAEADDRINUSE).
func addrInUse(err error) bool {
	return errors.Is(err, wsaEADDRINUSE) || errors.Is(err, syscall.EADDRINUSE)
}
