package agenttest

import (
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// Repo is a temp git repository for tests: git init -b main, an identity of its own, the user's
// and the system's git config switched off (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1),
// commit.gpgsign=false. It has no commit until Commit is called.
type Repo struct {
	t   testing.TB
	dir string
	env []string
}

// NewRepo makes the repository in a folder of t.TempDir(). The test is skipped when git is not
// installed.
func NewRepo(t testing.TB) *Repo {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not on PATH")
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r := &Repo{t: t, dir: filepath.Join(base, "repo")}
	if err := os.MkdirAll(r.dir, 0o755); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(base, "home") // nothing of the user's is read through HOME either
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	r.env = []string{"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "HOME=" + home, "XDG_CONFIG_HOME=" + home,
		"GIT_TERMINAL_PROMPT=0"}
	r.Git("init", "-q", "-b", "main")
	// The identity and commit.gpgsign=false, written as three "git config" commands would write
	// them: every process a test does not start is time for the tests beside it.
	cfg, err := os.OpenFile(filepath.Join(r.dir, ".git", "config"), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, err = cfg.WriteString("[user]\n\tname = Run Tester\n\temail = run-tester@localhost\n[commit]\n\tgpgsign = false\n")
	if cerr := cfg.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// Dir is the repository's top level, with symlinks resolved (git prints paths that way).
func (r *Repo) Dir() string { return r.dir }

// Env is the environment that keeps git away from the user's and the system's config, as
// "KEY=value" entries to add to a command's environment (rungit.WithEnv(r.Env()...)).
func (r *Repo) Env() []string { return append([]string(nil), r.env...) }

// Write writes a file below the top level, making its folders.
func (r *Repo) Write(rel, content string) {
	r.t.Helper()
	path := filepath.Join(r.dir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		r.t.Fatal(err)
	}
}

// Commit commits everything in the work tree (an empty commit when nothing changed) and returns
// the new head.
func (r *Repo) Commit(msg string) string {
	r.t.Helper()
	r.Git("add", "-A")
	r.Git("commit", "-q", "--allow-empty", "-m", msg)
	return r.Git("rev-parse", "HEAD")
}

// Git runs git in the top level and returns its trimmed output; a failure fails the test.
func (r *Repo) Git(args ...string) string {
	r.t.Helper()
	out, err := r.GitIn(r.dir, args...)
	if err != nil {
		r.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return out
}

// GitIn runs git in dir (a linked work tree of the repository, say) with the repository's
// environment and returns its trimmed output and the command's error.
func (r *Repo) GitIn(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(cleanEnv(), r.env...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// cleanEnv is the test's environment without the variables that would point git at another
// repository or identity.
func cleanEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(name, "GIT_") {
			continue
		}
		env = append(env, kv)
	}
	return env
}

// FastGit puts the real git ahead of /usr/bin/git on PATH for the rest of the test binary's life.
// On macOS /usr/bin/git is a shim that looks the real one up on every call, which doubles the
// cost of a git command; the run tests make thousands. It changes nothing elsewhere, or when the
// real one cannot be found. Call it from TestMain.
func FastGit() {
	if runtime.GOOS != "darwin" {
		return
	}
	if p, err := exec.LookPath("git"); err != nil || p != "/usr/bin/git" {
		return
	}
	out, err := exec.Command("xcrun", "-f", "git").Output()
	real := strings.TrimSpace(string(out))
	if err != nil || !filepath.IsAbs(real) {
		return
	}
	if fi, err := os.Stat(real); err != nil || fi.IsDir() {
		return
	}
	os.Setenv("PATH", filepath.Dir(real)+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// SpawnBound is how many tests of a binary whose tests mostly wait for git run at once on macOS.
// A Mac starts some 800 processes a second, for everybody on it, and four tests that start git
// commands one after the other already take all of that: with more at once the binary is done no
// sooner, and each test takes that much longer against its wall-clock waits.
const SpawnBound = 4

// LimitParallel makes at most SpawnBound tests of the binary run at once on macOS, unless the
// command line says how many (-parallel) or fewer would anyway. It changes nothing elsewhere.
// Call it from TestMain, before m.Run.
func LimitParallel() {
	if runtime.GOOS != "darwin" {
		return
	}
	if !flag.Parsed() {
		flag.Parse()
	}
	given := false
	flag.Visit(func(f *flag.Flag) { given = given || f.Name == "test.parallel" })
	if given || runtime.GOMAXPROCS(0) <= SpawnBound {
		return
	}
	flag.Set("test.parallel", strconv.Itoa(SpawnBound))
}
