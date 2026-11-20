package chats

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

func TestGitWorkerKeepsCloneOnResume(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is required to provision a worker")
	}
	e := newEnv(t)
	repo := t.TempDir()
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git(repo, "init")
	git(repo, "-c", "user.name=Worker Test", "-c", "user.email=test@example.invalid",
		"-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Base")
	git(repo, "worktree", "add", "--detach", e.cwd)
	git(e.cwd, "-c", "user.name=Worker Test", "-c", "user.email=test@example.invalid",
		"-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Worktree commit")
	head := git(e.cwd, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(e.cwd, "dirty.txt"), []byte("uncommitted"), 0o600); err != nil {
		t.Fatal(err)
	}
	codex := &fakeSpawner{}
	e.m.Spawners[model.Codex] = codex
	id, _ := e.idleParent()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "make a commit", Kind: model.Codex, Git: true})
	child := waitChild(t, codex, 1)
	binding := sa.GitWorkspace
	if binding.Path == "" || child.opts.Cwd != binding.Path || child.opts.GitWorkspace != binding {
		t.Fatalf("worker binding %+v, options %+v", binding, child.opts)
	}
	if got := git(binding.Path, "rev-parse", "HEAD"); got != head {
		t.Fatalf("clone HEAD %s, worktree HEAD %s", got, head)
	}
	if _, err := os.Stat(filepath.Join(binding.Path, "dirty.txt")); !os.IsNotExist(err) {
		t.Fatalf("uncommitted file should be absent in clone: %v", err)
	}
	if binding.SourceGitDir == binding.SourceCommonDir {
		t.Fatalf("linked worktree and common metadata paths must each be recorded: %+v", binding)
	}
	git(binding.Path, "switch", "-c", "worker-branch")
	if err := os.WriteFile(filepath.Join(binding.Path, "worker.txt"), []byte("worker change\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	git(binding.Path, "add", "worker.txt")
	git(binding.Path, "-c", "user.name=Worker Test", "-c", "user.email=test@example.invalid",
		"-c", "commit.gpgsign=false", "commit", "-m", "Worker change")
	git(e.cwd, "fetch", "--", binding.Path, "refs/heads/worker-branch")
	if got := git(e.cwd, "show", "FETCH_HEAD:worker.txt"); got != "worker change" {
		t.Fatalf("fetched worker content %q", got)
	}
	if got := e.subFile(id, sa.ID).GitWorkspace; got != binding {
		t.Fatalf("persisted binding %+v, want %+v", got, binding)
	}
	child.emit(t, agent.Event{Kind: agent.EvSession, SessionID: "git-worker-session"})
	e.m.Shutdown()
	e.boot()
	codex = &fakeSpawner{}
	e.m.Spawners[model.Codex] = codex
	t.Cleanup(e.m.Shutdown)
	if _, err := e.m.ResumeSubagent(id, sa.ID); err != nil {
		t.Fatal(err)
	}
	opts := waitChild(t, codex, 1).opts
	if !opts.Resume || opts.SessionID != "git-worker-session" || opts.Cwd != binding.Path || opts.GitWorkspace != binding {
		t.Fatalf("resumed with %+v, want session and binding %+v", opts, binding)
	}
}
