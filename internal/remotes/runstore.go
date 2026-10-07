package remotes

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/store"
)

// runFiles is the folder of the run records: one file per record, <data>/remote/runs/<id>.json,
// with the modes and the size limit of the chat records' files. The folder is made by the
// first write.
type runFiles struct {
	dir   string
	write func(path string, b []byte) error // store.WriteFileAtomic with fileMode; a seam for tests
	made  sync.Once
}

func newRunFiles(root string) *runFiles {
	return &runFiles{
		dir:   store.NewPaths(root).RemoteRuns,
		write: func(path string, b []byte) error { return store.WriteFileAtomic(path, b, fileMode) },
	}
}

func (f *runFiles) path(id string) string { return filepath.Join(f.dir, id+".json") }

// save writes the record's file: to a temporary file beside it, which then takes its place. A
// record above maxRecord is not written (errTooLarge).
func (f *runFiles) save(rec RunRecord) error {
	if !runs.ValidID(rec.ID) {
		return fmt.Errorf("remotes: %q is no id of a run", rec.ID)
	}
	b, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	if len(b)+1 > maxRecord {
		return errTooLarge // the file that is there stays: a load would skip this one
	}
	if err := os.MkdirAll(f.dir, dirMode); err != nil {
		return err
	}
	f.made.Do(func() { _ = os.Chmod(f.dir, dirMode) }) // a folder that was there with another mode
	return f.write(f.path(rec.ID), append(b, '\n'))
}

// remove deletes the record's file. A file that is not there is no error.
func (f *runFiles) remove(id string) error {
	if !runs.ValidID(id) {
		return nil
	}
	if err := os.Remove(f.path(id)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// load reads every record of the folder. A file that cannot be read as the record its name says
// is skipped and logged, and stays where it is. What a write that was cut left is removed.
func (f *runFiles) load(logf func(format string, args ...any)) []RunRecord {
	entries, err := os.ReadDir(f.dir)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			logf("remotes: the folder of the remote runs cannot be read: %v", err)
		}
		return nil
	}
	var out []RunRecord
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".tmp") {
			_ = os.Remove(filepath.Join(f.dir, name))
			continue
		}
		id, ok := strings.CutSuffix(name, ".json")
		if !ok || !e.Type().IsRegular() {
			continue
		}
		rec, err := f.read(id)
		if err != nil {
			logf("remotes: the run record %s is skipped: %v", name, err)
			continue
		}
		out = append(out, rec)
	}
	return out
}

// read reads the file of the record id.
func (f *runFiles) read(id string) (RunRecord, error) {
	if !runs.ValidID(id) {
		return RunRecord{}, errors.New("its name is no id of a run")
	}
	info, err := os.Stat(f.path(id))
	if err != nil {
		return RunRecord{}, err
	}
	if info.Size() > maxRecord {
		return RunRecord{}, errTooLarge
	}
	b, err := os.ReadFile(f.path(id))
	if err != nil {
		return RunRecord{}, err
	}
	var rec RunRecord
	if err := json.Unmarshal(b, &rec); err != nil {
		return RunRecord{}, err
	}
	switch {
	case rec.ID != id:
		return RunRecord{}, fmt.Errorf("it holds the record %q", rec.ID)
	case rec.Entry == "":
		return RunRecord{}, errors.New("it names no server")
	}
	rec.Agents = cleanAgents(rec.Agents)
	return rec, nil
}
