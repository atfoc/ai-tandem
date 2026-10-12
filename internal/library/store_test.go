package library

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// The rules of a library (section 3 of the goal) at the store, which every call of a server
// goes through, and the library's file.

func open(t *testing.T, root string) *Store {
	t.Helper()
	s, err := Open(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// refused fails the test unless err is a refusal with this code and a sentence.
func refused(t *testing.T, err error, code string) *Refusal {
	t.Helper()
	var r *Refusal
	if !errors.As(err, &r) {
		t.Fatalf("got %v, want a refusal with the code %s", err, code)
	}
	if r.Code != code {
		t.Fatalf("refused with %s (%s), want %s", r.Code, r.Text, code)
	}
	if !strings.HasSuffix(r.Text, ".") || r.Text[:1] != strings.ToUpper(r.Text[:1]) || r.Error() != r.Text {
		t.Fatalf("the refusal %s is no sentence: %q", r.Code, r.Text)
	}
	return r
}

func must[T any](t *testing.T) func(T, error) T {
	return func(v T, err error) T {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
}

func ptr(s string) *string { return &s }

// paths lists a library as the paths of its groups (with a "/" at the end) and of its prompts
// (with "=" and the text), sorted.
func paths(t Tree) []string {
	byID := map[string]Group{}
	for _, g := range t.Groups {
		byID[g.ID] = g
	}
	var path func(id string) string
	path = func(id string) string {
		if id == "" {
			return ""
		}
		return path(byID[id].Parent) + byID[id].Name + "/"
	}
	out := []string{}
	for _, g := range t.Groups {
		out = append(out, path(g.ID))
	}
	for _, p := range t.Prompts {
		out = append(out, path(p.Parent)+p.Name+"="+p.Text)
	}
	sort.Strings(out)
	return out
}

func want(t *testing.T, s *Store, lines ...string) {
	t.Helper()
	sort.Strings(lines)
	if got := paths(s.Tree()); strings.Join(got, "\n") != strings.Join(lines, "\n") {
		t.Fatalf("the library:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(lines, "\n"))
	}
}

// Line 1 of section 10: a group, a prompt in it and a group in that group are created, renamed,
// moved and deleted, and all of it is there after a restart.
func TestCreateRenameMoveDeleteAndRestart(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	s := open(t, root)
	if got := s.Tree(); got.Groups == nil || got.Prompts == nil || len(got.Groups)+len(got.Prompts) != 0 {
		t.Fatalf("a new library: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(root, FileName)); !os.IsNotExist(err) {
		t.Fatalf("a library nobody changed has a file: %v", err)
	}

	git := must[Group](t)(s.CreateGroup("git", ""))
	commit := must[Prompt](t)(s.CreatePrompt("commit message", git.ID, "Write a commit message.\n\nKeep it short."))
	hooks := must[Group](t)(s.CreateGroup("hooks", git.ID))
	if git.Parent != "" || commit.Parent != git.ID || hooks.Parent != git.ID || !groupID.MatchString(git.ID) || !promptID.MatchString(commit.ID) {
		t.Fatalf("made %+v, %+v, %+v", git, commit, hooks)
	}
	want(t, s, "git/", "git/hooks/", "git/commit message=Write a commit message.\n\nKeep it short.")
	restarted := func(lines ...string) *Store {
		t.Helper()
		again := open(t, root)
		if n := again.Notice(); n != "" {
			t.Fatalf("after a restart: %s", n)
		}
		want(t, again, lines...)
		return again
	}
	s = restarted("git/", "git/hooks/", "git/commit message=Write a commit message.\n\nKeep it short.")

	// Renamed: all three, the prompt with its text.
	if g := must[Group](t)(s.ChangeGroup(git.ID, GroupChange{Name: ptr("Git")})); g.Name != "Git" || g.ID != git.ID || g.Parent != "" {
		t.Fatalf("renamed to %+v", g)
	}
	must[Group](t)(s.ChangeGroup(hooks.ID, GroupChange{Name: ptr(" pre-commit ")})) // the spaces around a name are not part of it
	if p := must[Prompt](t)(s.ChangePrompt(commit.ID, PromptChange{Name: ptr("message"), Text: ptr("Shorter.")})); p.Name != "message" || p.Text != "Shorter." || p.Parent != git.ID {
		t.Fatalf("changed to %+v", p)
	}
	s = restarted("Git/", "Git/pre-commit/", "Git/message=Shorter.")

	// Moved: the prompt into the inner group, the inner group to the top, the outer one into it.
	if p := must[Prompt](t)(s.ChangePrompt(commit.ID, PromptChange{Parent: ptr(hooks.ID)})); p.Parent != hooks.ID || p.Text != "Shorter." {
		t.Fatalf("moved to %+v", p)
	}
	want(t, s, "Git/", "Git/pre-commit/", "Git/pre-commit/message=Shorter.")
	must[Group](t)(s.ChangeGroup(hooks.ID, GroupChange{Parent: ptr("")}))
	must[Group](t)(s.ChangeGroup(git.ID, GroupChange{Parent: ptr(hooks.ID)}))
	must[Prompt](t)(s.ChangePrompt(commit.ID, PromptChange{Parent: ptr("")}))
	s = restarted("pre-commit/", "pre-commit/Git/", "message=Shorter.")

	// Deleted: each of the three by its own call.
	if err := s.DeletePrompt(commit.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteGroup(git.ID); err != nil {
		t.Fatal(err)
	}
	s = restarted("pre-commit/")
	if err := s.DeleteGroup(hooks.ID); err != nil {
		t.Fatal(err)
	}
	restarted()
}

// Line 2: a second name of a group is refused, also when only the case differs, for a prompt
// and for a group, on create, on rename and on a move; the same name in another group is fine.
func TestNamesAreUniqueInAGroup(t *testing.T) {
	t.Parallel()
	s := open(t, t.TempDir())
	git := must[Group](t)(s.CreateGroup("git", ""))
	misc := must[Group](t)(s.CreateGroup("misc", ""))
	review := must[Prompt](t)(s.CreatePrompt("Review", git.ID, "one"))

	for _, name := range []string{"Review", "review", "REVIEW", "  review  "} {
		_, err := s.CreatePrompt(name, git.ID, "two")
		if r := refused(t, err, CodeNameTaken); !strings.Contains(r.Text, `"Review"`) || !strings.Contains(r.Text, `"git"`) {
			t.Fatalf("%q: %s", name, r.Text)
		}
		// A group and a prompt of one group cannot share a name either.
		_, err = s.CreateGroup(name, git.ID)
		refused(t, err, CodeNameTaken)
	}
	// Case folding is Unicode's, not ASCII's.
	must[Prompt](t)(s.CreatePrompt("Überblick", git.ID, ""))
	_, err := s.CreatePrompt("überblick", git.ID, "")
	refused(t, err, CodeNameTaken)

	// The same name in another group, and at the top.
	other := must[Prompt](t)(s.CreatePrompt("review", misc.ID, "three"))
	top := must[Prompt](t)(s.CreatePrompt("review", "", "four"))
	_, err = s.CreateGroup("Review", "")
	if r := refused(t, err, CodeNameTaken); !strings.Contains(r.Text, "at the top") {
		t.Fatal(r.Text)
	}
	_, err = s.CreateGroup("GIT", "")
	refused(t, err, CodeNameTaken)

	// A rename to a taken name, and a move into a group that has the name.
	sub := must[Group](t)(s.CreateGroup("notes", git.ID))
	_, err = s.ChangeGroup(sub.ID, GroupChange{Name: ptr("REVIEW")})
	refused(t, err, CodeNameTaken)
	_, err = s.ChangePrompt(other.ID, PromptChange{Name: ptr("misc"), Parent: ptr("")})
	refused(t, err, CodeNameTaken)
	_, err = s.ChangePrompt(other.ID, PromptChange{Parent: ptr(git.ID)})
	refused(t, err, CodeNameTaken)
	_, err = s.ChangePrompt(top.ID, PromptChange{Parent: ptr(misc.ID), Text: ptr("changed")})
	refused(t, err, CodeNameTaken)
	// A refused change changes nothing, the text of the same call included.
	want(t, s, "git/", "misc/", "git/notes/", "git/Review=one", "git/Überblick=", "misc/review=three", "review=four")

	// A move with a rename in one call is checked against the group it goes to.
	must[Prompt](t)(s.ChangePrompt(other.ID, PromptChange{Name: ptr("second review"), Parent: ptr(git.ID)}))
	// A prompt keeps its name when only the case of it changes.
	if p := must[Prompt](t)(s.ChangePrompt(review.ID, PromptChange{Name: ptr("REVIEW")})); p.Name != "REVIEW" {
		t.Fatalf("%+v", p)
	}
	want(t, s, "git/", "misc/", "git/notes/", "git/REVIEW=one", "git/Überblick=", "git/second review=three", "review=four")
}

// Line 3: a name with "/", an empty name and a name of more than 80 characters are refused, and
// so is one with a line break; 80 characters are a name.
func TestBadNamesAreRefused(t *testing.T) {
	t.Parallel()
	s := open(t, t.TempDir())
	g := must[Group](t)(s.CreateGroup("g", ""))
	p := must[Prompt](t)(s.CreatePrompt("p", "", "text"))
	long := strings.Repeat("ä", MaxName) // characters, not bytes

	bad := map[string]string{
		"":                 "empty",
		"   ":              "empty",
		"a/b":              `"/"`,
		"/":                `"/"`,
		long + "x":         "80 characters",
		"two\nlines":       "line break",
		"two\r\nlines":     "line break",
		"two lines":        "line break",
		"tab\there":        "control",
		"bad \xff\xfe utf": "text",
	}
	for name, word := range bad {
		for what, err := range map[string]error{
			"a new group":      second(s.CreateGroup(name, "")),
			"a new prompt":     second(s.CreatePrompt(name, g.ID, "text")),
			"a renamed group":  second(s.ChangeGroup(g.ID, GroupChange{Name: ptr(name)})),
			"a renamed prompt": second(s.ChangePrompt(p.ID, PromptChange{Name: ptr(name)})),
		} {
			if r := refused(t, err, CodeBadName); !strings.Contains(r.Text, word) {
				t.Fatalf("%s called %q: %q, want it to say %q", what, name, r.Text, word)
			}
		}
	}
	want(t, s, "g/", "p=text")

	if got := must[Group](t)(s.CreateGroup(long, "")); got.Name != long {
		t.Fatalf("a name of %d characters: %+v", MaxName, got)
	}
	must[Prompt](t)(s.ChangePrompt(p.ID, PromptChange{Name: ptr("ok: a.b\\c, d & e?")}))
}

func second[T any](_ T, err error) error { return err }

// Line 4: deleting a group removes everything in it, at any depth, and nothing else.
func TestDeletingAGroupDeletesEverythingInIt(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	s := open(t, root)
	git := must[Group](t)(s.CreateGroup("git", ""))
	hooks := must[Group](t)(s.CreateGroup("hooks", git.ID))
	deep := must[Group](t)(s.CreateGroup("deep", hooks.ID))
	must[Group](t)(s.CreateGroup("empty", git.ID))
	keep := must[Group](t)(s.CreateGroup("keep", ""))
	must[Prompt](t)(s.CreatePrompt("a", git.ID, "1"))
	must[Prompt](t)(s.CreatePrompt("b", hooks.ID, "2"))
	gone := must[Prompt](t)(s.CreatePrompt("c", deep.ID, "3"))
	must[Prompt](t)(s.CreatePrompt("a", keep.ID, "4"))
	must[Prompt](t)(s.CreatePrompt("top", "", "5"))

	if err := s.DeleteGroup(git.ID); err != nil {
		t.Fatal(err)
	}
	want(t, s, "keep/", "keep/a=4", "top=5")
	want(t, open(t, root), "keep/", "keep/a=4", "top=5")

	// What went with the group is not there for a later call.
	_, err := s.ChangePrompt(gone.ID, PromptChange{Text: ptr("x")})
	refused(t, err, CodeNotFound)
	_, err = s.CreatePrompt("d", deep.ID, "")
	refused(t, err, CodeNoGroup)
	refused(t, s.DeleteGroup(git.ID), CodeNotFound)
}

// Line 5: a group cannot be moved into itself or below itself.
func TestAGroupIsNotMovedIntoItselfOrBelow(t *testing.T) {
	t.Parallel()
	s := open(t, t.TempDir())
	a := must[Group](t)(s.CreateGroup("a", ""))
	b := must[Group](t)(s.CreateGroup("b", a.ID))
	c := must[Group](t)(s.CreateGroup("c", b.ID))
	other := must[Group](t)(s.CreateGroup("other", ""))

	_, err := s.ChangeGroup(a.ID, GroupChange{Parent: ptr(a.ID)})
	if r := refused(t, err, CodeBadMove); !strings.Contains(r.Text, "into itself") {
		t.Fatal(r.Text)
	}
	for _, below := range []string{b.ID, c.ID} {
		_, err := s.ChangeGroup(a.ID, GroupChange{Parent: ptr(below), Name: ptr("renamed")})
		if r := refused(t, err, CodeBadMove); !strings.Contains(r.Text, "below it") {
			t.Fatal(r.Text)
		}
	}
	_, err = s.ChangeGroup(b.ID, GroupChange{Parent: ptr(c.ID)})
	refused(t, err, CodeBadMove)
	want(t, s, "a/", "a/b/", "a/b/c/", "other/")

	// Every other move is one: up, to the top, into a group beside it, and back down.
	must[Group](t)(s.ChangeGroup(c.ID, GroupChange{Parent: ptr(a.ID)}))
	must[Group](t)(s.ChangeGroup(b.ID, GroupChange{Parent: ptr("")}))
	must[Group](t)(s.ChangeGroup(a.ID, GroupChange{Parent: ptr(other.ID)}))
	must[Group](t)(s.ChangeGroup(other.ID, GroupChange{Parent: ptr(b.ID)}))
	want(t, s, "b/", "b/other/", "b/other/a/", "b/other/a/c/")
}

// What a call names has to be there: the item itself (deleted meanwhile) and the group it goes to.
func TestMissingItemsAndGroups(t *testing.T) {
	t.Parallel()
	s := open(t, t.TempDir())
	g := must[Group](t)(s.CreateGroup("g", ""))
	p := must[Prompt](t)(s.CreatePrompt("p", g.ID, "text"))

	for _, id := range []string{"", "p_000000000000", g.ID, "../x"} {
		_, err := s.ChangePrompt(id, PromptChange{Text: ptr("x")})
		if r := refused(t, err, CodeNotFound); !strings.Contains(r.Text, "prompt") {
			t.Fatal(r.Text)
		}
		refused(t, s.DeletePrompt(id), CodeNotFound)
	}
	for _, id := range []string{"", "g_000000000000", p.ID} {
		_, err := s.ChangeGroup(id, GroupChange{Name: ptr("x")})
		if r := refused(t, err, CodeNotFound); !strings.Contains(r.Text, "group") {
			t.Fatal(r.Text)
		}
		refused(t, s.DeleteGroup(id), CodeNotFound)
	}
	// A prompt is no group to put something in.
	for _, parent := range []string{"g_000000000000", p.ID, "nonsense"} {
		refused(t, second(s.CreateGroup("x", parent)), CodeNoGroup)
		refused(t, second(s.CreatePrompt("x", parent, "")), CodeNoGroup)
		refused(t, second(s.ChangeGroup(g.ID, GroupChange{Parent: ptr(parent)})), CodeNoGroup)
		refused(t, second(s.ChangePrompt(p.ID, PromptChange{Parent: ptr(parent)})), CodeNoGroup)
	}
	want(t, s, "g/", "g/p=text")
}

// A text is kept as it was sent, line breaks included, may be empty, and has a limit.
func TestTheTextOfAPrompt(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	s := open(t, root)
	text := "First line\n\n  indented <b>not markup</b>\r\n\ttabbed\nlast line without a break 🙂"
	p := must[Prompt](t)(s.CreatePrompt("p", "", text))
	if p.Text != text || open(t, root).Tree().Prompts[0].Text != text {
		t.Fatalf("the text changed: %q", p.Text)
	}
	must[Prompt](t)(s.ChangePrompt(p.ID, PromptChange{Text: ptr("")}))
	want(t, s, "p=")

	full := strings.Repeat("ß", MaxText) // characters, not bytes
	if got := must[Prompt](t)(s.ChangePrompt(p.ID, PromptChange{Text: &full})); got.Text != full {
		t.Fatal("a text of the limit's length was not kept whole")
	}
	_, err := s.ChangePrompt(p.ID, PromptChange{Text: ptr(full + "x")})
	if r := refused(t, err, CodeTextTooLong); !strings.Contains(r.Text, "100,000") {
		t.Fatal(r.Text)
	}
	refused(t, second(s.CreatePrompt("q", "", full+"x")), CodeTextTooLong)
	refused(t, second(s.CreatePrompt("q", "", "bad \xff text")), CodeBadText)
	if got := s.Tree(); len(got.Prompts) != 1 || got.Prompts[0].Text != full {
		t.Fatal("a refused text changed the library")
	}
}

// writeLibrary puts a library file into root.
func writeLibrary(t *testing.T, root string, tr Tree) {
	t.Helper()
	b, err := json.Marshal(libraryFile{Version: fileVersion, Groups: tr.Groups, Prompts: tr.Prompts})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, FileName), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func gid(n int) string { return fmt.Sprintf("g_%012x", n) }
func pid(n int) string { return fmt.Sprintf("p_%012x", n) }

// The library as a whole has a size: a number of items and a number of bytes.
func TestTheLibraryIsFull(t *testing.T) {
	t.Parallel()
	t.Run("items", func(t *testing.T) {
		t.Parallel()
		root := t.TempDir()
		var tr Tree
		for i := 0; i < MaxItems-1; i++ {
			if i%2 == 0 {
				tr.Groups = append(tr.Groups, Group{ID: gid(i), Name: fmt.Sprint("group ", i)})
			} else {
				tr.Prompts = append(tr.Prompts, Prompt{ID: pid(i), Name: fmt.Sprint("prompt ", i), Parent: gid(0), Text: "t"})
			}
		}
		writeLibrary(t, root, tr)
		s := open(t, root)
		if n := s.Notice(); n != "" {
			t.Fatal(n)
		}
		last := must[Prompt](t)(s.CreatePrompt("the last one", "", ""))
		if r := refused(t, second(s.CreatePrompt("one more", "", "")), CodeFull); !strings.Contains(r.Text, "5,000") {
			t.Fatal(r.Text)
		}
		refused(t, second(s.CreateGroup("one more", "")), CodeFull)
		// A full library can still be changed and made smaller.
		must[Prompt](t)(s.ChangePrompt(last.ID, PromptChange{Text: ptr("changed")}))
		if err := s.DeletePrompt(last.ID); err != nil {
			t.Fatal(err)
		}
		must[Group](t)(s.CreateGroup("one more", ""))
	})
	t.Run("bytes", func(t *testing.T) {
		t.Parallel()
		root := t.TempDir()
		big := strings.Repeat("🙂", MaxText) // 4 bytes each
		var tr Tree
		for i := 0; len(big)*(i+1) <= MaxBytes; i++ {
			tr.Prompts = append(tr.Prompts, Prompt{ID: pid(i), Name: fmt.Sprint("p", i), Text: big})
		}
		writeLibrary(t, root, tr)
		s := open(t, root)
		if n := s.Notice(); n != "" {
			t.Fatal(n)
		}
		if r := refused(t, second(s.CreatePrompt("too much", "", big)), CodeFull); !strings.Contains(r.Text, "4 MB") {
			t.Fatal(r.Text)
		}
		small := must[Prompt](t)(s.CreatePrompt("small", "", "fits"))
		refused(t, second(s.ChangePrompt(small.ID, PromptChange{Text: &big})), CodeFull)
		if got := s.Tree(); len(got.Prompts) != len(tr.Prompts)+1 || got.Prompts[len(tr.Prompts)].Text != "fits" {
			t.Fatal("a refused change changed the library")
		}
	})
}

// Groups nest to a depth, on create and on a move of a group with groups in it.
func TestGroupsNestToADepth(t *testing.T) {
	t.Parallel()
	s := open(t, t.TempDir())
	parent := ""
	var chain []Group
	for i := 0; i < MaxDepth; i++ {
		g := must[Group](t)(s.CreateGroup(fmt.Sprint("level ", i+1), parent))
		chain = append(chain, g)
		parent = g.ID
	}
	if r := refused(t, second(s.CreateGroup("too deep", parent)), CodeTooDeep); !strings.Contains(r.Text, "16") {
		t.Fatal(r.Text)
	}
	must[Prompt](t)(s.CreatePrompt("a prompt at the bottom", parent, "")) // a prompt is no level

	two := must[Group](t)(s.CreateGroup("two", ""))
	must[Group](t)(s.CreateGroup("levels", two.ID))
	refused(t, second(s.ChangeGroup(two.ID, GroupChange{Parent: ptr(chain[MaxDepth-2].ID)})), CodeTooDeep)
	must[Group](t)(s.ChangeGroup(two.ID, GroupChange{Parent: ptr(chain[MaxDepth-3].ID)}))
	// The chain itself moves nowhere deeper, and anywhere else.
	refused(t, second(s.ChangeGroup(chain[1].ID, GroupChange{Parent: ptr(two.ID)})), CodeBadMove)
	must[Group](t)(s.ChangeGroup(chain[MaxDepth-1].ID, GroupChange{Parent: ptr("")}))
}

// Two windows change one prompt: the later save wins, whole field by whole field, and every
// change is told in its order with the library as it was after it.
func TestTheLaterSaveWinsAndChangesAreToldInOrder(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var told []Tree
	s, err := Open(t.TempDir(), func(tr Tree) {
		mu.Lock()
		defer mu.Unlock()
		told = append(told, tr)
	})
	if err != nil {
		t.Fatal(err)
	}
	p := must[Prompt](t)(s.CreatePrompt("p", "", "start"))
	must[Prompt](t)(s.ChangePrompt(p.ID, PromptChange{Name: ptr("first"), Text: ptr("first window")}))
	if got := must[Prompt](t)(s.ChangePrompt(p.ID, PromptChange{Text: ptr("second window")})); got.Name != "first" || got.Text != "second window" {
		t.Fatalf("after the later save: %+v", got)
	}
	if len(told) != 3 || told[0].Prompts[0].Text != "start" || told[1].Prompts[0].Text != "first window" || told[2].Prompts[0].Text != "second window" {
		t.Fatalf("told %d changes: %+v", len(told), told)
	}

	// A call that changes nothing, and one that is refused, tell nothing and write nothing.
	file := filepath.Join(filepath.Dir(s.path), FileName)
	before, _ := os.ReadFile(file)
	if got := must[Prompt](t)(s.ChangePrompt(p.ID, PromptChange{Name: ptr("first"), Parent: ptr("")})); got.Text != "second window" {
		t.Fatalf("%+v", got)
	}
	must[Prompt](t)(s.ChangePrompt(p.ID, PromptChange{}))
	refused(t, second(s.ChangePrompt(p.ID, PromptChange{Name: ptr("a/b")})), CodeBadName)
	if after, _ := os.ReadFile(file); len(told) != 3 || string(after) != string(before) {
		t.Fatalf("told %d changes; the file changed: %v", len(told), string(after) != string(before))
	}

	// Many at once: every one is kept, and the last one told is the library.
	told = nil
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.CreatePrompt(fmt.Sprint("at once ", i), "", "x"); err != nil {
				t.Error(err)
			}
			s.Tree()
		}()
	}
	wg.Wait()
	if len(told) != 20 {
		t.Fatalf("told %d of 20 changes", len(told))
	}
	for i, tr := range told {
		if len(tr.Prompts) != i+2 {
			t.Fatalf("change %d was told with %d prompts", i+1, len(tr.Prompts))
		}
	}
	if got := paths(told[19]); strings.Join(got, "\n") != strings.Join(paths(s.Tree()), "\n") {
		t.Fatalf("the last change told is not the library: %v", got)
	}
}

// The file is the server list's kind: it has a version, is written whole after every change, and
// is for its user alone.
func TestTheFile(t *testing.T) {
	t.Parallel()
	root := filepath.Join(t.TempDir(), "data") // made by the first write
	s := open(t, root)
	g := must[Group](t)(s.CreateGroup("g", ""))
	p := must[Prompt](t)(s.CreatePrompt("p", g.ID, "line one\nline two"))
	path := filepath.Join(root, FileName)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Version int
		Groups  []Group
		Prompts []Prompt
	}
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if f.Version != 1 || len(f.Groups) != 1 || f.Groups[0] != g || len(f.Prompts) != 1 || f.Prompts[0] != p {
		t.Fatalf("the file: %s", b)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Fatalf("the file's mode: %v", st.Mode())
	}
	if left, _ := filepath.Glob(filepath.Join(root, "*.tmp")); len(left) != 0 {
		t.Fatalf("left behind: %v", left)
	}
	// An empty file, and one with fields of a later build, are libraries.
	os.WriteFile(path, []byte(" \n"), 0o600)
	if s := open(t, root); s.Notice() != "" || len(s.Tree().Groups) != 0 {
		t.Fatalf("an empty file: %q", s.Notice())
	}
	os.WriteFile(path, []byte(`{"version":1,"later":true,"groups":[{"id":"g_0000000000aa","name":"g","parent":"","colour":"red"}]}`), 0o600)
	if s := open(t, root); s.Notice() != "" || len(s.Tree().Groups) != 1 {
		t.Fatalf("a file with unknown fields: %q", s.Notice())
	}
	if _, err := Open("", nil); err == nil {
		t.Fatal("a library without a data folder was opened")
	}
}

// A file that cannot be read is set aside and reported, never deleted and never a reason not to
// start: the library starts empty and can be used.
func TestAFileThatCannotBeReadIsSetAside(t *testing.T) {
	prev := now
	now = func() time.Time { return time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC) }
	t.Cleanup(func() { now = prev })
	const aside = FileName + ".unreadable-20260304T050607Z"

	cases := map[string]string{
		"no JSON":                 `{"version":1,"groups":[`,
		"another shape":           `[1,2,3]`,
		"a later version":         `{"version":2,"groups":[],"prompts":[]}`,
		"a bad id":                `{"version":1,"groups":[{"id":"x","name":"g","parent":""}]}`,
		"an id twice":             `{"version":1,"prompts":[{"id":"p_0000000000aa","name":"a"},{"id":"p_0000000000aa","name":"b"}]}`,
		"a bad name":              `{"version":1,"prompts":[{"id":"p_0000000000aa","name":"a/b"}]}`,
		"a name with spaces":      `{"version":1,"prompts":[{"id":"p_0000000000aa","name":" a "}]}`,
		"a name twice":            `{"version":1,"groups":[{"id":"g_0000000000aa","name":"A"}],"prompts":[{"id":"p_0000000000aa","name":"a"}]}`,
		"a group that is not":     `{"version":1,"prompts":[{"id":"p_0000000000aa","name":"a","parent":"g_0000000000aa"}]}`,
		"a prompt as a group":     `{"version":1,"prompts":[{"id":"p_0000000000aa","name":"a"},{"id":"p_0000000000ab","name":"b","parent":"p_0000000000aa"}]}`,
		"a group in itself":       `{"version":1,"groups":[{"id":"g_0000000000aa","name":"a","parent":"g_0000000000aa"}]}`,
		"groups in a circle":      `{"version":1,"groups":[{"id":"g_0000000000aa","name":"a","parent":"g_0000000000ab"},{"id":"g_0000000000ab","name":"b","parent":"g_0000000000aa"}]}`,
		"a text that is too long": `{"version":1,"prompts":[{"id":"p_0000000000aa","name":"a","text":"` + strings.Repeat("x", MaxText+1) + `"}]}`,
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, FileName)
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			s := open(t, root)
			if n := s.Notice(); !strings.Contains(n, path) || !strings.Contains(n, "set aside as "+aside) || !strings.Contains(n, "empty library") {
				t.Fatalf("the notice: %q", n)
			}
			if kept, err := os.ReadFile(filepath.Join(root, aside)); err != nil || string(kept) != content {
				t.Fatalf("the file set aside: %v", err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("the unreadable file is still in its place: %v", err)
			}
			if got := s.Tree(); len(got.Groups)+len(got.Prompts) != 0 {
				t.Fatalf("the library is not empty: %+v", got)
			}
			// The library works, and its new file is beside the one set aside.
			must[Prompt](t)(s.CreatePrompt("new", "", "text"))
			again := open(t, root)
			if again.Notice() != "" {
				t.Fatalf("the second start: %q", again.Notice())
			}
			want(t, again, "new=text")
		})
	}

	t.Run("a second file in the same second", func(t *testing.T) {
		root := t.TempDir()
		for i, name := range []string{aside, aside + "-2"} {
			os.WriteFile(filepath.Join(root, FileName), []byte(fmt.Sprint("bad ", i)), 0o600)
			if n := open(t, root).Notice(); !strings.HasSuffix(strings.Split(n, "; ")[1], "set aside as "+name) {
				t.Fatalf("file %d: %q", i+1, n)
			}
		}
		for i, name := range []string{aside, aside + "-2"} {
			if b, _ := os.ReadFile(filepath.Join(root, name)); string(b) != fmt.Sprint("bad ", i) {
				t.Fatalf("%s holds %q", name, b)
			}
		}
	})

	t.Run("it cannot be set aside", func(t *testing.T) {
		if os.Getuid() == 0 {
			t.Skip("root renames in any folder")
		}
		root := t.TempDir()
		path := filepath.Join(root, FileName)
		os.WriteFile(path, []byte("bad"), 0o600)
		os.Chmod(root, 0o500)
		t.Cleanup(func() { os.Chmod(root, 0o700) })
		s := open(t, root)
		if n := s.Notice(); !strings.Contains(n, "could not be set aside") {
			t.Fatalf("the notice: %q", n)
		}
		// Nothing is written over the file, and the call says why; it is no refusal of a rule.
		_, err := s.CreatePrompt("new", "", "text")
		var r *Refusal
		if err == nil || errors.As(err, &r) || !strings.Contains(err.Error(), "could not be set aside") {
			t.Fatalf("a change with the file in the way: %v", err)
		}
		if b, _ := os.ReadFile(path); string(b) != "bad" || len(s.Tree().Prompts) != 0 {
			t.Fatalf("the file: %q, the library: %+v", b, s.Tree())
		}
	})
}

