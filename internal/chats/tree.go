package chats

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/transcript"
)

// The tree record: chats/<chat id>/tree.json holds where each branch split off, the labels and
// the current branch. Each branch's whole path is in its own items.jsonl, so nothing else of the
// tree is stored. No file = one branch, no labels. A file that cannot be read is never written
// over: the chat shows as one branch until the file is fixed.

var (
	ErrNoBranch = errors.New("no such branch")
	ErrBadLabel = errors.New("only a message or a reply can be labeled")
	// ErrLongLabel is an ErrBadLabel with its own text.
	ErrLongLabel error = badLabel(fmt.Sprintf("a label can't be longer than %d characters", maxLabel))

	errTreeUnreadable = errors.New("the chat's tree record can't be read")
	// errTreeSame is what an updateTree function returns when it changed nothing, so that nothing
	// is written.
	errTreeSame = errors.New("tree record unchanged")
)

// maxLabel is the most characters a label has.
const maxLabel = 200

// badLabel is an ErrBadLabel that says what is wrong with the label's text.
type badLabel string

func (e badLabel) Error() string      { return string(e) }
func (badLabel) Is(target error) bool { return target == ErrBadLabel }

func (m *Manager) treePath(chat string) string {
	return filepath.Join(m.chatDir(chat), "tree.json")
}

// readTree reads the tree record of the top-level chat. No file is the zero Tree and no error; a
// file that cannot be read or parsed is errTreeUnreadable.
func (m *Manager) readTree(chat string) (model.Tree, error) {
	raw, err := os.ReadFile(m.treePath(chat))
	if errors.Is(err, fs.ErrNotExist) {
		return model.Tree{}, nil
	}
	var t model.Tree
	if err == nil {
		err = json.Unmarshal(raw, &t)
	}
	if err != nil {
		return model.Tree{}, fmt.Errorf("%w: %w", errTreeUnreadable, err)
	}
	return t, nil
}

