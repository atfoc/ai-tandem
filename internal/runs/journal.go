package runs

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"ai-whiteboard/internal/store"
)

// This file is the journal and the checkpoint of a run's recorded state.
//
// journal.jsonl is the commit unit: one Entry per line, appended with one write. An entry is
// whole when its line ends with a newline and is JSON; a last line that is not whole was torn by
// a crash, was never acknowledged, and is dropped when the journal is read.
//
// state.json, tasks.json, turns.json and agents.json are a checkpoint: the records as of entry
// StateFile.Version, with the journal's size at that moment (JournalOffset). The collection files
// are written first and state.json last, so a crash in between leaves collection files that are
// newer than state.json: the entries from the old offset are then applied again, which ends at
// the same state because every patch holds whole records.

// A checkpoint is written by itself after this many entries or journal bytes since the last one.
const (
	checkpointEntries = 200
	checkpointBytes   = 1 << 20
)

// appendJournal appends one entry as one line at byte at, which must be the end of the last
// whole entry. Whatever is in the file past at (a torn line, the rest of a write that failed) is
// cut off first. When the write fails the file is cut back to at, so a failed append leaves the
// journal as it was.
func appendJournal(dir string, at int64, e Entry) (size int64, err error) {
	line, err := json.Marshal(e)
	if err != nil {
		return at, err
	}
	line = append(line, '\n')
	f, err := os.OpenFile(filepath.Join(dir, fileJournal), os.O_WRONLY|os.O_CREATE, 0o600)
	if err != nil {
		return at, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return at, err
	}
	switch {
	case fi.Size() < at:
		return at, fmt.Errorf("%s is %d bytes, shorter than the %d recorded", fileJournal, fi.Size(), at)
	case fi.Size() > at:
		if err := f.Truncate(at); err != nil {
			return at, err
		}
	}
	if _, err := f.WriteAt(line, at); err != nil {
		f.Truncate(at)
		return at, err
	}
	return at + int64(len(line)), nil
}

// journalSize is the size of the journal file; 0 when there is none.
func journalSize(dir string) int64 {
	fi, err := os.Stat(filepath.Join(dir, fileJournal))
	if err != nil {
		return 0
	}
	return fi.Size()
}

// readJournal reads the whole entries of the journal from byte from, in order. end is the byte
// after the last whole entry: where the next one is appended. torn reports that the file goes on
// past end with a line that is not whole (cut by a crash); the caller drops it. A line that is
// not whole and is followed by another is damage no crash explains: an error.
func readJournal(dir string, from int64) (entries []Entry, end int64, torn bool, err error) {
	b, err := os.ReadFile(filepath.Join(dir, fileJournal))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, 0, false, nil
	}
	if err != nil {
		return nil, 0, false, err
	}
	if from > int64(len(b)) || from < 0 {
		from = int64(len(b)) // an offset past the end counts as the end
	}
	end = from
	for end < int64(len(b)) {
		nl := bytes.IndexByte(b[end:], '\n')
		if nl < 0 {
			return entries, end, true, nil // the last line has no end
		}
		line := b[end : end+int64(nl)]
		var e Entry
		if jerr := json.Unmarshal(line, &e); jerr != nil || e.V == 0 {
			if end+int64(nl)+1 == int64(len(b)) {
				return entries, end, true, nil // the last line is not an entry
			}
			return entries, end, false, fmt.Errorf("%s: the line at byte %d is not an entry and is not the last one", fileJournal, end)
		}
		entries = append(entries, e)
		end += int64(nl) + 1
	}
	return entries, end, false, nil
}

// readJSON reads a JSON file into v; ok is false when the file does not exist.
func readJSON(path string, v any) (ok bool, err error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return false, fmt.Errorf("read %s: %w", path, err)
	}
	return true, nil
}

