//go:build !windows

package main

import (
	"errors"
	"os"
	"os/signal"
	"syscall"

	"ai-whiteboard/internal/store"
)

// What the server program asks of the operating system, in its Unix form; platform_windows.go has
// the twin of each.

// reloadSupported says whether a running server can be told to read its secret again.
const reloadSupported = true

// tryLock takes an exclusive lock on f without waiting. A lock held by another process is an
// error for which lockBusy is true.
func tryLock(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}

// lockBusy says whether err from tryLock is "held by someone else, try again" (or interrupted).
func lockBusy(err error) bool {
	return errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EINTR)
}

// detachedAttr is the process attributes of a server that outlives its launcher: a session of its own.
func detachedAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

// terminateProcess asks the process pid to stop, so that it runs its shutdown (SIGTERM). An error
// for which errors.Is(err, syscall.ESRCH) holds says it is not there.
func terminateProcess(pid int) error {
	return syscall.Kill(pid, syscall.SIGTERM)
}

// requestStop asks the running server to stop so that it runs its shutdown: SIGTERM to its pid. An
// error for which errors.Is(err, syscall.ESRCH) holds says it is not there.
func requestStop(p store.Paths, run runningServer) error {
	return terminateProcess(run.hello.Pid)
}

// notifyReload makes the signal that asks the server to read its secret again arrive on ch.
func notifyReload(ch chan<- os.Signal) {
	signal.Notify(ch, syscall.SIGUSR1)
}

// signalReload asks the server process pid to read its secret again.
func signalReload(pid int) error {
	return syscall.Kill(pid, syscall.SIGUSR1)
}

// addrInUse says whether err is a bind that failed because the address is taken.
func addrInUse(err error) bool {
	return errors.Is(err, syscall.EADDRINUSE)
}
