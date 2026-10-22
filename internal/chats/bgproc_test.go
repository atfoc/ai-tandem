package chats

import (
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/testset"
)

// The background rule against real processes: the Node stand-in of Claude (agenttest.FakeClaude)
// behind the real claude.Spawner starts a real, harmless `sleep` the way Claude starts its shell,
// and these tests look at the machine's process list after the agent has been ended in each way.

// procLimit bounds what must happen with real processes: node and the shell start slowly on a
// loaded machine.
const procLimit = 60 * time.Second

// bgProcEnv is an env whose Claude agents are processes of the stand-in, and the pid file the
// stand-in writes the pid of each command's shell to. Whatever it started is killed when the test
// ends, so a failing test leaves no sleep behind.
func bgProcEnv(t *testing.T) (e *env, pidFile string) {
	t.Helper()
	testset.SkipUnlessFull(t, "each starts node and a shell and waits out the end of the process tree; in the default set: TestCloseEndsTheTree and TestAnnouncedShellEndsWithASelfExit (internal/claude)")
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH")
	}
	pidFile = filepath.Join(t.TempDir(), "bgpids")
	t.Setenv("FAKE_CLAUDE_BGPIDS", pidFile) // no t.Parallel in these tests
	e = newEnv(t)
	e.m.bgQuietWait = time.Hour
	e.m.Spawners[model.Claude] = &claude.Spawner{Bin: agenttest.FakeClaude(t), AppRoot: e.root, Home: t.TempDir()}
	t.Cleanup(func() {
		// Stop drops whatever a closing process still says, so that nothing is written into the
		// data folder while it is removed.
		for _, v := range e.m.Views() {
			e.m.Stop(v.ID)
		}
		e.m.Shutdown()
		for _, pid := range bgPids(pidFile) {
			syscall.Kill(-pid, syscall.SIGKILL)
		}
	})
	return e, pidFile
}

// bgSeconds is the argument of a sleep no other process has: the test's own commands are told
// apart from any other `sleep` on the machine by it.
func bgSeconds() string { return fmt.Sprintf("60.%06d", 100000+rand.Intn(900000)) }

// bgPids is the pids of the shells the stand-in started.
func bgPids(file string) []int {
	b, _ := os.ReadFile(file)
	var pids []int
	for _, f := range strings.Fields(string(b)) {
		if pid, err := strconv.Atoi(f); err == nil && pid > 1 {
			pids = append(pids, pid)
		}
	}
	return pids
}

// waitLong is waitFor with a limit for real processes.
func waitLong(t *testing.T, what string, f func() bool) {
	t.Helper()
	for deadline := time.Now().Add(procLimit); !f(); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

// startedShell waits for the stand-in to have started the command and returns the pid of its shell.
func startedShell(t *testing.T, pidFile, seconds string) int {
	t.Helper()
	waitLong(t, "the background command to start", func() bool { return len(bgPids(pidFile)) == 1 })
	// The shell's pid is written as it starts; the sleep is its child a moment later.
	waitLong(t, "sleep "+seconds+" to run", func() bool { return len(sleepers(t, seconds)) == 1 })
	return bgPids(pidFile)[0]
}

// sleepers is the pids of the live `sleep SECONDS` processes in the machine's process list.
func sleepers(t *testing.T, seconds string) []int {
	t.Helper()
	out, err := exec.Command("ps", "-axo", "pid=,stat=,command=").Output()
	if err != nil {
		t.Fatal(err)
	}
	var pids []int
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) == 4 && f[2] == "sleep" && f[3] == seconds && !strings.HasPrefix(f[1], "Z") {
			if pid, err := strconv.Atoi(f[0]); err == nil {
				pids = append(pids, pid)
			}
		}
	}
	return pids
}

// noCommand fails unless, within procLimit, the shell's group is gone and no `sleep SECONDS`
// is left in the process list.
func noCommand(t *testing.T, when string, pid int, seconds string) {
	t.Helper()
	groupGone := func() bool { return syscall.Kill(-pid, 0) == syscall.ESRCH }
	waitLong(t, "the command's group to be gone after "+when, func() bool {
		return groupGone() && len(sleepers(t, seconds)) == 0
	})
}

