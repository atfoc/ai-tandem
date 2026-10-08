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

	"ai-whiteboard/internal/store"
)

// boardFiles is the folder of the board records: one file per record,
// <data>/remote/boards/<id>.json, with the modes and the size limit of the chat records' files.
// The folder is made by the first write.
type boardFiles struct {
	dir   string
	write func(path string, b []byte) error // store.WriteFileAtomic with fileMode; a seam for tests
	made  sync.Once
}

func newBoardFiles(root string) *boardFiles {
	return &boardFiles{
		dir:   store.NewPaths(root).RemoteBoards,
		write: func(path string, b []byte) error { return store.WriteFileAtomic(path, b, fileMode) },
	}
}

func (f *boardFiles) path(id string) string { return filepath.Join(f.dir, id+".json") }

// save writes the record's file: to a temporary file beside it, which then takes its place. A
// record above maxRecord is not written (errTooLarge).
func (f *boardFiles) save(rec BoardRecord) error {
	if !validBoardID(rec.ID) {
		return fmt.Errorf("remotes: %q is no id of a board", rec.ID)
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
func (f *boardFiles) remove(id string) error {
	if !validBoardID(id) {
		return nil
	}
	if err := os.Remove(f.path(id)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// load reads every record of the folder. A file that cannot be read as the record its name says
// is skipped and logged, and stays where it is. What a write that was cut left is removed.
func (f *boardFiles) load(logf func(format string, args ...any)) []BoardRecord {
	entries, err := os.ReadDir(f.dir)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			logf("remotes: the folder of the remote boards cannot be read: %v", err)
		}
		return nil
	}
	var out []BoardRecord
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
			logf("remotes: the board record %s is skipped: %v", name, err)
			continue
		}
		out = append(out, rec)
	}
	return out
}

// read reads the file of the record id.
func (f *boardFiles) read(id string) (BoardRecord, error) {
	if !validBoardID(id) {
		return BoardRecord{}, errors.New("its name is no id of a board")
	}
	info, err := os.Stat(f.path(id))
	if err != nil {
		return BoardRecord{}, err
	}
	if info.Size() > maxRecord {
		return BoardRecord{}, errTooLarge
	}
	b, err := os.ReadFile(f.path(id))
	if err != nil {
		return BoardRecord{}, err
	}
	var rec BoardRecord
	if err := json.Unmarshal(b, &rec); err != nil {
		return BoardRecord{}, err
	}
	switch {
	case rec.ID != id:
		return BoardRecord{}, fmt.Errorf("it holds the record %q", rec.ID)
	case rec.Entry == "":
		return BoardRecord{}, errors.New("it names no server")
	}
	return rec, nil
}
