package servers

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	pinA = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89"
	pinB = "00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF"
	uuid = "3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b"
)

func open(t *testing.T, root string) *List {
	t.Helper()
	l, err := OpenList(root)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func studio() Entry {
	return Entry{Name: "Studio", Address: "https://mac.local:4748", Secret: "s3cret-one", SelfSigned: true, Pin: pinA}
}

// names lists the folder's entries.
func names(t *testing.T, root string) []string {
	t.Helper()
	des, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, de := range des {
		out = append(out, de.Name())
	}
	return out
}

// checkFile fails unless root holds servers.json with mode 0600 and no ".tmp" beside it.
func checkFile(t *testing.T, root string) {
	t.Helper()
	fi, err := os.Stat(filepath.Join(root, FileName))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v, want 0600", fi.Mode().Perm())
	}
	for _, n := range names(t, root) {
		if strings.HasSuffix(n, ".tmp") {
			t.Errorf("%s left behind", n)
		}
	}
}

func TestListMissingAndEmptyFile(t *testing.T) {
	t.Run("missing folder", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "home")
		l := open(t, root)
		if len(l.Entries()) != 0 || l.Notice() != "" {
			t.Errorf("entries %v, notice %q", l.Entries(), l.Notice())
		}
		if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("the folder was made: %v", err)
		}
	})
	for name, content := range map[string]string{"zero length": "", "white space": " \n\t\r\n"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, FileName)
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			l := open(t, root)
			if len(l.Entries()) != 0 || l.Notice() != "" {
				t.Errorf("entries %v, notice %q", l.Entries(), l.Notice())
			}
			if got := names(t, root); len(got) != 1 || got[0] != FileName {
				t.Errorf("folder holds %v", got)
			}
			if b, _ := os.ReadFile(path); string(b) != content {
				t.Errorf("file rewritten: %q", b)
			}
		})
	}
	t.Run("missing file", func(t *testing.T) {
		root := t.TempDir()
		l := open(t, root)
		if len(l.Entries()) != 0 || l.Notice() != "" {
			t.Errorf("entries %v, notice %q", l.Entries(), l.Notice())
		}
		if _, ok := l.Get(LocalID); ok {
			t.Error("the local entry is in the list")
		}
		if got := names(t, root); len(got) != 0 {
			t.Errorf("folder holds %v", got)
		}
	})
	t.Run("no servers field", func(t *testing.T) {
		for _, content := range []string{`{"version":1}`, `{"version":1,"servers":null}`, `{"version":1,"servers":[]}`} {
			root := t.TempDir()
			os.WriteFile(filepath.Join(root, FileName), []byte(content), 0o600)
			if l := open(t, root); len(l.Entries()) != 0 || l.Notice() != "" {
				t.Errorf("%s: entries %v, notice %q", content, l.Entries(), l.Notice())
			}
		}
	})
}

