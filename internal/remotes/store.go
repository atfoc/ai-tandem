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

// The modes of the records' folder and of a record's file.
const (
	dirMode  = 0o700
	fileMode = 0o600
)

// maxRecord is the size above which a file is not read as a record, and so not written as one.
const maxRecord = 8 << 20

// errTooLarge is save's error for a record whose file would be above maxRecord.
var errTooLarge = errors.New("it is too large for a record")

// files is the folder of the records: one file per record, <data>/remote/chats/<id>.json. The
// folder is made by the first write.
type files struct {
	dir   string
	write func(path string, b []byte) error // store.WriteFileAtomic with fileMode; a seam for tests
	made  sync.Once
}

func newFiles(root string) *files {
	return &files{
		dir:   store.NewPaths(root).RemoteChats,
		write: func(path string, b []byte) error { return store.WriteFileAtomic(path, b, fileMode) },
	}
}

func (f *files) path(id string) string { return filepath.Join(f.dir, id+".json") }

// save writes the record's file: to a temporary file beside it, which then takes its place. A
// record above maxRecord is not written (errTooLarge).
func (f *files) save(rec Record) error {
	if !validID(rec.ID) {
		return fmt.Errorf("remotes: %q is no id of a record", rec.ID)
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
func (f *files) remove(id string) error {
	if !validID(id) {
		return nil
	}
	if err := os.Remove(f.path(id)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// load reads every record of the folder. A file that cannot be read as the record its name says
// is skipped and logged, and stays where it is. What a write that was cut left is removed.
func (f *files) load(logf func(format string, args ...any)) []Record {
	entries, err := os.ReadDir(f.dir)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			logf("remotes: the folder of the remote chats cannot be read: %v", err)
		}
		return nil
	}
	var out []Record
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
			logf("remotes: %s is skipped: %v", name, err)
			continue
		}
		out = append(out, rec)
	}
	return out
}

// read reads the file of the record id.
func (f *files) read(id string) (Record, error) {
	if !validID(id) {
		return Record{}, errors.New("its name is no id of a record")
	}
	info, err := os.Stat(f.path(id))
	if err != nil {
		return Record{}, err
	}
	if info.Size() > maxRecord {
		return Record{}, errTooLarge
	}
	b, err := os.ReadFile(f.path(id))
	if err != nil {
		return Record{}, err
	}
	var rec Record
	if err := json.Unmarshal(b, &rec); err != nil {
		return Record{}, err
	}
	switch {
	case rec.ID != id:
		return Record{}, fmt.Errorf("it holds the record %q", rec.ID)
	case rec.Entry == "":
		return Record{}, errors.New("it names no server")
	}
	return rec, nil
}