// writeJSON writes v as one line of JSON to a file of the run's folder, atomically (0600).
func writeJSON(dir, name string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return store.WriteFileAtomic(filepath.Join(dir, name), append(b, '\n'), 0o600)
}

// readHead reads state.json: the head of the last checkpoint. ok is false when there is none.
func readHead(dir string) (sf StateFile, ok bool, err error) {
	ok, err = readJSON(filepath.Join(dir, fileState), &sf)
	return sf, ok, err
}

// loaded is what loadRecord found besides the state.
type loaded struct {
	Size      int64 // the journal's size after the last whole entry: where the next one goes
	Replayed  int   // journal entries applied on top of the checkpoint
	Bytes     int64 // their size
	Torn      bool  // a torn last line was cut off
	NoHead    bool  // there was no state.json
	Leftovers bool  // collection files newer than state.json were found (a checkpoint was cut short)
	Short     bool  // the journal ends before the checkpoint's offset (its tail was lost): the checkpoint is the state
}

// loadRecord reads a started run's recorded state from its folder: the checkpoint files (a
// missing one is empty), then the journal's entries from the checkpoint's offset. A torn last
// line is dropped, in memory and in the file. The result is the state as of the last whole
// entry, whatever a crash interrupted.
func loadRecord(dir string) (*Loaded, loaded, error) {
	var info loaded
	sf, ok, err := readHead(dir)
	if err != nil {
		return nil, info, err
	}
	info.NoHead = !ok
	l := &Loaded{Version: sf.Version, State: sf.State, Stops: sf.Stops, Notes: sf.Notes}
	var tf TasksFile
	var uf TurnsFile
	var af AgentsFile
	for name, v := range map[string]any{fileTasks: &tf, fileTurns: &uf, fileAgents: &af} {
		if _, err := readJSON(filepath.Join(dir, name), v); err != nil {
			return nil, info, err
		}
	}
	l.Tasks, l.Turns, l.ChatOps, l.Agents = tf.Tasks, uf.Turns, uf.ChatOps, af.Agents
	info.Leftovers = tf.Version > sf.Version || uf.Version > sf.Version || af.Version > sf.Version

	entries, end, torn, err := readJournal(dir, sf.JournalOffset)
	if err != nil {
		return nil, info, err
	}
	info.Short = end < sf.JournalOffset
	for _, e := range entries {
		l.Apply(e.V, e.Patch)
	}
	if torn {
		if err := os.Truncate(filepath.Join(dir, fileJournal), end); err != nil {
			return nil, info, err
		}
	}
	info.Size, info.Replayed, info.Torn = end, len(entries), torn
	if info.Bytes = end - sf.JournalOffset; info.Bytes < 0 || len(entries) == 0 {
		info.Bytes = 0
	}
	return l, info, nil
}

// writeCheckpoint writes a checkpoint of l, whose last entry ends at byte offset of the journal:
// the collection files named (tasks, turns, agents: the ones that changed since the last
// checkpoint), then state.json. A crash before state.json leaves the old checkpoint in force.
func writeCheckpoint(dir string, l *Loaded, sum Summary, offset int64, tasks, turns, agents bool) error {
	if tasks {
		if err := writeJSON(dir, fileTasks, TasksFile{Version: l.Version, Tasks: orEmpty(l.Tasks)}); err != nil {
			return err
		}
	}
	if turns {
		if err := writeJSON(dir, fileTurns, TurnsFile{Version: l.Version, Turns: orEmpty(l.Turns), ChatOps: orEmpty(l.ChatOps)}); err != nil {
			return err
		}
	}
	if agents {
		if err := writeJSON(dir, fileAgents, AgentsFile{Version: l.Version, Agents: orEmpty(l.Agents)}); err != nil {
			return err
		}
	}
	return writeJSON(dir, fileState, StateFile{Version: l.Version, JournalOffset: offset, State: l.State,
		Stops: orEmpty(l.Stops), Notes: orEmpty(l.Notes), Summary: sum})
}
