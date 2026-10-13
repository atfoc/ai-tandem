package runs

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/rungit"
)

// The checks of a start: what Start finds out about a run before it writes anything.

// svcPrepared is what a start found out before it writes anything.
type svcPrepared struct {
	tiers   model.RunTiers // checked and normalised (svcCheckTiers)
	facts   Facts
	checked bool         // facts were found out
	git     *Git         // nil: the run works without git
	repo    *rungit.Repo // the repository of git; nil without git
}

// svcPrepare is the checks of a start for a run.json that has no `started`: the agent, the tiers,
// the facts of the folder, where the work is in git. It writes nothing.
// ErrNoModel, ErrUnknownModel, *BlockedError.
func (s *Service) svcPrepare(meta model.RunMeta) (svcPrepared, error) {
	var p svcPrepared
	if meta.Agent == "" {
		// No agent, so no tiers: the answer is why the run is blocked, not ErrNoModel.
		p.facts, _ = s.svcFacts(meta, svcRec{})
		p.checked = true
		if err := svcBlockedErr(meta, p.facts); err != nil {
			return p, err
		}
		return p, &BlockedError{Reason: s.svcNoAgent()}
	}
	// The tiers are fixed here: a model that is gone refuses the start, an effort that is gone is
	// replaced by the model's default.
	tiers, err := svcCheckTiers(s.svcCatalog(meta.Agent), meta.Tiers)
	if err != nil {
		return p, err
	}
	p.tiers = tiers
	f, repo := s.svcFacts(meta, svcRec{})
	p.facts, p.checked = f, true
	if err := svcBlockedErr(meta, f); err != nil {
		return p, err
	}
	if repo == nil {
		return p, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), svcGitWait)
	defer cancel()
	base, err := repo.Resolve(ctx, "HEAD")
	if err != nil {
		return p, &BlockedError{Reason: "git cannot use this folder: " + err.Error()}
	}
	work := s.Store.P.RunWorkDir(meta.ID)
	git := &Git{RunGit: model.RunGit{BaseRef: base, IntegrationBranch: svcIntegrationBranch(meta.ID)}, Repo: repo.Root(),
		Integration: filepath.Join(work, "int"), Orchestrator: filepath.Join(work, "orch")}
	// The repository's top level has its symlinks resolved, so the folder must have too.
	if abs, err := filepath.Abs(meta.Cwd); err == nil {
		if real, err := filepath.EvalSymlinks(abs); err == nil {
			if sub, err := filepath.Rel(repo.Root(), real); err == nil && sub != "." && !strings.HasPrefix(sub, "..") {
				git.Sub = sub
			}
		}
	}
	git.DirtyAtStart = f.Dirty
	// The branch the folder is on ("" when its HEAD is detached): the result is applied by
	// itself only while the folder is still on it.
	if git.Branch, err = repo.Branch(ctx, repo.Root()); err != nil {
		return p, &BlockedError{Reason: "git cannot use this folder: " + err.Error()}
	}
	p.git, p.repo = git, repo
	return p, nil
}

// svcAbsDir is a folder as this machine resolves it: ~ expanded and made absolute. It does not
// look whether the folder exists.
func svcAbsDir(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		p = filepath.Join(home, strings.TrimPrefix(p, "~"))
	}
	return filepath.Abs(p)
}
