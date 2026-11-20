// Package gitworker provisions the independent clones used by Codex subagents.
package gitworker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"ai-whiteboard/internal/model"
)

// Provision copies the committed history and checkout on the chat's current HEAD.
func Provision(appRoot, cwd string) (model.GitWorkspace, error) {
	var binding model.GitWorkspace
	if cwd == "" {
		return binding, errors.New("git mode requires a chat folder in a Git repository")
	}
	appRoot, err := canonical(appRoot)
	if err != nil {
		return binding, fmt.Errorf("resolve Whiteboard state directory: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for _, path := range []struct {
		result *string
		arg    string
	}{
		{&binding.SourceRoot, "--show-toplevel"},
		{&binding.SourceGitDir, "--absolute-git-dir"},
		{&binding.SourceCommonDir, "--git-common-dir"},
	} {
		raw, err := git(ctx, cwd, "rev-parse", "--path-format=absolute", path.arg)
		if err != nil {
			return model.GitWorkspace{}, fmt.Errorf("resolve the chat's Git repository: %w", err)
		}
		*path.result, err = canonical(strings.TrimSuffix(string(raw), "\n"))
		if err != nil {
			return model.GitWorkspace{}, fmt.Errorf("resolve the chat's Git repository: %w", err)
		}
		if overlaps(appRoot, *path.result) {
			return model.GitWorkspace{}, fmt.Errorf("the chat's Git repository overlaps the Whiteboard state directory: %q", *path.result)
		}
	}

	pool := appRoot + "-workers"
	for _, protected := range protectedPaths(appRoot, binding) {
		if overlaps(pool, protected) {
			return model.GitWorkspace{}, fmt.Errorf("worker clone directory %q overlaps %q", pool, protected)
		}
	}
	if err := os.Mkdir(pool, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return model.GitWorkspace{}, err
	}
	if err := checkDirectory(pool); err != nil {
		return model.GitWorkspace{}, err
	}
	binding.Path, err = os.MkdirTemp(pool, "codex-")
	if err != nil {
		return model.GitWorkspace{}, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.RemoveAll(binding.Path)
		}
	}()
	// Force Git transport for a local source so objects are neither hardlinked nor
	// borrowed through alternates. Use no hooks from system/user Git templates.
	if _, err := git(ctx, cwd, "clone", "--no-local", "--no-recurse-submodules", "--template=", "--", binding.SourceRoot, binding.Path); err != nil {
		return model.GitWorkspace{}, fmt.Errorf("clone the chat's Git repository: %w", err)
	}
	if err := Validate(appRoot, binding); err != nil {
		return model.GitWorkspace{}, err
	}
	keep = true
	return binding, nil
}

// Validate checks the recorded clone on every launch, including resume. A moved
// or replaced worktree must never redirect the permission grant.
func Validate(appRoot string, binding model.GitWorkspace) error {
	root, err := canonical(appRoot)
	if err != nil {
		return fmt.Errorf("resolve Whiteboard state directory: %w", err)
	}
	pool := root + "-workers"
	if filepath.Dir(binding.Path) != pool {
		return fmt.Errorf("worker clone %q is outside %q", binding.Path, pool)
	}
	for _, protected := range protectedPaths(root, binding) {
		if !filepath.IsAbs(protected) || overlaps(binding.Path, protected) {
			return fmt.Errorf("worker clone %q has an invalid protected path %q", binding.Path, protected)
		}
	}
	gitDir := filepath.Join(binding.Path, ".git")
	for _, dir := range []string{binding.Path, gitDir} {
		if err := checkDirectory(dir); err != nil {
			return err
		}
	}
	if _, err := os.Lstat(filepath.Join(gitDir, "commondir")); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("worker Git directory %q must be independent", gitDir)
	}
	if _, err := os.Lstat(filepath.Join(gitDir, "objects", "info", "alternates")); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("worker Git directory %q must use its own object store", gitDir)
	}
	return nil
}

func protectedPaths(appRoot string, binding model.GitWorkspace) []string {
	return []string{appRoot, binding.SourceRoot, binding.SourceGitDir, binding.SourceCommonDir}
}

func overlaps(a, b string) bool {
	within := func(path, root string) bool {
		rel, err := filepath.Rel(root, path)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
		// Canonical paths can still spell the same directory with different case.
		rootInfo, err := os.Stat(root)
		if err != nil {
			return false
		}
		for {
			if info, err := os.Stat(path); err == nil && os.SameFile(info, rootInfo) {
				return true
			}
			parent := filepath.Dir(path)
			if parent == path {
				return false
			}
			path = parent
		}
	}
	return within(a, b) || within(b, a)
}

func canonical(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

func checkDirectory(path string) error {
	resolved, err := canonical(path)
	if err != nil {
		return fmt.Errorf("resolve worker directory %q: %w", path, err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return err
	}
	if resolved != path || !info.IsDir() {
		return fmt.Errorf("worker directory %q must be a directory at its recorded location", path)
	}
	return nil
}

func git(ctx context.Context, cwd string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	cmd.WaitDelay = time.Second
	for _, env := range cmd.Environ() {
		// Ignore overrides for Git directories, object stores, filters, and templates.
		if !strings.HasPrefix(strings.ToUpper(env), "GIT_") {
			cmd.Env = append(cmd.Env, env)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_ALLOW_PROTOCOL=file")
	raw, err := cmd.Output()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && len(exit.Stderr) > 0 {
		return nil, fmt.Errorf("%w: %s", err, strings.TrimSpace(string(exit.Stderr)))
	}
	return raw, err
}