func TestListAddEditRemoveSurviveReopen(t *testing.T) {
	root := filepath.Join(t.TempDir(), "home") // made at the first write
	l := open(t, root)

	a, err := l.Add(Entry{ID: "s_000000000000", Name: "  Studio ", Address: "HTTPS://Mac.Local:4748/", Secret: " s3cret-one\n",
		SelfSigned: true, Pin: strings.ToLower(strings.ReplaceAll(pinA, ":", ""))})
	if err != nil {
		t.Fatal(err)
	}
	if !entryID.MatchString(a.ID) || a.ID == "s_000000000000" {
		t.Errorf("id %q", a.ID)
	}
	want := Entry{ID: a.ID, Name: "Studio", Address: "https://mac.local:4748", Secret: "s3cret-one", SelfSigned: true, Pin: pinA}
	if a != want {
		t.Errorf("added %+v\nwant  %+v", a, want)
	}
	b, err := l.Add(Entry{Name: "Office", Address: "https://10.0.0.7:4748", Secret: "s3cret-two"})
	if err != nil {
		t.Fatal(err)
	}
	if b.ID == a.ID {
		t.Error("two entries with one id")
	}

	// The file has the fields of the contract.
	var file struct {
		Version int
		Servers []map[string]any
	}
	raw, err := os.ReadFile(filepath.Join(root, FileName))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if file.Version != 1 || len(file.Servers) != 2 {
		t.Fatalf("file: %s", raw)
	}
	for _, k := range []string{"id", "name", "address", "secret", "selfSigned", "pin", "instanceId"} {
		if _, ok := file.Servers[0][k]; !ok {
			t.Errorf("no field %q in %s", k, raw)
		}
	}
	if len(file.Servers[0]) != 7 {
		t.Errorf("fields: %v", file.Servers[0])
	}

	l = open(t, root)
	if got := l.Entries(); len(got) != 2 || got[0] != a || got[1] != b {
		t.Fatalf("after reopen: %+v", got)
	}

	// An edit keeps the id whatever f does, and is normalized like an add.
	e, err := l.Update(a.ID, func(e *Entry) error {
		e.ID = "s_ffffffffffff"
		e.Name = " Studio 2 "
		e.Address = "https://MAC.local:4749"
		e.Secret = "s3cret-three"
		e.Pin = pinB
		e.InstanceID = uuid
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want = Entry{ID: a.ID, Name: "Studio 2", Address: "https://mac.local:4749", Secret: "s3cret-three", SelfSigned: true, Pin: pinB, InstanceID: uuid}
	if e != want {
		t.Errorf("edited %+v\nwant   %+v", e, want)
	}
	if got, ok := l.Get(a.ID); !ok || got != want {
		t.Errorf("Get: %+v, %v", got, ok)
	}
	l = open(t, root)
	if got := l.Entries(); len(got) != 2 || got[0] != want || got[1] != b {
		t.Fatalf("after edit and reopen: %+v", got)
	}

	// A failed edit changes nothing, in memory or in the file.
	before, _ := os.ReadFile(filepath.Join(root, FileName))
	boom := errors.New("boom")
	if _, err := l.Update(a.ID, func(e *Entry) error { e.Name = "lost"; return boom }); err != boom {
		t.Errorf("f's error: %v", err)
	}
	for field, f := range map[string]func(e *Entry){
		"name":    func(e *Entry) { e.Name = " " },
		"long":    func(e *Entry) { e.Name = strings.Repeat("é", 81) },
		"address": func(e *Entry) { e.Address = "http://mac.local:4749" },
		"secret":  func(e *Entry) { e.Secret = "two words" },
		"pin":     func(e *Entry) { e.Pin = "AB:CD" },
	} {
		if _, err := l.Update(a.ID, func(e *Entry) error { f(e); return nil }); err == nil {
			t.Errorf("a bad %s was saved", field)
		}
	}
	if got, _ := l.Get(a.ID); got != want {
		t.Errorf("a failed edit changed the entry: %+v", got)
	}
	if after, _ := os.ReadFile(filepath.Join(root, FileName)); !bytes.Equal(before, after) {
		t.Error("a failed edit changed the file")
	}
	if _, err := l.Update("s_0123456789ab", func(*Entry) error { return nil }); err != ErrNotFound {
		t.Errorf("Update of an unknown id: %v", err)
	}
	if err := l.Remove("s_0123456789ab"); err != ErrNotFound {
		t.Errorf("Remove of an unknown id: %v", err)
	}

	// Entries hands out copies.
	l.Entries()[0].Name = "changed"
	if got, _ := l.Get(a.ID); got.Name != "Studio 2" {
		t.Error("Entries is not a copy")
	}

	if err := l.Remove(a.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := l.Get(a.ID); ok {
		t.Error("removed entry still there")
	}
	l = open(t, root)
	if got := l.Entries(); len(got) != 1 || got[0] != b {
		t.Fatalf("after remove and reopen: %+v", got)
	}
	if err := l.Remove(b.ID); err != nil {
		t.Fatal(err)
	}
	if l = open(t, root); len(l.Entries()) != 0 || l.Notice() != "" {
		t.Errorf("after the last remove: %+v, %q", l.Entries(), l.Notice())
	}
}

func TestListAddChecksFields(t *testing.T) {
	l := open(t, t.TempDir())
	cases := []struct {
		name string
		f    func(e *Entry)
		want error
	}{
		{"empty name", func(e *Entry) { e.Name = "  " }, ErrBadName},
		{"81 characters", func(e *Entry) { e.Name = strings.Repeat("n", 81) }, ErrBadName},
		{"no port", func(e *Entry) { e.Address = "https://mac.local" }, ErrBadAddress},
		{"empty secret", func(e *Entry) { e.Secret = " " }, ErrBadSecret},
		{"secret with a space", func(e *Entry) { e.Secret = "a b" }, ErrBadSecret},
		{"secret not ASCII", func(e *Entry) { e.Secret = "sécret" }, ErrBadSecret},
		{"secret with a control character", func(e *Entry) { e.Secret = "a\x00b" }, ErrBadSecret},
		{"257 characters", func(e *Entry) { e.Secret = strings.Repeat("s", 257) }, ErrBadSecret},
		{"short pin", func(e *Entry) { e.Pin = "AB:CD" }, ErrBadPin},
		{"pin not hex", func(e *Entry) { e.Pin = strings.Replace(pinA, "AB", "ZZ", 1) }, ErrBadPin},
	}
	for _, c := range cases {
		e := studio()
		c.f(&e)
		if _, err := l.Add(e); !errors.Is(err, c.want) {
			t.Errorf("%s: %v, want %v", c.name, err, c.want)
		}
	}
	if len(l.Entries()) != 0 {
		t.Errorf("a refused entry was added: %+v", l.Entries())
	}
	e := studio()
	e.Name, e.Secret = strings.Repeat("é", 80), strings.Repeat("s", 256)
	if _, err := l.Add(e); err != nil {
		t.Errorf("80 and 256 characters: %v", err)
	}
}

func TestListFileMode(t *testing.T) {
	root := t.TempDir()
	l := open(t, root)
	a, err := l.Add(studio())
	if err != nil {
		t.Fatal(err)
	}
	checkFile(t, root)
	// A looser mode does not survive the next write.
	if err := os.Chmod(filepath.Join(root, FileName), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Update(a.ID, func(e *Entry) error { e.Name = "Other"; return nil }); err != nil {
		t.Fatal(err)
	}
	checkFile(t, root)
	if _, err := l.Add(Entry{Name: "Office", Address: "https://10.0.0.7:4748", Secret: "x"}); err != nil {
		t.Fatal(err)
	}
	checkFile(t, root)
	if err := l.Remove(a.ID); err != nil {
		t.Fatal(err)
	}
	checkFile(t, root)
}

func TestListLocalEntryFixed(t *testing.T) {
	root := t.TempDir()
	l := open(t, root)
	called := false
	if _, err := l.Update(LocalID, func(*Entry) error { called = true; return nil }); err != ErrLocalEntry || called {
		t.Errorf("Update: %v, f called %v", err, called)
	}
	if err := l.Remove(LocalID); err != ErrLocalEntry {
		t.Errorf("Remove: %v", err)
	}
	if got := names(t, root); len(got) != 0 {
		t.Errorf("something was written: %v", got)
	}
	e := studio()
	e.ID = LocalID
	a, err := l.Add(e)
	if err != nil {
		t.Fatal(err)
	}
	if a.ID == LocalID || !entryID.MatchString(a.ID) {
		t.Errorf("Add made the id %q", a.ID)
	}
	if _, err := l.Update(a.ID, func(e *Entry) error { e.ID = LocalID; return nil }); err != nil {
		t.Fatal(err)
	}
	if _, ok := l.Get(LocalID); ok {
		t.Error("an edit made the local id")
	}
	if got := l.Entries(); len(got) != 1 || got[0].ID != a.ID {
		t.Errorf("entries: %+v", got)
	}
	if LocalID != "local" || LocalName != "This computer" || FileName != "servers.json" {
		t.Error("the constants changed")
	}
}

func TestListUnreadableSetAside(t *testing.T) {
	entry := func(id, address string) string {
		return `{"id":"` + id + `","name":"Studio","address":"` + address + `","secret":"s3cret-one","selfSigned":false,"pin":"","instanceId":""}`
	}
	good := entry("s_3f9a1c2b77de", "https://mac.local:4748")
	cases := []struct {
		name    string
		content string // the file's bytes
		mode    os.FileMode
		dir     bool
	}{
		{name: "not JSON", content: "{not json", mode: 0o600},
		{name: "an array", content: `[` + good + `]`, mode: 0o600},
		{name: "servers an object", content: `{"version":1,"servers":{"a":1}}`, mode: 0o600},
		{name: "bad address", content: `{"version":1,"servers":[` + good + `,` + entry("s_3f9a1c2b77df", "http://mac.local:4748") + `]}`, mode: 0o600},
		{name: "duplicate id", content: `{"version":1,"servers":[` + good + `,` + entry("s_3f9a1c2b77de", "https://other.local:4748") + `]}`, mode: 0o600},
		{name: "bad id", content: `{"version":1,"servers":[` + entry("local", "https://mac.local:4748") + `]}`, mode: 0o600},
		{name: "empty name", content: `{"version":1,"servers":[` + strings.Replace(good, `"Studio"`, `" "`, 1) + `]}`, mode: 0o600},
		{name: "empty secret", content: `{"version":1,"servers":[` + strings.Replace(good, `"s3cret-one"`, `""`, 1) + `]}`, mode: 0o600},
		{name: "bad pin", content: `{"version":1,"servers":[` + strings.Replace(good, `"selfSigned":false,"pin":""`, `"selfSigned":true,"pin":"AB:CD"`, 1) + `]}`, mode: 0o600},
		{name: "version 2", content: `{"version":2,"servers":[` + good + `]}`, mode: 0o600},
		{name: "a secret with a control character", content: `{"version":1,"servers":[` + strings.Replace(good, `"s3cret-one"`, `"s3cret\u0007one"`, 1) + `]}`, mode: 0o600},
		{name: "a secret with a space", content: `{"version":1,"servers":[` + strings.Replace(good, `"s3cret-one"`, `"s3cret one"`, 1) + `]}`, mode: 0o600},
		{name: "a secret too long", content: `{"version":1,"servers":[` + strings.Replace(good, `"s3cret-one"`, `"`+strings.Repeat("s", 257)+`"`, 1) + `]}`, mode: 0o600},
		{name: "a name too long", content: `{"version":1,"servers":[` + strings.Replace(good, `"Studio"`, `"`+strings.Repeat("n", 81)+`"`, 1) + `]}`, mode: 0o600},
		{name: "mode 000", content: `{"version":1,"servers":[` + good + `]}`, mode: 0},
		{name: "a folder", dir: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.mode == 0 && !c.dir && os.Getuid() == 0 {
				t.Skip("root reads a file of mode 000")
			}
			root := t.TempDir()
			path := filepath.Join(root, FileName)
			if c.dir {
				if err := os.Mkdir(path, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(path, "inside"), []byte("kept"), 0o600); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.WriteFile(path, []byte(c.content), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(path, c.mode); err != nil {
					t.Fatal(err)
				}
			}

			l := open(t, root)
			if got := l.Entries(); len(got) != 0 {
				t.Errorf("entries: %+v", got)
			}
			got := names(t, root)
			if len(got) != 1 || !strings.HasPrefix(got[0], FileName+".unreadable-") {
				t.Fatalf("folder holds %v", got)
			}
			aside := got[0]
			stamp := strings.TrimPrefix(aside, FileName+".unreadable-")
			if _, err := time.Parse("20060102T150405Z", stamp); err != nil {
				t.Errorf("set-aside name %q: %v", aside, err)
			}
			n := l.Notice()
			for _, part := range []string{"server list: " + path + " cannot be read (", "); set aside as " + aside + "; starting with this computer only"} {
				if !strings.Contains(n, part) {
					t.Errorf("notice %q lacks %q", n, part)
				}
			}
			if strings.Count(n, path) != 1 {
				t.Errorf("notice names the path more than once: %q", n)
			}
			if strings.Contains(n, "s3cret-one") {
				t.Errorf("notice holds the secret: %q", n)
			}

			// A later Add writes a new file; the one set aside keeps its bytes.
			a, err := l.Add(studio())
			if err != nil {
				t.Fatal(err)
			}
			checkFile(t, root)
			if c.dir {
				if b, err := os.ReadFile(filepath.Join(root, aside, "inside")); err != nil || string(b) != "kept" {
					t.Errorf("the folder set aside: %q, %v", b, err)
				}
			} else {
				os.Chmod(filepath.Join(root, aside), 0o600)
				if b, err := os.ReadFile(filepath.Join(root, aside)); err != nil || string(b) != c.content {
					t.Errorf("the file set aside holds %q, %v", b, err)
				}
			}
			again := open(t, root)
			if got := again.Entries(); len(got) != 1 || got[0] != a || again.Notice() != "" {
				t.Errorf("after reopen: %+v, notice %q", got, again.Notice())
			}
			if len(names(t, root)) != 2 {
				t.Errorf("folder holds %v", names(t, root))
			}
		})
	}
}

// Unknown fields, in the file and in an entry, do not make a file unreadable.
func TestListUnknownFieldsIgnored(t *testing.T) {
	root := t.TempDir()
	content := `{"version":1,"later":true,"servers":[{"id":"s_3f9a1c2b77de","name":"Studio","address":"https://mac.local:4748",
		"secret":"s3cret-one","selfSigned":true,"pin":"` + pinA + `","instanceId":"` + uuid + `","color":"red"}]}`
	if err := os.WriteFile(filepath.Join(root, FileName), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	l := open(t, root)
	want := studio()
	want.ID, want.InstanceID = "s_3f9a1c2b77de", uuid
	if got := l.Entries(); len(got) != 1 || got[0] != want || l.Notice() != "" {
		t.Errorf("entries %+v, notice %q", got, l.Notice())
	}
}

func TestListSetAsideTwice(t *testing.T) {
	at := time.Date(2026, 3, 4, 5, 6, 7, 0, time.FixedZone("x", 3600))
	now = func() time.Time { return at }
	t.Cleanup(func() { now = time.Now })

	root := t.TempDir()
	path := filepath.Join(root, FileName)
	base := FileName + ".unreadable-20260304T040607Z"
	for i, want := range []string{base, base + "-2", base + "-3"} {
		content := strings.Repeat("x", i+1)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		l := open(t, root)
		if !strings.Contains(l.Notice(), "set aside as "+want+";") {
			t.Errorf("notice %q, want the name %s", l.Notice(), want)
		}
		if b, err := os.ReadFile(filepath.Join(root, want)); err != nil || string(b) != content {
			t.Errorf("%s holds %q, %v", want, b, err)
		}
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("the file is still there: %v", err)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(root, base)); string(b) != "x" {
		t.Errorf("the first file set aside was overwritten: %q", b)
	}
}

// When the file cannot be renamed, the list works in memory and every write returns the error.
func TestListSetAsideFails(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root renames in a read-only folder")
	}
	root := t.TempDir()
	path := filepath.Join(root, FileName)
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(root, 0o700) })

	l := open(t, root)
	if len(l.Entries()) != 0 || !strings.Contains(l.Notice(), "could not be set aside") {
		t.Errorf("entries %+v, notice %q", l.Entries(), l.Notice())
	}
	_, err := l.Add(studio())
	if err == nil || !strings.Contains(err.Error(), "could not be set aside") {
		t.Errorf("Add: %v", err)
	}
	if len(l.Entries()) != 0 {
		t.Errorf("a refused write changed the list: %+v", l.Entries())
	}
	os.Chmod(root, 0o700)
	if _, err2 := l.Add(studio()); err2 == nil || err2.Error() != err.Error() {
		t.Errorf("a later Add: %v, want the same error", err2)
	}
	if b, _ := os.ReadFile(path); string(b) != "{not json" {
		t.Errorf("the unreadable file was overwritten: %q", b)
	}
}

func TestListDuplicateAddress(t *testing.T) {
	l := open(t, t.TempDir())
	a, err := l.Add(studio())
	if err != nil {
		t.Fatal(err)
	}
	_, err = l.Add(Entry{Name: "Again", Address: "HTTPS://MAC.LOCAL:4748/", Secret: "other"})
	var dup *DuplicateError
	if !errors.As(err, &dup) || dup.Name != "Studio" || err.Error() != "already added as Studio" {
		t.Fatalf("Add of the same address: %v", err)
	}
	b, err := l.Add(Entry{Name: "Office", Address: "https://mac.local:4749", Secret: "other"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.Update(b.ID, func(e *Entry) error { e.Address = a.Address; return nil }); !errors.As(err, &dup) || dup.Name != "Studio" {
		t.Errorf("an edit to the other's address: %v", err)
	}
	if got, _ := l.Get(b.ID); got != b {
		t.Errorf("the refused edit changed the entry: %+v", got)
	}
	// An entry is no duplicate of itself.
	if _, err := l.Update(a.ID, func(e *Entry) error { e.Name = "Studio 2"; return nil }); err != nil {
		t.Errorf("an edit that keeps the address: %v", err)
	}
	if len(l.Entries()) != 2 {
		t.Errorf("entries: %+v", l.Entries())
	}
}

func TestListPinClearedWithoutBox(t *testing.T) {
	root := t.TempDir()
	l := open(t, root)
	e := studio()
	e.SelfSigned = false
	a, err := l.Add(e)
	if err != nil {
		t.Fatal(err)
	}
	if a.Pin != "" {
		t.Errorf("Add without the box kept the pin %q", a.Pin)
	}
	// Without the box the pin is not even read.
	if _, err := l.Update(a.ID, func(e *Entry) error { e.Pin = "garbage"; return nil }); err != nil {
		t.Errorf("a pin without the box: %v", err)
	}
	a, err = l.Update(a.ID, func(e *Entry) error { e.SelfSigned, e.Pin = true, strings.ToLower(pinA); return nil })
	if err != nil || a.Pin != pinA || !a.SelfSigned {
		t.Fatalf("box on with a pin: %+v, %v", a, err)
	}
	a, err = l.Update(a.ID, func(e *Entry) error { e.SelfSigned = false; return nil })
	if err != nil || a.Pin != "" {
		t.Fatalf("box off: %+v, %v", a, err)
	}
	if got := open(t, root).Entries(); len(got) != 1 || got[0].Pin != "" || got[0].SelfSigned {
		t.Errorf("after reopen: %+v", got)
	}
	// Box on with no pin is a valid entry: the fingerprint is not accepted yet.
	a, err = l.Update(a.ID, func(e *Entry) error { e.SelfSigned = true; return nil })
	if err != nil || a.Pin != "" || !a.SelfSigned {
		t.Errorf("box on, no pin: %+v, %v", a, err)
	}

	// A file with a pin and no box is read with the pin dropped.
	root = t.TempDir()
	content := `{"version":1,"servers":[{"id":"s_3f9a1c2b77de","name":"Studio","address":"https://mac.local:4748","secret":"x","selfSigned":false,"pin":"` + pinA + `"}]}`
	if err := os.WriteFile(filepath.Join(root, FileName), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	l = open(t, root)
	if got := l.Entries(); len(got) != 1 || got[0].Pin != "" || l.Notice() != "" {
		t.Errorf("from the file: %+v, notice %q", got, l.Notice())
	}
}

func TestListConcurrentUse(t *testing.T) {
	l := open(t, t.TempDir())
	done := make(chan struct{})
	for i := 0; i < 4; i++ {
		go func(i int) {
			defer func() { done <- struct{}{} }()
			for j := 0; j < 10; j++ {
				e, err := l.Add(Entry{Name: "n", Address: "https://h" + string(rune('a'+i)) + ".local:" + string(rune('1'+j%9)) + "000", Secret: "x"})
				if err != nil {
					continue // an address used before
				}
				l.Entries()
				l.Update(e.ID, func(e *Entry) error { e.Name = "m"; return nil })
				l.Get(e.ID)
				l.Notice()
			}
		}(i)
	}
	for i := 0; i < 4; i++ {
		<-done
	}
	if got := len(l.Entries()); got != 36 {
		t.Errorf("%d entries, want 36", got)
	}
}
