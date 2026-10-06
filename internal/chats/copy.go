// Copying the start of a thread: what a new branch or a fork begins with.
package chats

import (
	"errors"
	"os"
	"path/filepath"
	"sort"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/transcript"
)

// copyPrefix writes the first count items of src's thread, and the subagent folders they refer
// to (nested ones included, without pi/), into the folder of the chat or branch dstID.
// src.mu held; src's transcript loaded. It creates no chat.json.
//
// The items come from the live list, so the copy has what src's items.jsonl may lack, one line
// per item under its own index; mid-run items are copied as they are. A subagent's files are
// copied whole after a flush: the copy shows its latest state, not its state at item count. When
// the copy fails, what it created is removed again.
func (m *Manager) copyPrefix(src *Chat, dstID string, count int) (err error) {
	_, items := src.tr.Snapshot()
	if count < 0 || count > len(items) {
		return ErrBadPoint
	}
	var made []string // what this call creates: the whole folder, when it is new
	making := func(path string) {
		if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
			made = append(made, path)
		}
	}
	defer func() {
		if err != nil {
			for _, p := range made {
				os.RemoveAll(p)
			}
		}
	}()

	dst := m.chatDir(dstID)
	making(dst)
	if err := os.MkdirAll(dst, 0o700); err != nil {
		return err
	}
	making(m.itemsPath(dstID))
	if err := transcript.WriteItems(m.itemsPath(dstID), items[:count]); err != nil {
		return err
	}

	for _, sid := range prefixSubs(src, items[:count]) {
		if s := src.subs[sid]; s != nil {
			m.flushSub(src, s, true) // a running one's open items are in memory only
		}
		from, to := m.subDir(src.meta.ID, sid), m.subDir(dstID, sid)
		meta, err := os.ReadFile(filepath.Join(from, "subagent.json"))
		if errors.Is(err, os.ErrNotExist) {
			continue // no folder: the client draws such a row from the tool item alone
		}
		if err != nil {
			return err
		}
		making(filepath.Dir(to))
		making(to)
		if err := os.MkdirAll(to, 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(to, "subagent.json"), meta, 0o600); err != nil {
			return err
		}
		thread, err := os.ReadFile(filepath.Join(from, "items.jsonl"))
		if errors.Is(err, os.ErrNotExist) {
			continue // a subagent that has written no item yet
		}
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(to, "items.jsonl"), thread, 0o600); err != nil {
			return err
		}
	}
	return nil
}

// prefixSubs lists, sorted, the sids the items refer to (the subagent a tool item started, the
// one that asked a permission, the one whose result a row carried) and every subagent of c whose
// Parent chain reaches one of them: a nested subagent's tool item is in the outer one's thread,
// not in items. c.mu held.
func prefixSubs(c *Chat, items []model.Item) []string {
	want := map[string]bool{}
	for _, it := range items {
		// A sid is a folder name; anything else has no folder to copy.
		if (it.Kind == "tool" || it.Kind == "perm" || it.Kind == "subresult") && it.Subagent != "" &&
			it.Subagent != "." && it.Subagent != ".." && filepath.Base(it.Subagent) == it.Subagent {
			want[it.Subagent] = true
		}
	}
	for grew := true; grew; {
		grew = false
		for sid, s := range c.subs {
			if !want[sid] && want[s.meta.Parent] {
				want[sid], grew = true, true
			}
		}
	}
	sids := make([]string, 0, len(want))
	for sid := range want {
		sids = append(sids, sid)
	}
	sort.Strings(sids)
	return sids
}