// updateTree reads the tree record of the top-level chat, applies f and writes the result. Calls
// for one chat run one after the other. When f returns an error, or the file exists but cannot be
// read, nothing is written and the error is returned. The caller must not hold the chat's mu (the
// tree lock is taken first); f runs with only the tree lock held.
func (m *Manager) updateTree(chat string, f func(*model.Tree) error) error {
	c, err := m.get(chat)
	if err != nil {
		return err
	}
	c.treeMu.Lock()
	defer c.treeMu.Unlock()
	t, err := m.readTree(chat)
	if err != nil {
		return err
	}
	if err := f(&t); err != nil {
		return err
	}
	if t.Branches == nil {
		t.Branches = []model.TreeBranch{} // "branches": [] in the file, never null
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.deleted {
		return ErrNotFound
	}
	return store.WriteJSONAtomic(m.treePath(chat), t, 0o600)
}

// branchChatID is the server id of a branch's chat object: the chat itself for "main", else
// <chat id>/branches/<branch id>. It is also the branch's folder under chats/.
func branchChatID(chat, branch string) string {
	if branch == model.MainBranch {
		return chat
	}
	return chat + "/branches/" + branch
}

// branchOf finds a branch in the record. "main" is always there, as {ID: "main"}.
func branchOf(t model.Tree, id string) (model.TreeBranch, bool) {
	if id == model.MainBranch {
		return model.TreeBranch{ID: model.MainBranch}, true
	}
	for _, b := range t.Branches {
		if b.ID == id {
			return b, true
		}
	}
	return model.TreeBranch{}, false
}

// ownerOf is the branch whose own part (split to end) holds the item at index item, seen from
// branch: branch itself when the index is at or past its split, else the owner seen from the
// branch it split from. main owns everything it is asked for, and stands in for a branch the
// record does not know.
func ownerOf(t model.Tree, branch string, item int) string {
	for range len(t.Branches) + 1 { // a record whose branches form a loop ends here
		b, ok := branchOf(t, branch)
		if !ok || b.ID == model.MainBranch {
			break
		}
		if item >= b.At {
			return b.ID
		}
		branch = b.From
	}
	return model.MainBranch
}

// labelsOnPath returns the labels visible on branch's items 0..count-1, each re-keyed to branch
// "main" with its index unchanged, sorted by index: what a fork of that prefix starts with. nil =
// none.
func labelsOnPath(t model.Tree, branch string, count int) []model.TreeLabel {
	var out []model.TreeLabel
	for _, l := range t.Labels {
		if l.Item >= 0 && l.Item < count && ownerOf(t, branch, l.Item) == l.Branch {
			out = append(out, model.TreeLabel{Branch: model.MainBranch, Item: l.Item, Text: l.Text})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Item < out[j].Item })
	return out
}

// sortLabels orders the record's labels by branch (main first, then creation order), then item.
func sortLabels(t *model.Tree) {
	order := func(id string) int {
		if id == model.MainBranch {
			return -1
		}
		for i, b := range t.Branches {
			if b.ID == id {
				return i
			}
		}
		return len(t.Branches)
	}
	sort.SliceStable(t.Labels, func(i, j int) bool {
		a, b := t.Labels[i], t.Labels[j]
		if oa, ob := order(a.Branch), order(b.Branch); oa != ob {
			return oa < ob
		}
		return a.Item < b.Item
	})
}

// labelable reports whether it can carry a label: a user message or a reply.
func labelable(it model.Item) bool {
	return it.Kind == "user" || it.Kind == "text"
}

// treeChat returns the agent of the top-level chat id, or ErrNotFound: also for a deleted chat
// and for a branch's server id, which never names a tree.
func (m *Manager) treeChat(id string) (model.AgentKind, error) {
	if strings.Contains(id, "/") {
		return "", ErrNotFound
	}
	c, err := m.lock(id)
	if err != nil {
		return "", err
	}
	defer c.mu.Unlock()
	return c.meta.Agent, nil
}

// branchItems returns a branch's whole item list without loading anything into the manager (a
// chat's first load has side effects, see trOf and loadSubs): the live list when the branch's
// transcript is already loaded, as it is ahead of the file (a reply is done before the pump has
// flushed it), else items.jsonl read directly. A branch other than main must have its folder.
// running is whether the branch's agent is working (see busy): never for a branch not loaded.
// The tree lock must not be held.
func (m *Manager) branchItems(chat, branch string) (items []model.Item, running bool, err error) {
	id := branchChatID(chat, branch)
	if c, err := m.get(id); err == nil {
		c.mu.Lock()
		if c.tr != nil {
			_, items := c.tr.Snapshot()
			running := busy(c)
			c.mu.Unlock()
			return items, running, nil
		}
		c.mu.Unlock()
	}
	if branch != model.MainBranch {
		if _, err := os.Stat(m.chatDir(id)); err != nil {
			return nil, false, err
		}
	}
	tr, err := transcript.Load(m.itemsPath(id))
	if err != nil {
		return nil, false, err
	}
	_, items = tr.Snapshot()
	return items, false, nil
}

// treeText is what the tree shows of an item: its text, or, for a message that is only quotes,
// its first quote after a quote mark: the comment, else the quoted words.
func treeText(it model.Item) string {
	if strings.TrimSpace(it.Text) != "" || len(it.References) == 0 {
		return it.Text
	}
	r := it.References[0]
	if c := strings.TrimSpace(r.Comment); c != "" {
		return "❝ " + c
	}
	return "❝ " + r.Quote
}

// treeItems is a branch's own part (index >= at) as the tree shows it: the user and text items,
// with the point rules applied to the branch's whole list. running is whether the branch's agent
// is working.
func treeItems(a model.AgentKind, items []model.Item, at int, running bool) []model.TreeItem {
	out := []model.TreeItem{}
	for i := max(at, 0); i < len(items); i++ {
		it := items[i]
		ti := model.TreeItem{I: i, Kind: it.Kind, Text: treeText(it)}
		switch it.Kind {
		case "user":
			if count, ok := cutBefore(items, i); ok {
				ti.Before = &count
				ti.OK = pointOK(a, items, count, running)
			}
		case "text":
			ti.Done = it.Done
			if ti.End = turnEnd(items, i); ti.End > 0 {
				ti.OK = pointOK(a, items, ti.End, running)
			}
		default:
			continue
		}
		out = append(out, ti)
	}
	return out
}

// branchView is the own part of the branch b of the tree record as the tree shows it, items being
// the branch's whole list: what Tree answers of it and what a tree event carries.
func branchView(a model.AgentKind, b model.TreeBranch, items []model.Item, running bool) model.TreeBranchView {
	return model.TreeBranchView{ID: b.ID, From: b.From, At: b.At, Len: len(items),
		Items: treeItems(a, items, b.At, running)}
}

// Tree is the whole tree of the top-level chat id: main, then the recorded branches whose folder
// can be read, each with the messages and replies of its own part, and the labels. Nothing is
// loaded into the manager and no event is sent. An unreadable record gives one branch.
func (m *Manager) Tree(id string) (model.TreeView, error) {
	a, err := m.treeChat(id)
	if err != nil {
		return model.TreeView{}, err
	}
	t, err := m.readTree(id)
	if err != nil {
		log.Printf("chats: tree %s: %v", id, err)
		t = model.Tree{}
	}
	main, running, err := m.branchItems(id, model.MainBranch)
	if err != nil {
		return model.TreeView{}, err
	}
	tv := model.TreeView{Current: model.MainBranch, Labels: []model.TreeLabel{}}
	tv.Branches = append(tv.Branches, branchView(a, model.TreeBranch{ID: model.MainBranch}, main, running))
	lists := map[string][]model.Item{model.MainBranch: main} // the branches in the view
	for _, b := range t.Branches {
		if _, dup := lists[b.ID]; dup || b.ID == "" || b.At < 0 {
			continue
		}
		if _, known := lists[b.From]; !known {
			continue
		}
		items, running, err := m.branchItems(id, b.ID)
		if err != nil {
			log.Printf("chats: tree %s: branch %s left out: %v", id, b.ID, err)
			continue
		}
		lists[b.ID] = items
		tv.Branches = append(tv.Branches, branchView(a, b, items, running))
	}
	if _, ok := lists[t.Current]; ok {
		tv.Current = t.Current
	}
	for _, l := range t.Labels {
		items, ok := lists[l.Branch]
		if ok && l.Item >= 0 && l.Item < len(items) && labelable(items[l.Item]) {
			tv.Labels = append(tv.Labels, l)
		}
	}
	return tv, nil
}

// The tree event keeps the tree a client holds (the answer of Tree) right without another read of
// it. It is {type:"tree", chat: <the top-level id>} with one or more parts, each replacing that
// part of the client's tree:
//
//	branch   one branch's own part, as Tree gives it now; a branch the client lacks is added
//	labels   all labels of the record, as SetLabel answers them (never null)
//	current  the id of the current branch
//
// A whole tree is never sent: it would read the items of every branch that is not loaded, at
// every turn boundary. A branch's part is sent when its agent starts or stops working, when its
// items change while it is not working, and when it is listed; not for the items of a running
// turn, which the turn's end sends, and never for a branch whose transcript is not loaded. A fork
// is told by the chat events alone.

// emitTree sends a tree event of the top-level chat top, whose id is chat, with the parts asked
// for: the part of the chat object branch (nil = none), the labels, the current branch. Each is
// read inside top.treeOutMu, which is held to the broadcast: the tree events of a chat reach
// clients in the order their parts were read. With ifDirty the branch's part is left out when no
// change waits for it (Chat.treeDirty), an earlier event having told it. An event with no part
// is not sent, and none once the chat was deleted (see cast).
//
// An unreadable record still gives main's part and the current branch, as Tree does; no other
// branch's part and no labels. No chat's mu may be held, and no treeMu, sendMu nor Manager.mu.
func (m *Manager) emitTree(chat string, top, branch *Chat, labels, current, ifDirty bool) {
	top.treeOutMu.Lock()
	defer top.treeOutMu.Unlock()
	// The flag is cleared before the part is read, both in here: a change that comes after the
	// read finds it cleared and its own event sends the part again.
	part := branch != nil && (branch.treeDirty.Swap(false) || !ifDirty)
	var t model.Tree
	var terr error
	if labels || (part && branch != top) { // main's part needs nothing of the record
		if t, terr = m.readTree(chat); terr != nil {
			log.Printf("chats: tree %s: %v", chat, terr)
		}
	}
	ev := map[string]any{"type": "tree", "chat": chat}
	if part && (terr == nil || branch == top) {
		if v, ok := treePart(t, branch); ok {
			ev["branch"] = v
		}
	}
	if labels && terr == nil {
		ev["labels"] = append([]model.TreeLabel{}, t.Labels...)
	}
	if current {
		ev["current"] = model.MainBranch
		if cur := m.current(top); cur != top {
			ev["current"] = cur.branch
		}
	}
	if len(ev) > 2 {
		m.cast(top, chat, ev)
	}
}

// treePart is the own part of the chat object c's branch as Tree gives it now, t being the tree
// record of its chat. ok is false when there is none to send: the branch is deleted, not listed
// or not in the record, or its transcript is not loaded (the part would be the file's, which a
// client has from Tree). No chat's mu may be held.
func treePart(t model.Tree, c *Chat) (v model.TreeBranchView, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.deleted || c.unlisted || c.tr == nil {
		return v, false
	}
	_, id := splitID(c.meta.ID)
	b, ok := branchOf(t, id)
	if !ok {
		return v, false
	}
	_, items := c.tr.Snapshot()
	return branchView(c.meta.Agent, b, items, busy(c)), true
}

// SetLabel names the user message or reply at index item of branch; blank text removes the name.
// The name is kept as one clean line: every control character (a newline, a tab, NUL, ESC)
// becomes a space and the spaces around the name go. A name longer than maxLabel characters is
// refused with ErrLongLabel and changes nothing.
// The label is kept under the branch that owns the item, so every branch passing through it
// shows it. It is allowed while the chat is busy, archived or legacy. The answer is all the
// chat's labels after the change (never nil); when the record changed they are sent to every
// client as well, in a tree event (see emitTree).
func (m *Manager) SetLabel(id, branch string, item int, text string) ([]model.TreeLabel, error) {
	if err := m.person(id); err != nil {
		return nil, err
	}
	if _, err := m.treeChat(id); err != nil {
		return nil, err
	}
	top, err := m.topChat(id)
	if err != nil {
		return nil, err
	}
	t, err := m.readTree(id)
	if err != nil {
		return nil, err
	}
	if _, ok := branchOf(t, branch); !ok {
		return nil, ErrNoBranch
	}
	items, _, err := m.branchItems(id, branch)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNoBranch // recorded, but its folder is gone: Tree leaves it out too
	}
	if err != nil {
		return nil, err
	}
	if item < 0 || item >= len(items) || !labelable(items[item]) {
		return nil, ErrBadLabel
	}
	text = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, text))
	if utf8.RuneCountInString(text) > maxLabel {
		return nil, ErrLongLabel
	}
	labels := []model.TreeLabel{}
	err = m.updateTree(id, func(t *model.Tree) error {
		if _, ok := branchOf(*t, branch); !ok {
			return ErrNoBranch
		}
		owner := ownerOf(*t, branch, item)
		same := text == ""
		kept := t.Labels[:0:0]
		for _, l := range t.Labels {
			if l.Branch != owner || l.Item != item {
				kept = append(kept, l)
				continue
			}
			same = l.Text == text
		}
		if text != "" {
			kept = append(kept, model.TreeLabel{Branch: owner, Item: item, Text: text})
		}
		t.Labels = kept
		sortLabels(t)
		labels = append(labels, t.Labels...)
		if same {
			return errTreeSame
		}
		return nil
	})
	if errors.Is(err, errTreeSame) {
		return labels, nil
	}
	if err != nil {
		return nil, err
	}
	m.emitTree(id, top, nil, true, false, false)
	return labels, nil
}