// Check holds a library from somewhere else to the rules; one a store made passes it.
func TestCheck(t *testing.T) {
	t.Parallel()
	s := open(t, t.TempDir())
	g := must[Group](t)(s.CreateGroup("g", ""))
	must[Group](t)(s.CreateGroup("inner", g.ID))
	must[Prompt](t)(s.CreatePrompt("p", g.ID, "text"))
	must[Prompt](t)(s.CreatePrompt("Inner", "", "the name of a group in another group"))
	if err := Check(s.Tree()); err != nil {
		t.Fatal(err)
	}
	if err := Check(Tree{}); err != nil {
		t.Fatal(err)
	}

	deep := Tree{}
	for i := 0; i <= MaxDepth; i++ {
		parent := ""
		if i > 0 {
			parent = gid(i - 1)
		}
		deep.Groups = append(deep.Groups, Group{ID: gid(i), Name: "g", Parent: parent})
	}
	if err := Check(Tree{Groups: deep.Groups[:MaxDepth]}); err != nil {
		t.Fatalf("%d groups deep: %v", MaxDepth, err)
	}
	many := Tree{}
	for i := 0; i <= MaxItems; i++ {
		many.Prompts = append(many.Prompts, Prompt{ID: pid(i), Name: fmt.Sprint(i)})
	}
	heavy := Tree{}
	for i := 0; i < 12; i++ {
		heavy.Prompts = append(heavy.Prompts, Prompt{ID: pid(i), Name: fmt.Sprint(i), Text: strings.Repeat("🙂", MaxText)})
	}
	for name, tr := range map[string]Tree{
		"too deep":            deep,
		"too many":            many,
		"too heavy":           heavy,
		"a name too long":     {Groups: []Group{{ID: gid(1), Name: strings.Repeat("x", MaxName+1)}}},
		"a line break":        {Prompts: []Prompt{{ID: pid(1), Name: "a\nb"}}},
		"markup is a name":    {Prompts: []Prompt{{ID: pid(1), Name: "<b>x</b>"}}}, // "/" is not: shown as text, it is the path's separator
		"a group's id":        {Prompts: []Prompt{{ID: gid(1), Name: "a"}}},
		"a prompt's id":       {Groups: []Group{{ID: pid(1), Name: "a"}}},
		"an id of both":       {Groups: []Group{{ID: gid(1), Name: "a"}}, Prompts: []Prompt{{ID: gid(1), Name: "b"}}},
		"the case of a name":  {Groups: []Group{{ID: gid(1), Name: "Straße"}, {ID: gid(2), Name: "STRAßE"}}},
		"a text that is long": {Prompts: []Prompt{{ID: pid(1), Name: "a", Text: strings.Repeat("x", MaxText+1)}}},
		"a text that is none": {Prompts: []Prompt{{ID: pid(1), Name: "a", Text: "\xff"}}},
	} {
		if err := Check(tr); err == nil {
			t.Errorf("%s: passed", name)
		}
	}
}

