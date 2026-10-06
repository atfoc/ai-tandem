package runs

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// The files of a run's folder {home}/runs/<id>/ (store.Paths.RunDir). run.json is the service's;
// the journal and the checkpoint files are journal.go's; the text files are below. The folders
// agents/ and chats/ in it belong to the chat manager.
const (
	fileMeta    = "run.json"      // model.RunMeta
	fileGoal    = "goal.md"       // the goal, written once by the start
	fileJournal = "journal.jsonl" // one Entry per line
	fileState   = "state.json"    // StateFile, the head of a checkpoint
	fileTasks   = "tasks.json"    // TasksFile
	fileTurns   = "turns.json"    // TurnsFile
	fileAgents  = "agents.json"   // AgentsFile
)

// The text files of a run, as paths below its folder: what Tx.File takes.
func notesRel(v int) string                { return fmt.Sprintf("notes/v%04d.md", v) }
func briefRel(task string, rev int) string { return fmt.Sprintf("tasks/%s/brief.r%d.md", task, rev) }
func reportRel(task string, attempt int) string {
	return fmt.Sprintf("tasks/%s/a%d.report.md", task, attempt)
}
func changesRel(task string, attempt int) string {
	return fmt.Sprintf("tasks/%s/a%d.changes.json", task, attempt)
}
func setupLogRel(task string, attempt int) string {
	return fmt.Sprintf("tasks/%s/a%d.setup.log", task, attempt)
}

// safeID reports whether a task id from outside can be a folder name: the readers below are
// reached from routes and tool calls.
func safeID(id string) bool {
	return id != "" && id != "." && id != ".." && !strings.ContainsAny(id, `/\`) && filepath.IsLocal(id)
}

// writeText writes a text file below dir atomically (0600), making its folder (0700).
func writeText(dir, rel string, data []byte) error {
	if !filepath.IsLocal(rel) {
		return fmt.Errorf("%q is not a path inside the run's folder", rel)
	}
	path := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return store.WriteFileAtomic(path, data, 0o600)
}

// readText reads a text file below dir. ErrNoText when it does not exist.
func readText(dir, rel string) (string, error) {
	if !filepath.IsLocal(rel) {
		return "", ErrNoText
	}
	b, err := os.ReadFile(filepath.Join(dir, rel))
	if errors.Is(err, fs.ErrNotExist) {
		return "", ErrNoText
	}
	return string(b), err
}

// writeGoal writes goal.md; the start does it once, before its entry.
func writeGoal(dir, text string) error { return writeText(dir, fileGoal, []byte(text)) }

// readGoal reads goal.md. ErrNoText when the run has none.
func readGoal(dir string) (string, error) { return readText(dir, fileGoal) }

// writeBrief writes revision rev (from 1) of a task's brief: tasks/<id>/brief.r<rev>.md. Inside a
// commit use tx.File(briefRel(task, rev), text) instead, so that the file and its entry are one
// change.
func writeBrief(dir, task string, rev int, text string) error {
	if !safeID(task) {
		return ErrNoTask
	}
	return writeText(dir, briefRel(task, rev), []byte(text))
}

// readBrief reads a brief revision. ErrNoTask for an id that cannot be one, ErrNoText when the
// file does not exist.
func readBrief(dir, task string, rev int) (string, error) {
	if !safeID(task) {
		return "", ErrNoTask
	}
	return readText(dir, briefRel(task, rev))
}

// writeNotes writes version v (from 1) of the notes: notes/v0001.md. Inside a commit:
// tx.File(notesRel(v), text).
func writeNotes(dir string, v int, text string) error {
	return writeText(dir, notesRel(v), []byte(text))
}

// readNotes reads a notes version. ErrNoText when the file does not exist.
func readNotes(dir string, v int) (string, error) { return readText(dir, notesRel(v)) }

// writeReport writes the report of attempt n of a task (the agent's <report> block):
// tasks/<id>/a<n>.report.md. Inside a commit: tx.File(reportRel(task, n), text).
func writeReport(dir, task string, attempt int, text string) error {
	if !safeID(task) {
		return ErrNoTask
	}
	return writeText(dir, reportRel(task, attempt), []byte(text))
}

// readReport reads an attempt's report. ErrNoText when there is none yet.
func readReport(dir, task string, attempt int) (string, error) {
	if !safeID(task) {
		return "", ErrNoTask
	}
	return readText(dir, reportRel(task, attempt))
}

// changesData is an attempt's changes as the bytes of tasks/<id>/a<n>.changes.json, for
// tx.File(changesRel(task, n), …). Files and Commits are written as lists, never null.
func changesData(c model.AttemptChanges) []byte {
	c.Files, c.Commits = orEmpty(c.Files), orEmpty(c.Commits)
	b, _ := json.MarshalIndent(c, "", "  ")
	return append(b, '\n')
}

// writeChanges writes what an attempt changed: tasks/<id>/a<n>.changes.json. It is made when the
// attempt's head is recorded and written again when it is merged.
func writeChanges(dir, task string, attempt int, c model.AttemptChanges) error {
	if !safeID(task) {
		return ErrNoTask
	}
	return writeText(dir, changesRel(task, attempt), changesData(c))
}

// readChanges reads an attempt's changes. ErrNoText when there are none yet.
func readChanges(dir, task string, attempt int) (model.AttemptChanges, error) {
	var c model.AttemptChanges
	if !safeID(task) {
		return c, ErrNoTask
	}
	text, err := readText(dir, changesRel(task, attempt))
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal([]byte(text), &c); err != nil {
		return c, fmt.Errorf("read %s: %w", changesRel(task, attempt), err)
	}
	c.Files, c.Commits = orEmpty(c.Files), orEmpty(c.Commits)
	return c, nil
}

// setupLogPath is the file the setup command of attempt n of a task writes to:
// tasks/<id>/a<n>.setup.log. openSetupLog opens it.
func setupLogPath(dir, task string, attempt int) string {
	return filepath.Join(dir, setupLogRel(task, attempt))
}

// openSetupLog opens an attempt's setup log to append to it, making it and its folder.
func openSetupLog(dir, task string, attempt int) (*os.File, error) {
	if !safeID(task) {
		return nil, ErrNoTask
	}
	path := setupLogPath(dir, task, attempt)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
}

// readMeta reads run.json. A folder without one is not a run (fs.ErrNotExist).
func readMeta(dir string) (model.RunMeta, error) {
	var m model.RunMeta
	b, err := os.ReadFile(filepath.Join(dir, fileMeta))
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, fmt.Errorf("read %s: %w", filepath.Join(dir, fileMeta), err)
	}
	// A run.json written before tiers has one model and effort: every tier runs on them.
	if m.Tiers == (model.RunTiers{}) {
		var old model.ModelChoice
		if json.Unmarshal(b, &old) == nil && old.Model != "" {
			m.Tiers = model.RunTiers{Deep: old, Standard: old, Light: old}
		}
	}
	return m, nil
}

// writeMeta writes run.json (0600), making the run's folder (0700).
func writeMeta(dir string, m model.RunMeta) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return store.WriteJSONAtomic(filepath.Join(dir, fileMeta), m, 0o600)
}

// removeRecord removes what an earlier start that did not get to write run.json left in the
// folder: the journal, the checkpoint files and the goal. The start calls it first.
func removeRecord(dir string) error {
	for _, name := range []string{fileJournal, fileState, fileTasks, fileTurns, fileAgents, fileGoal} {
		if err := os.Remove(filepath.Join(dir, name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}