// waitingProcChat makes a chat of the stand-in that has started a command and waits on it.
func (e *env) waitingProcChat(directives string) string {
	e.t.Helper()
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, directives, "")
	waitLong(e.t, "the chat to wait", func() bool { return e.view(v.ID).Status == model.StatusWaiting })
	return v.ID
}

// Stopping a subagent that waits on its command ends the command with the subagent's process.
func TestStoppingAWaitingSubagentLeavesNoCommand(t *testing.T) {
	e, pidFile := bgProcEnv(t)
	secs := bgSeconds()
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "hello", "")
	waitLong(t, "the chat to be ready", func() bool { return e.view(v.ID).Status == model.StatusReady })
	s, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "[[bg " + secs + "]]"})
	if err != nil {
		t.Fatal(err)
	}
	waitLong(t, "the subagent to wait", func() bool { return e.sub(v.ID, s.ID).BgWaiting })
	pid := startedShell(t, pidFile, secs)

	if err := e.m.StopSubagent(v.ID, s.ID); err != nil {
		t.Fatal(err)
	}
	noCommand(t, "the subagent was stopped", pid, secs)
	if got := e.sub(v.ID, s.ID); got.Status != model.SubStopped {
		t.Errorf("the subagent is %+v, want stopped", got)
	}
}

// Stopping a chat that waits closes its process, and the command goes with it; the chat is ready.
func TestStoppingAWaitingChatLeavesNoCommand(t *testing.T) {
	e, pidFile := bgProcEnv(t)
	secs := bgSeconds()
	id := e.waitingProcChat("[[bg " + secs + "]]")
	pid := startedShell(t, pidFile, secs)

	if err := e.m.Interrupt(id); err != nil {
		t.Fatal(err)
	}
	noCommand(t, "the chat was stopped", pid, secs)
	if st := e.view(id).Status; st != model.StatusReady {
		t.Errorf("status %q after the stop, want ready", st)
	}
	if !slices.Contains(itemTexts(e.items(id)), "waiting") {
		t.Errorf("the thread %q lacks the turn's text", itemTexts(e.items(id)))
	}
}

// Deleting a chat that waits ends its command too.
func TestDeletingAWaitingChatLeavesNoCommand(t *testing.T) {
	e, pidFile := bgProcEnv(t)
	secs := bgSeconds()
	id := e.waitingProcChat("[[bg " + secs + "]]")
	pid := startedShell(t, pidFile, secs)

	if err := e.m.Delete(id); err != nil {
		t.Fatal(err)
	}
	noCommand(t, "the chat was deleted", pid, secs)
}

// The server's shutdown ends the command of a chat that waits.
func TestShutdownLeavesNoCommand(t *testing.T) {
	e, pidFile := bgProcEnv(t)
	secs := bgSeconds()
	e.waitingProcChat("[[bg " + secs + "]]")
	pid := startedShell(t, pidFile, secs)

	e.m.Shutdown()
	noCommand(t, "the shutdown", pid, secs)
}

// A process that ends by itself while its command runs leaves no command either, and the chat is
// told, as it is for any ending of the process. The stand-in leaves only once its shell has been
// adopted (FAKE_CLAUDE_LEAVE_GATE): the walk of the process tree that finds it is the part of the
// ending that a process which exits at once outruns.
func TestSelfExitLeavesNoCommand(t *testing.T) {
	e, pidFile := bgProcEnv(t)
	gate := filepath.Join(t.TempDir(), "gate")
	t.Setenv("FAKE_CLAUDE_LEAVE_GATE", gate)
	secs := bgSeconds()
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "[[bg "+secs+"]] [[leave]]", "")
	pid := startedShell(t, pidFile, secs)

	out, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		t.Fatal(err)
	}
	proc, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	waitLong(t, "the shell to be adopted", func() bool { return slices.Contains(agent.AdoptedGroups(proc), pid) })
	if err := os.WriteFile(gate, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	noCommand(t, "the process ended by itself", pid, secs)
	waitLong(t, "the chat to be told", func() bool { return e.view(v.ID).Status == model.StatusStopped })
	items := e.items(v.ID)
	if last := items[len(items)-1]; last.Kind != "note" || last.Text != "The agent stopped: process ended" {
		t.Errorf("the thread ends with %s %q, want the note that the agent stopped", last.Kind, last.Text)
	}
}

