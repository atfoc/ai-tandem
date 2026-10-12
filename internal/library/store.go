package library

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"ai-whiteboard/internal/store"
)

// FileName is the library's file in the data folder.
const FileName = "prompt-library.json"

const fileVersion = 1 // of prompt-library.json; a file of a later one is not read

type libraryFile struct {
	Version int      `json:"version"`
	Groups  []Group  `json:"groups"`
	Prompts []Prompt `json:"prompts"`
}

// now is replaced by tests.
var now = time.Now

// Store holds this server's library: prompt-library.json in memory, written back after every
// change. Every call that changes it checks the rules of the library itself and answers a
// *Refusal for one that is broken; nothing changes then.
type Store struct {
	path   string
	notify func(Tree)

	// change is held by one changing call at a time, from its read of the tree until its event
	// was handed to notify: the events are in the order of the changes. mu alone guards the
	// fields below, and is never held while the file is written or notify runs.
	change sync.Mutex
	mu     sync.Mutex
	tree   Tree
	notice string
	stuck  error // the file could not be set aside: every write returns this
}

// Open reads <root>/prompt-library.json. A missing or empty file gives an empty library, and
// nothing is written. A file that cannot be read, or that breaks a rule of the library, is set
// aside (renamed beside itself, never deleted) and the library starts empty; Notice says so.
//
// notify is called after every change with the library as it is then, in the order of the
// changes; nil = nobody is told. It may read the store and must not change it.
func Open(root string, notify func(Tree)) (*Store, error) {
	if root == "" {
		return nil, errors.New("prompt library: no data folder")
	}
	s := &Store{path: filepath.Join(root, FileName), notify: notify}
	b, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return s, nil
	}
	if err == nil {
		if len(bytes.TrimSpace(b)) == 0 {
			return s, nil
		}
		if s.tree, err = parse(b); err == nil {
			return s, nil
		}
	}
	s.tree = Tree{}
	s.setAside(cause(err))
	return s, nil
}

// parse reads the file's bytes. Unknown fields are ignored; a version after this build's and a
// library that does not pass Check are errors.
func parse(b []byte) (Tree, error) {
	var f libraryFile
	if err := json.Unmarshal(b, &f); err != nil {
		return Tree{}, err
	}
	if f.Version > fileVersion {
		return Tree{}, fmt.Errorf("version %d is after this build's %d", f.Version, fileVersion)
	}
	t := Tree{Groups: f.Groups, Prompts: f.Prompts}
	if err := Check(t); err != nil {
		return Tree{}, err
	}
	return t, nil
}

// setAside renames the unreadable file to prompt-library.json.unreadable-<UTC time>, logs one
// line and keeps it as the notice. When the rename fails the library works in memory and no
// write goes through.
func (s *Store) setAside(why error) {
	name, err := s.rename()
	if err != nil {
		s.stuck = fmt.Errorf("prompt library: %s cannot be read and could not be set aside: %w", s.path, cause(err))
		s.notice = fmt.Sprintf("prompt library: %s cannot be read (%v); it could not be set aside (%v); starting with an empty library", s.path, why, cause(err))
	} else {
		s.notice = fmt.Sprintf("prompt library: %s cannot be read (%v); set aside as %s; starting with an empty library", s.path, why, name)
	}
	log.Print(s.notice)
}

// rename moves the file to the first free set-aside name and returns that name (no folder).
func (s *Store) rename() (string, error) {
	base := FileName + ".unreadable-" + now().UTC().Format("20060102T150405Z")
	for n := 1; ; n++ {
		name := base
		if n > 1 {
			name += "-" + strconv.Itoa(n)
		}
		to := filepath.Join(filepath.Dir(s.path), name)
		if _, err := os.Lstat(to); err == nil {
			continue
		} else if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		return name, os.Rename(s.path, to)
	}
}

// Notice is "" or the sentence about the file that was set aside at Open.
func (s *Store) Notice() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.notice
}

// Tree returns a copy of the library. Its lists are never nil.
func (s *Store) Tree() Tree {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tree.clone()
}

// CreateGroup makes a group called name in the group parent ("" = at the top).
func (s *Store) CreateGroup(name, parent string) (Group, error) {
	var made Group
	err := s.edit(func(t *Tree) (bool, error) {
		name := cleanName(name)
		if r := t.place(parent, name, ""); r != nil {
			return false, r
		}
		if d := depth(t.parents(), parent); d < 0 || d+1 > MaxDepth {
			return false, tooDeep()
		}
		id, err := newID("g_", func(id string) bool { return t.group(id) >= 0 })
		if err != nil {
			return false, err
		}
		made = Group{ID: id, Name: name, Parent: parent}
		t.Groups = append(t.Groups, made)
		return true, nil
	})
	return made, err
}

// CreatePrompt makes a prompt called name, with text, in the group parent ("" = at the top).
func (s *Store) CreatePrompt(name, parent, text string) (Prompt, error) {
	var made Prompt
	err := s.edit(func(t *Tree) (bool, error) {
		name := cleanName(name)
		if r := t.place(parent, name, ""); r != nil {
			return false, r
		}
		if r := checkText(text); r != nil {
			return false, r
		}
		id, err := newID("p_", func(id string) bool { return t.prompt(id) >= 0 })
		if err != nil {
			return false, err
		}
		made = Prompt{ID: id, Name: name, Parent: parent, Text: text}
		t.Prompts = append(t.Prompts, made)
		return true, nil
	})
	return made, err
}

