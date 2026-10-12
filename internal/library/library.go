// Package library holds the prompt library of one server: the texts a user keeps to put into a
// message, in a tree of groups. It has the shapes a library has on the wire, the rules a library
// obeys and the file it is kept in. A server only stores its library and does four things with
// it: read, create, change, delete. It knows nothing of composers or of search.
//
// The instructions the app gives to agents are package prompts, a different thing.
package library

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The limits of one library. A server refuses what goes past them, and a library another server
// sends is held to them with Check before it is kept or shown.
const (
	MaxName  = 80      // characters of a name
	MaxText  = 100_000 // characters of a prompt's text
	MaxItems = 5_000   // groups and prompts together
	MaxBytes = 4 << 20 // bytes of all names and texts together (UTF-8)
	MaxDepth = 16      // groups inside one another, the top one counted
)

// Group is one group: a name, and the prompts and groups whose Parent it is.
type Group struct {
	ID     string `json:"id"`     // "g_" and 12 hex digits; made by the library's server, never changed
	Name   string `json:"name"`   // 1 to MaxName characters, no "/" and no line break; unique in its group, whatever the case
	Parent string `json:"parent"` // the id of the group it is in; "" = at the top of the library
}

// Prompt is one prompt: a name and the text that is inserted.
type Prompt struct {
	ID     string `json:"id"`     // "p_" and 12 hex digits; made by the library's server, never changed
	Name   string `json:"name"`   // as a group's; a prompt and a group of one group cannot share a name either
	Parent string `json:"parent"` // the id of the group it is in; "" = at the top of the library
	Text   string `json:"text"`   // plain text with line breaks, kept as it was sent; at most MaxText characters, may be empty
}

// Tree is the content of one library. The lists are flat and in the order the items were made:
// the tree is in the Parent fields, and its order on screen (groups before prompts, both by
// name) is the page's.
type Tree struct {
	Groups  []Group  `json:"groups"`
	Prompts []Prompt `json:"prompts"`
}

// View is one server's library as a page gets it: an element of GET /api/library and of the
// snapshot's "libraries", and the content of the "library" event. This computer's library is the
// first of every list, under the server id "local".
type View struct {
	Server    string `json:"server"`           // the server's id in the server list; "local" = this computer
	Name      string `json:"name"`             // the server's name, as the server list has it
	Connected bool   `json:"connected"`        // false: the copy last received from a server that dropped; it cannot be changed until the server is back
	Notice    string `json:"notice,omitempty"` // why the library's file was set aside at the start, or ""
	// Groups and Prompts are the Tree's, never null.
	Groups  []Group  `json:"groups"`
	Prompts []Prompt `json:"prompts"`
}

// The events of a library on a page's stream.
const (
	EventLibrary = "library"         // Event: the library of one server as it is now, whole
	EventRemoved = "library_removed" // Removed: a server is no longer in the server list
)

// Event is the "library" event. It is sent after every change of a library, and when Connected
// or Name changes. The page puts Library in the place of the one it has for that server, or
// adds it after the others.
type Event struct {
	Type    string `json:"type"` // EventLibrary
	Library View   `json:"library"`
}

// Removed is the "library_removed" event: the page drops the library of this server.
type Removed struct {
	Type   string `json:"type"`   // EventRemoved
	Server string `json:"server"` // the server's id
}

// EventOwn is the type of the Own event, on the stream of an API client.
const EventOwn = "own_library"

// Own is the "own_library" event: this server's library, whole, as its API clients get it after
// every change. It is the snapshot's "library" of an API client with a type. Nothing of the
// servers this one connects to is in it, and neither is the Notice, which names the data folder.
type Own struct {
	Type    string   `json:"type"` // EventOwn
	Groups  []Group  `json:"groups"`
	Prompts []Prompt `json:"prompts"`
}

// NewGroup is the body of POST /api/library/{server}/groups.
type NewGroup struct {
	Name   string `json:"name"`
	Parent string `json:"parent"` // the group it is made in; "" or left out = at the top
}

