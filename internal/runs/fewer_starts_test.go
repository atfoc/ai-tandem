package runs

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// While a run goes on, gitFacts takes the head of the integration branch from the list of its
// commits, with one command. It is the commit git resolves the branch to, also when the dates
// of the commits say otherwise: here the tip is from the year 2000 and the commit below it from
// 2040. The branch is made by hand; no engine runs.
func TestGitFactsHeadIsTheHeadOfTheBranch(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, true)
	r := e.run("r_facts", nil)
	g := r.engGit()
	if g.ResultHead != "" {
		t.Fatalf("the run has a result already: %s", g.ResultHead)
	}
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "GIT_") {
			env = append(env, kv)
		}
	}
	commit := func(msg, date string) {
		t.Helper()
		cmd := exec.Command("git", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", msg)
		cmd.Dir = e.repo.Dir()
		cmd.Env = append(append(env, e.repo.Env()...), "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git commit: %v\n%s", err, out)
		}
	}
	commit("from 2040", "@2208988800 +0000")
	commit("the tip, from 2000", "@946684800 +0000")
	branch := engIntBranch(r.id, g)
	e.repo.Git("branch", branch, "HEAD")

	repo, err := e.s.openRepo(t.Context(), g.Repo)
	if err != nil {
		t.Fatal(err)
	}
	head, err := repo.Resolve(t.Context(), branch)
	if err != nil {
		t.Fatal(err)
	}
	if subject := e.repo.Git("log", "-1", "--format=%s", head); subject != "the tip, from 2000" {
		t.Fatalf("the branch is at %q", subject)
	}
	if f, err := r.gitFacts(t.Context()); err != nil || f.Head != head || f.Commits != 2 {
		t.Errorf("gitFacts = %+v, %v, want the head %s that Resolve gives and 2 commits", f, err, head)
	}
}