// One item that came from another server is held to the rules of an item: its id, its name, the
// form of its parent's id and its text.
func TestCheckItems(t *testing.T) {
	t.Parallel()
	if err := CheckGroup(Group{ID: gid(1), Name: "git", Parent: gid(2)}); err != nil {
		t.Fatal(err)
	}
	if err := CheckPrompt(Prompt{ID: pid(1), Name: "review", Parent: "", Text: "a\nb"}); err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("x", 1<<20)
	for name, g := range map[string]Group{
		"no id":             {Name: "g"},
		"a prompt's id":     {ID: pid(1), Name: "g"},
		"a long id":         {ID: long, Name: "g"},
		"no name":           {ID: gid(1)},
		"a slash":           {ID: gid(1), Name: "a/b"},
		"spaces around":     {ID: gid(1), Name: " g"},
		"a name too long":   {ID: gid(1), Name: strings.Repeat("x", MaxName+1)},
		"a parent of no id": {ID: gid(1), Name: "g", Parent: "../x"},
		"a prompt as group": {ID: gid(1), Name: "g", Parent: pid(1)},
		"a long parent":     {ID: gid(1), Name: "g", Parent: long},
	} {
		err := CheckGroup(g)
		if err == nil {
			t.Errorf("the group with %s passed", name)
		} else if len(err.Error()) > 200 {
			t.Errorf("the group with %s: an error of %d bytes", name, len(err.Error()))
		}
	}
	for name, p := range map[string]Prompt{
		"no id":               {Name: "p"},
		"a group's id":        {ID: gid(1), Name: "p"},
		"a line break":        {ID: pid(1), Name: "a\nb"},
		"a parent of no id":   {ID: pid(1), Name: "p", Parent: "top"},
		"a text that is long": {ID: pid(1), Name: "p", Text: strings.Repeat("x", MaxText+1)},
		"a text that is none": {ID: pid(1), Name: "p", Text: "\xff"},
	} {
		if CheckPrompt(p) == nil {
			t.Errorf("the prompt with %s passed", name)
		}
	}
	// What Check says of a library another server sent is short too, whatever the ids are.
	for _, tr := range []Tree{
		{Groups: []Group{{ID: long, Name: "g"}}},
		{Prompts: []Prompt{{ID: pid(1), Name: "p", Parent: long}}},
	} {
		if err := Check(tr); err == nil || len(err.Error()) > 200 {
			t.Errorf("Check: %.80v", err)
		}
	}
	if !IsGroupID(gid(1)) || IsGroupID(pid(1)) || IsGroupID("") || !IsPromptID(pid(1)) || IsPromptID(gid(1)) || IsPromptID(pid(1)+"\n") {
		t.Error("the form of an id")
	}
	for _, code := range []string{CodeBadName, CodeNameTaken, CodeNotFound, CodeNoGroup, CodeBadMove, CodeBadText, CodeTextTooLong, CodeFull, CodeTooDeep} {
		if !IsCode(code) {
			t.Errorf("%s is no code", code)
		}
	}
	if IsCode("") || IsCode("unknown_client") || IsCode("no_server") {
		t.Error("a code that is none of a refusal")
	}
}