// NewPrompt is the body of POST /api/library/{server}/prompts.
type NewPrompt struct {
	Name   string `json:"name"`
	Parent string `json:"parent"` // the group it is made in; "" or left out = at the top
	Text   string `json:"text"`
}

// GroupChange is the body of PATCH /api/library/{server}/groups/{id}. A field that is left out
// keeps its value. Name renames; Parent moves, "" to the top.
type GroupChange struct {
	Name   *string `json:"name,omitempty"`
	Parent *string `json:"parent,omitempty"`
}

// PromptChange is the body of PATCH /api/library/{server}/prompts/{id}, as GroupChange with the
// text. All fields that are given are checked and saved together or not at all.
type PromptChange struct {
	Name   *string `json:"name,omitempty"`
	Parent *string `json:"parent,omitempty"`
	Text   *string `json:"text,omitempty"`
}

// The codes of a Refusal.
const (
	CodeBadName     = "bad_name"      // empty, longer than MaxName, with "/" or with a line break
	CodeNameTaken   = "name_taken"    // a group or a prompt of the same group has the name
	CodeNotFound    = "not_found"     // the group or prompt of the call is not there (deleted meanwhile)
	CodeNoGroup     = "no_group"      // the group to make it in or to move it to is not there
	CodeBadMove     = "bad_move"      // a group into itself or into a group below it
	CodeBadText     = "bad_text"      // not text
	CodeTextTooLong = "text_too_long" // past MaxText
	CodeFull        = "library_full"  // past MaxItems or MaxBytes
	CodeTooDeep     = "too_deep"      // past MaxDepth
)

// IsCode reports whether code is one of the codes of a Refusal.
func IsCode(code string) bool {
	switch code {
	case CodeBadName, CodeNameTaken, CodeNotFound, CodeNoGroup, CodeBadMove, CodeBadText, CodeTextTooLong, CodeFull, CodeTooDeep:
		return true
	}
	return false
}

// Refusal is what a call that breaks a rule of the library gets: Text is a sentence a popup
// shows as it is, Code tells the refusals apart. Every other error of this package is a failure
// of the file system.
type Refusal struct {
	Code string
	Text string
}

func (r *Refusal) Error() string { return r.Text }

func refuse(code, format string, a ...any) *Refusal {
	return &Refusal{Code: code, Text: fmt.Sprintf(format, a...)}
}

var (
	groupID  = regexp.MustCompile(`^g_[0-9a-f]{12}$`)
	promptID = regexp.MustCompile(`^p_[0-9a-f]{12}$`)
)

// checkName refuses a name that is not one: empty, too long, with "/", with a line break or
// another control character. The name is taken as it is; cleanName is applied first to a typed
// one.
func checkName(name string) *Refusal {
	if !utf8.ValidString(name) {
		return refuse(CodeBadName, "A name must be text.")
	}
	n := utf8.RuneCountInString(name)
	if n == 0 {
		return refuse(CodeBadName, "A name cannot be empty.")
	}
	if n > MaxName {
		return refuse(CodeBadName, "A name can have at most %d characters.", MaxName)
	}
	for _, r := range name {
		switch {
		case r == '/':
			return refuse(CodeBadName, `A name cannot contain "/".`)
		case r == '\n', r == '\r', r == '\v', r == '\f', r == '\u0085', r == ' ', r == ' ':
			return refuse(CodeBadName, "A name cannot contain a line break.")
		case unicode.IsControl(r):
			return refuse(CodeBadName, "A name cannot contain control characters.")
		}
	}
	return nil
}

// cleanName is a typed name without the spaces around it.
func cleanName(name string) string { return strings.TrimSpace(name) }

// checkText refuses a text that is not valid UTF-8 or longer than MaxText.
func checkText(text string) *Refusal {
	if !utf8.ValidString(text) {
		return refuse(CodeBadText, "The text of a prompt must be plain text.")
	}
	if utf8.RuneCountInString(text) > MaxText {
		return refuse(CodeTextTooLong, "The text of a prompt can have at most %s characters.", thousands(MaxText))
	}
	return nil
}