// ChangeGroup renames the group id, moves it, or both; what c leaves out stays. A group is not
// moved into itself or into a group below it.
func (s *Store) ChangeGroup(id string, c GroupChange) (Group, error) {
	var out Group
	err := s.edit(func(t *Tree) (bool, error) {
		i := t.group(id)
		if i < 0 {
			return false, refuse(CodeNotFound, "This group no longer exists.")
		}
		g := t.Groups[i]
		if c.Name != nil {
			g.Name = cleanName(*c.Name)
		}
		if c.Parent != nil {
			g.Parent = *c.Parent
		}
		if out = g; g == t.Groups[i] {
			return false, nil
		}
		if g.Parent == id {
			return false, refuse(CodeBadMove, "A group cannot be moved into itself.")
		}
		up := t.parents()
		if _, ok := up[g.Parent]; ok && within(up, g.Parent, id) {
			return false, refuse(CodeBadMove, "A group cannot be moved into a group below it.")
		}
		if r := t.place(g.Parent, g.Name, id); r != nil {
			return false, r
		}
		if d := depth(up, g.Parent); d < 0 || d+t.height(id) > MaxDepth {
			return false, tooDeep()
		}
		t.Groups[i] = g
		return true, nil
	})
	return out, err
}

// ChangePrompt renames the prompt id, moves it, changes its text, or all of it; what c leaves
// out stays. The later of two changes wins: nothing is merged.
func (s *Store) ChangePrompt(id string, c PromptChange) (Prompt, error) {
	var out Prompt
	err := s.edit(func(t *Tree) (bool, error) {
		i := t.prompt(id)
		if i < 0 {
			return false, refuse(CodeNotFound, "This prompt no longer exists.")
		}
		p := t.Prompts[i]
		if c.Name != nil {
			p.Name = cleanName(*c.Name)
		}
		if c.Parent != nil {
			p.Parent = *c.Parent
		}
		if c.Text != nil {
			p.Text = *c.Text
		}
		if out = p; p == t.Prompts[i] {
			return false, nil
		}
		if r := t.place(p.Parent, p.Name, id); r != nil {
			return false, r
		}
		if r := checkText(p.Text); r != nil {
			return false, r
		}
		t.Prompts[i] = p
		return true, nil
	})
	return out, err
}

// DeleteGroup deletes the group id with every group and prompt in it, at any depth.
func (s *Store) DeleteGroup(id string) error {
	return s.edit(func(t *Tree) (bool, error) {
		if t.group(id) < 0 {
			return false, refuse(CodeNotFound, "This group no longer exists.")
		}
		up := t.parents()
		groups, prompts := []Group{}, []Prompt{}
		for _, g := range t.Groups {
			if !within(up, g.ID, id) {
				groups = append(groups, g)
			}
		}
		for _, p := range t.Prompts {
			if !within(up, p.Parent, id) {
				prompts = append(prompts, p)
			}
		}
		t.Groups, t.Prompts = groups, prompts
		return true, nil
	})
}

// DeletePrompt deletes the prompt id.
func (s *Store) DeletePrompt(id string) error {
	return s.edit(func(t *Tree) (bool, error) {
		i := t.prompt(id)
		if i < 0 {
			return false, refuse(CodeNotFound, "This prompt no longer exists.")
		}
		t.Prompts = append(t.Prompts[:i], t.Prompts[i+1:]...)
		return true, nil
	})
}

// place refuses the name and the group of an item that is made in, renamed in or moved to the
// group parent: a bad name, a group that is not there, a name that is taken there.
func (t Tree) place(parent, name, self string) *Refusal {
	if r := checkName(name); r != nil {
		return r
	}
	if parent != "" && t.group(parent) < 0 {
		return refuse(CodeNoGroup, "The group it should be in no longer exists.")
	}
	return t.taken(parent, name, self)
}

func tooDeep() *Refusal {
	return refuse(CodeTooDeep, "Groups can be at most %d deep.", MaxDepth)
}

// edit runs f on a copy of the library. When f reports a change, the copy is held to the
// library's size, written to the file and only then made the library, and notify is told. When
// f or the write fails, nothing changes.
func (s *Store) edit(f func(t *Tree) (changed bool, err error)) error {
	s.change.Lock()
	defer s.change.Unlock()
	next := s.Tree()
	changed, err := f(&next)
	if err != nil || !changed {
		return err
	}
	if r := checkSize(next); r != nil {
		return r
	}
	if err := s.write(next); err != nil {
		return err
	}
	s.mu.Lock()
	s.tree = next
	s.mu.Unlock()
	if s.notify != nil {
		s.notify(next.clone())
	}
	return nil
}

// write saves t (mode 0600, atomically).
func (s *Store) write(t Tree) error {
	if s.stuck != nil {
		return s.stuck
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	return store.WriteJSONAtomic(s.path, libraryFile{Version: fileVersion, Groups: t.Groups, Prompts: t.Prompts}, 0o600)
}

// newID makes an id that taken does not know: prefix and 12 hex digits.
func newID(prefix string, taken func(string) bool) (string, error) {
	for {
		b := make([]byte, 6)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		if id := prefix + hex.EncodeToString(b); !taken(id) {
			return id, nil
		}
	}
}

// cause is err without the path an *fs.PathError carries: the notice names the path itself.
func cause(err error) error {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}
