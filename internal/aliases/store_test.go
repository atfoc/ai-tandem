package aliases

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// openTestStore opens a store in a fresh folder; its log lines go to t.
func openTestStore(t *testing.T) (*FileStore, string) {
	t.Helper()
	root := t.TempDir()
	s, err := OpenStore(root, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	return s, root
}

func testAlias(n int) Alias {
	return Alias{ID: fmt.Sprintf("a_%08d", n), Name: fmt.Sprintf("Account %d", n), Mounts: []string{"/p" + fmt.Sprint(n)},
		Created: time.Date(2026, 11, 9, 10, n, 0, 0, time.UTC)}
}

func ids(l []Alias) []string {
	out := make([]string, len(l))
	for i, a := range l {
		out[i] = a.ID
	}
	return out
}

func TestStorePutGetListDelete(t *testing.T) {
	s, root := openTestStore(t)
	for _, n := range []int{3, 1, 2} {
		if err := s.Put(testAlias(n)); err != nil {
			t.Fatal(err)
		}
	}
	if got := ids(s.List()); !slices.Equal(got, []string{"a_00000003", "a_00000001", "a_00000002"}) {
		t.Fatalf("order %v", got)
	}
	a := testAlias(1)
	a.Name = "Renamed"
	if err := s.Put(a); err != nil {
		t.Fatal(err)
	}
	if got := ids(s.List()); !slices.Equal(got, []string{"a_00000003", "a_00000001", "a_00000002"}) {
		t.Fatalf("replace moved the record: %v", got)
	}
	if g, ok := s.Get("a_00000001"); !ok || g.Name != "Renamed" {
		t.Fatalf("get %+v %v", g, ok)
	}
	if _, ok := s.Get("a_99999999"); ok {
		t.Fatal("get of a missing record")
	}
	if err := s.Delete("a_00000003"); err != nil {
		t.Fatal(err)
	}
	if got := ids(s.List()); !slices.Equal(got, []string{"a_00000001", "a_00000002"}) {
		t.Fatalf("after delete %v", got)
	}
	before, _ := os.Stat(File(root))
	if err := s.Delete("a_00000003"); err != nil {
		t.Fatalf("delete of a missing record: %v", err)
	}
	after, _ := os.Stat(File(root))
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatal("delete of a missing record wrote the file")
	}
}