// checkSize refuses a library with too many items or too many bytes.
func checkSize(t Tree) *Refusal {
	if len(t.Groups)+len(t.Prompts) > MaxItems {
		return refuse(CodeFull, "The library is full: it can hold at most %s groups and prompts.", thousands(MaxItems))
	}
	if t.bytes() > MaxBytes {
		return refuse(CodeFull, "The library is full: its names and texts can take at most %d MB together.", MaxBytes>>20)
	}
	return nil
}

// thousands writes n with a comma between the thousands.
func thousands(n int) string {
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// foldKey is name in a form that is the same for two names that differ in case only (the
// simple case folding of Unicode, as strings.EqualFold compares).
func foldKey(name string) string {
	return strings.Map(func(r rune) rune {
		least := r
		for f := unicode.SimpleFold(r); f != r; f = unicode.SimpleFold(f) {
			least = min(least, f)
		}
		return least
	}, name)
}

func (t Tree) clone() Tree {
	return Tree{Groups: append([]Group{}, t.Groups...), Prompts: append([]Prompt{}, t.Prompts...)}
}

func (t Tree) bytes() int {
	n := 0
	for _, g := range t.Groups {
		n += len(g.Name)
	}
	for _, p := range t.Prompts {
		n += len(p.Name) + len(p.Text)
	}
	return n
}

// group is the index of the group with id, -1 for none.
func (t Tree) group(id string) int {
	for i := range t.Groups {
		if t.Groups[i].ID == id {
			return i
		}
	}
	return -1
}

// prompt is the index of the prompt with id, -1 for none.
func (t Tree) prompt(id string) int {
	for i := range t.Prompts {
		if t.Prompts[i].ID == id {
			return i
		}
	}
	return -1
}

// taken refuses name for the item self in the group parent ("" = the top) when another group or
// prompt there has it, whatever the case.
func (t Tree) taken(parent, name, self string) *Refusal {
	key := foldKey(name)
	where := "at the top of the library"
	if i := t.group(parent); i >= 0 {
		where = `in the group "` + t.Groups[i].Name + `"`
	}
	for _, g := range t.Groups {
		if g.Parent == parent && g.ID != self && foldKey(g.Name) == key {
			return refuse(CodeNameTaken, `There is already a group called "%s" %s.`, g.Name, where)
		}
	}
	for _, p := range t.Prompts {
		if p.Parent == parent && p.ID != self && foldKey(p.Name) == key {
			return refuse(CodeNameTaken, `There is already a prompt called "%s" %s.`, p.Name, where)
		}
	}
	return nil
}

// parents maps every group's id to its parent's.
func (t Tree) parents() map[string]string {
	up := make(map[string]string, len(t.Groups))
	for _, g := range t.Groups {
		up[g.ID] = g.Parent
	}
	return up
}

// depth is how many groups deep the group id is: 0 for "" (the top), 1 for a group at the top.
// It is -1 when the way up does not end at the top within MaxDepth steps (too deep, a circle or
// a parent that is not there).
func depth(up map[string]string, id string) int {
	d := 0
	for id != "" {
		parent, ok := up[id]
		if d++; !ok || d > MaxDepth {
			return -1
		}
		id = parent
	}
	return d
}

// height is how many levels of groups the group id and the groups below it have: 1 for a group
// with no group in it.
func (t Tree) height(id string) int {
	up := t.parents()
	h := 1
	for _, g := range t.Groups {
		// The levels from id down to g, when g is below id.
		n := 1
		for at := g.ID; at != id; n++ {
			parent, ok := up[at]
			if !ok || parent == "" || n > len(t.Groups) {
				n = 0
				break
			}
			at = parent
		}
		h = max(h, n)
	}
	return h
}

// within reports whether the group id is the group top or below it.
func within(up map[string]string, id, top string) bool {
	for n := 0; id != "" && n <= len(up); n++ {
		if id == top {
			return true
		}
		id = up[id]
	}
	return false
}

// IsGroupID reports whether id has the form of a group's id.
func IsGroupID(id string) bool { return groupID.MatchString(id) }

// IsPromptID reports whether id has the form of a prompt's id.
func IsPromptID(id string) bool { return promptID.MatchString(id) }

// CheckGroup reports what is wrong with one group that came from another server, or nil: its
// id, its name and the form of its parent's id. Its place in a library is Check's.
func CheckGroup(g Group) error {
	if !groupID.MatchString(g.ID) {
		return fmt.Errorf("bad id %q", short(g.ID))
	}
	if g.Parent != "" && !groupID.MatchString(g.Parent) {
		return fmt.Errorf("group %s: bad parent %q", g.ID, short(g.Parent))
	}
	if r := checkName(g.Name); r != nil || g.Name != cleanName(g.Name) {
		return fmt.Errorf("group %s: bad name", g.ID)
	}
	return nil
}

// CheckPrompt is CheckGroup for one prompt, with its text.
func CheckPrompt(p Prompt) error {
	if !promptID.MatchString(p.ID) {
		return fmt.Errorf("bad id %q", short(p.ID))
	}
	if p.Parent != "" && !groupID.MatchString(p.Parent) {
		return fmt.Errorf("prompt %s: bad parent %q", p.ID, short(p.Parent))
	}
	if r := checkName(p.Name); r != nil || p.Name != cleanName(p.Name) {
		return fmt.Errorf("prompt %s: bad name", p.ID)
	}
	if r := checkText(p.Text); r != nil {
		return fmt.Errorf("prompt %s: %s", p.ID, r.Code)
	}
	return nil
}

// short is s cut for an error's text: what another server sent has any length.
func short(s string) string {
	if len(s) > 40 {
		return strings.ToValidUTF8(s[:40], "") + "…"
	}
	return s
}

// Check reports what is wrong with a library that came from somewhere else (a file, another
// server), or nil: it has to pass every rule a library made by the calls of a Store obeys, the
// limits included. It changes nothing. The error says which item, in words for a log.
func Check(t Tree) error {
	if r := checkSize(t); r != nil {
		return r
	}
	ids := make(map[string]bool, len(t.Groups)+len(t.Prompts))
	names := make(map[string]bool, len(t.Groups)+len(t.Prompts)) // parent, NUL, the name's foldKey
	item := func(kind string, i int, id, name string, form *regexp.Regexp) error {
		if !form.MatchString(id) {
			return fmt.Errorf("%s %d: bad id %q", kind, i+1, short(id))
		}
		if ids[id] {
			return fmt.Errorf("%s %d: duplicate id %q", kind, i+1, id)
		}
		ids[id] = true
		if r := checkName(name); r != nil || name != cleanName(name) {
			return fmt.Errorf("%s %d (%s): bad name", kind, i+1, id)
		}
		return nil
	}
	for i, g := range t.Groups {
		if err := item("group", i, g.ID, g.Name, groupID); err != nil {
			return err
		}
	}
	up := t.parents()
	placed := func(kind string, i int, id, parent, name string) error {
		if _, ok := up[parent]; parent != "" && !ok {
			return fmt.Errorf("%s %d (%s): its group %q is not there", kind, i+1, id, short(parent))
		}
		key := parent + "\x00" + foldKey(name)
		if names[key] {
			return fmt.Errorf("%s %d (%s): its name is used twice in its group", kind, i+1, id)
		}
		names[key] = true
		return nil
	}
	for i, g := range t.Groups {
		if err := placed("group", i, g.ID, g.Parent, g.Name); err != nil {
			return err
		}
		if depth(up, g.ID) < 0 {
			return fmt.Errorf("group %d (%s): more than %d groups deep, or in a circle", i+1, g.ID, MaxDepth)
		}
	}
	for i, p := range t.Prompts {
		if err := item("prompt", i, p.ID, p.Name, promptID); err != nil {
			return err
		}
		if err := placed("prompt", i, p.ID, p.Parent, p.Name); err != nil {
			return err
		}
		if r := checkText(p.Text); r != nil {
			return fmt.Errorf("prompt %d (%s): %s", i+1, p.ID, r.Code)
		}
	}
	return nil
}