// A command that ends by itself: the chat waits, then works on the turn the process begins, then
// is ready, and the thread holds both turns' texts (goal 6.2 with real processes).
func TestBackgroundCommandEndsAndTheChatIsIdle(t *testing.T) {
	e, _ := bgProcEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "[[bg 0.5]]", "")
	waitLong(t, "the chat to wait", func() bool { return e.view(v.ID).Status == model.StatusWaiting })
	waitLong(t, "the chat to be ready again", func() bool { return e.view(v.ID).Status == model.StatusReady })
	texts := itemTexts(e.items(v.ID))
	if !slices.Contains(texts, "waiting") || !slices.Contains(texts, "bg1 done") {
		t.Errorf("the thread's texts %q, want waiting and bg1 done", texts)
	}
}

// shellN waits for the stand-in to have started n commands and returns the pid of the shell of the
// last, whose sleep is seconds.
func shellN(t *testing.T, pidFile, seconds string, n int) int {
	t.Helper()
	waitLong(t, "the background commands to start", func() bool { return len(bgPids(pidFile)) == n })
	waitLong(t, "sleep "+seconds+" to run", func() bool { return len(sleepers(t, seconds)) == 1 })
	return bgPids(pidFile)[n-1]
}

// running checks that the command of the shell pid is still there: its group and its sleep.
func running(t *testing.T, when string, pid int, seconds string) {
	t.Helper()
	if syscall.Kill(-pid, 0) != nil || len(sleepers(t, seconds)) != 1 {
		t.Fatalf("the command sleep %s is gone %s", seconds, when)
	}
}

// A branch of a chat that waits is made while the source keeps its process (goal 3.4: a source that
// works is not ended by a branch), so the source's command runs on. The branch has a process of
// its own and a command of its own: stopping the branch ends that command and not the source's,
// and stopping the source ends the rest.
func TestBranchingAWaitingChatLeavesNoCommand(t *testing.T) {
	e, pidFile := bgProcEnv(t)
	secs, branchSecs := bgSeconds(), bgSeconds()
	id := e.waitingProcChat("[[bg " + secs + "]]")
	pid := startedShell(t, pidFile, secs)

	e.sendTo(id, newAt(4), "[[bg "+branchSecs+"]]")
	bid := branchChatID(id, e.cur(id))
	branchPid := shellN(t, pidFile, branchSecs, 2)
	running(t, "after the branch was made", pid, secs)

	e.m.stopBranch(bid)
	noCommand(t, "the branch was stopped", branchPid, branchSecs)
	running(t, "after the branch was stopped", pid, secs)

	if err := e.m.InterruptOf(id, model.MainBranch); err != nil {
		t.Fatal(err)
	}
	noCommand(t, "the source was stopped", pid, secs)
}

// The same for a fork: the new chat has its own process, and its own command once it starts one.
// Deleting the fork ends its command and leaves the source's; deleting the source ends that.
func TestForkingAWaitingChatLeavesNoCommand(t *testing.T) {
	e, pidFile := bgProcEnv(t)
	secs, forkSecs := bgSeconds(), bgSeconds()
	id := e.waitingProcChat("[[bg " + secs + "]]")
	pid := startedShell(t, pidFile, secs)

	fv, err := e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: 4})
	if err != nil {
		t.Fatal(err)
	}
	running(t, "after the fork was made", pid, secs)
	e.send(fv.ID, "[[bg "+forkSecs+"]]", "")
	forkPid := shellN(t, pidFile, forkSecs, 2)

	if err := e.m.Delete(fv.ID); err != nil {
		t.Fatal(err)
	}
	noCommand(t, "the fork was deleted", forkPid, forkSecs)
	running(t, "after the fork was deleted", pid, secs)

	if err := e.m.Delete(id); err != nil {
		t.Fatal(err)
	}
	noCommand(t, "the source was deleted", pid, secs)
}