func TestStoreReload(t *testing.T) {
	s, root := openTestStore(t)
	checked := time.Date(2026, 11, 9, 11, 0, 0, 0, time.UTC)
	a := testAlias(1)
	a.Image = "custom:1"
	a.Applied = &Applied{Image: "custom:1", Mounts: []string{"/p1", "/q"}}
	a.LastLogin = &LastLogin{LoggedIn: true, Email: "x@example.com", Checked: checked}
	b := testAlias(2)
	b.Mounts = nil
	for _, x := range []Alias{a, b} {
		if err := s.Put(x); err != nil {
			t.Fatal(err)
		}
	}
	raw, _ := os.ReadFile(File(root))
	if strings.Contains(string(raw), "null") {
		t.Fatalf("null in the file:\n%s", raw)
	}
	r, err := OpenStore(root, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	l := r.List()
	if len(l) != 2 {
		t.Fatalf("reloaded %v", ids(l))
	}
	g := l[0]
	if g.ID != a.ID || g.Name != a.Name || g.Image != a.Image || !g.Created.Equal(a.Created) || !slices.Equal(g.Mounts, a.Mounts) {
		t.Fatalf("reloaded %+v", g)
	}
	if g.Applied == nil || g.Applied.Image != "custom:1" || !slices.Equal(g.Applied.Mounts, a.Applied.Mounts) {
		t.Fatalf("applied %+v", g.Applied)
	}
	if g.LastLogin == nil || !g.LastLogin.LoggedIn || g.LastLogin.Email != "x@example.com" || !g.LastLogin.Checked.Equal(checked) {
		t.Fatalf("last login %+v", g.LastLogin)
	}
	if l[1].ID != b.ID || l[1].Applied != nil || l[1].LastLogin != nil || len(l[1].Mounts) != 0 {
		t.Fatalf("second %+v", l[1])
	}
}

func TestStoreFileModeAndNoTempFiles(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data") // made by the first write
	s, err := OpenStore(root, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	for n := range 5 {
		if err := s.Put(testAlias(n)); err != nil {
			t.Fatal(err)
		}
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 || entries[0].Name() != FileName {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("files in the folder: %v", names)
	}
	if runtime.GOOS == "windows" {
		return
	}
	fi, err := os.Stat(File(root))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode().Perm())
	}
	di, _ := os.Stat(root)
	if di.Mode().Perm() != 0o700 {
		t.Fatalf("folder mode %v", di.Mode().Perm())
	}
}

func TestStoreCopiesAreIndependent(t *testing.T) {
	s, _ := openTestStore(t)
	a := testAlias(1)
	a.Applied = &Applied{Image: "i", Mounts: []string{"/p1"}}
	a.LastLogin = &LastLogin{LoggedIn: true}
	if err := s.Put(a); err != nil {
		t.Fatal(err)
	}
	a.Mounts[0] = "/changed" // the caller's value after Put
	l := s.List()
	l[0].Mounts[0] = "/changed"
	l[0].Applied.Mounts[0] = "/changed"
	l[0].LastLogin.LoggedIn = false
	g, _ := s.Get(a.ID)
	g.Mounts[0] = "/changed"
	g.Applied.Image = "changed"
	g2, _ := s.Get(a.ID)
	if g2.Mounts[0] != "/p1" || g2.Applied.Mounts[0] != "/p1" || g2.Applied.Image != "i" || !g2.LastLogin.LoggedIn {
		t.Fatalf("the store changed through a copy: %+v %+v %+v", g2, g2.Applied, g2.LastLogin)
	}
}

func TestStoreGarbledFileSetAside(t *testing.T) {
	root := t.TempDir()
	old := []byte(`{"aliases": [ not json`)
	if err := os.WriteFile(File(root), old, 0o600); err != nil {
		t.Fatal(err)
	}
	var logged []string
	s, err := OpenStore(root, func(f string, a ...any) { logged = append(logged, fmt.Sprintf(f, a...)) })
	if err != nil {
		t.Fatal(err)
	}
	if len(s.List()) != 0 {
		t.Fatal("list not empty")
	}
	aside, _ := filepath.Glob(File(root) + ".unreadable-*")
	if len(aside) != 1 {
		t.Fatalf("set-aside files %v", aside)
	}
	if b, _ := os.ReadFile(aside[0]); string(b) != string(old) {
		t.Fatalf("set-aside bytes %q", b)
	}
	if len(logged) != 1 || !strings.Contains(logged[0], "set aside as "+filepath.Base(aside[0])) {
		t.Fatalf("log %q", logged)
	}
	if _, err := os.Stat(File(root)); !os.IsNotExist(err) {
		t.Fatalf("the unreadable file is still in its place: %v", err)
	}
	if err := s.Put(testAlias(1)); err != nil {
		t.Fatal(err)
	}
	r, err := OpenStore(root, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(r.List()); !slices.Equal(got, []string{"a_00000001"}) {
		t.Fatalf("after a fresh write %v", got)
	}
}

func TestStoreDropsBadIDs(t *testing.T) {
	root := t.TempDir()
	body := `{"aliases":[{"id":"a_00000001","name":"ok","mounts":[]},{"id":"nope","name":"bad","mounts":[]}]}`
	if err := os.WriteFile(File(root), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	var logged []string
	s, err := OpenStore(root, func(f string, a ...any) { logged = append(logged, fmt.Sprintf(f, a...)) })
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(s.List()); !slices.Equal(got, []string{"a_00000001"}) {
		t.Fatalf("records %v", got)
	}
	if len(logged) != 1 || !strings.Contains(logged[0], `"nope"`) {
		t.Fatalf("log %q", logged)
	}
}

func TestStoreMissingFile(t *testing.T) {
	s, root := openTestStore(t)
	if l := s.List(); len(l) != 0 {
		t.Fatalf("list %v", l)
	}
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Fatalf("something was written: %v", entries)
	}
}

func TestStoreConcurrentPuts(t *testing.T) {
	s, root := openTestStore(t)
	const n = 20
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.Put(testAlias(i)); err != nil {
				t.Error(err)
			}
			s.List()
		}()
	}
	wg.Wait()
	if got := len(s.List()); got != n {
		t.Fatalf("%d records in memory", got)
	}
	r, err := OpenStore(root, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(r.List()); got != n {
		t.Fatalf("%d records in the file", got)
	}
}
