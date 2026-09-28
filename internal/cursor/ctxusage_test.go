package cursor

import (
	"crypto/md5"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

const testSessionID = "0f4c2d9e-1a2b-4c3d-8e9f-001122334455"

var testBlobID = "3b1f0c9a7e5d2b4f6a8c0e1d3f5b7a9c2e4d6f8a0b1c3d5e7f9a1b2c3d4e5f60"

func pbVarint(v uint64) []byte {
	var b []byte
	for v >= 0x80 {
		b = append(b, byte(v)|0x80)
		v >>= 7
	}
	return append(b, byte(v))
}

func pbKey(num, wt int) []byte { return pbVarint(uint64(num<<3 | wt)) }

func pbUint(num int, v uint64) []byte { return append(pbKey(num, wireVarint), pbVarint(v)...) }

func pbBytes(num int, b []byte) []byte {
	out := append(pbKey(num, wireBytes), pbVarint(uint64(len(b)))...)
	return append(out, b...)
}

func cat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// sampleRoot is a ConversationStateStructure-like root blob: other fields around a field 5
// token_details {used_tokens, max_tokens}.
func sampleRoot(used, max uint64) []byte {
	details := cat(pbUint(1, used), pbUint(2, max))
	return cat(
		pbBytes(1, []byte("some turn data")),
		pbUint(3, 42),
		pbKey(4, wireFixed64), []byte{1, 2, 3, 4, 5, 6, 7, 8},
		pbBytes(5, details),
		pbBytes(5, cat(pbUint(1, 1), pbUint(2, 2))), // a later field 5 is ignored
		pbBytes(8, []byte("tail")),
	)
}

func needSQLite(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("sqlite3"); err != nil {
		t.Skip("sqlite3 not found")
	}
}

// makeStore creates <home>/.cursor/acp-sessions/<id>/store.db and runs sql in it.
func makeStore(t *testing.T, home, sql string) {
	t.Helper()
	makeStoreAt(t, StorePath(home, testSessionID), sql)
}

// makeStoreAt creates a store at db and runs sql in it.
func makeStoreAt(t *testing.T, db, sql string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(db), 0o755); err != nil {
		t.Fatal(err)
	}
	schema := "PRAGMA journal_mode=WAL; CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs(id TEXT PRIMARY KEY, data BLOB);"
	if out, err := exec.Command("sqlite3", db, schema+sql).CombinedOutput(); err != nil {
		t.Fatalf("sqlite3: %v: %s", err, out)
	}
}

func metaRow(json string) string {
	return "INSERT INTO meta VALUES('0', '" + hex.EncodeToString([]byte(json)) + "');"
}

func blobRow(id string, data []byte) string {
	return "INSERT INTO blobs VALUES('" + id + "', X'" + hex.EncodeToString(data) + "');"
}

func goodMeta() string { return metaRow(`{"latestRootBlobId":"` + testBlobID + `","other":1}`) }

func TestReadContextUsage(t *testing.T) {
	needSQLite(t)
	t.Setenv("CURSOR_CONFIG_DIR", "")
	home := t.TempDir()
	makeStore(t, home, goodMeta()+blobRow(testBlobID, sampleRoot(15989, 272000)))

	u, err := ReadContextUsage("sqlite3", home, testSessionID)
	if err != nil {
		t.Fatalf("ReadContextUsage: %v", err)
	}
	if u != (ContextUsage{Used: 15989, Max: 272000}) {
		t.Fatalf("got %+v, want {15989 272000}", u)
	}
}

func TestReadContextUsageErrors(t *testing.T) {
	needSQLite(t)
	t.Setenv("CURSOR_CONFIG_DIR", "")
	const format = "Cursor session store has an unexpected format"
	good := sampleRoot(15989, 272000)

	cases := []struct {
		name    string
		sql     string // "" = no store.db at all
		sqlite  string
		wantErr string
	}{
		{"no store.db", "", "sqlite3", "Cursor session store not found"},
		{"sqlite3 missing", goodMeta() + blobRow(testBlobID, good), "/nonexistent", "sqlite3 not found; the context meter needs it"},
		{"no meta row", blobRow(testBlobID, good), "sqlite3", format},
		{"meta not hex", "INSERT INTO meta VALUES('0', 'not hex at all');" + blobRow(testBlobID, good), "sqlite3", format},
		{"meta not json", metaRow("not json") + blobRow(testBlobID, good), "sqlite3", format},
		{"blob id with quote", metaRow(`{"latestRootBlobId":"x' OR '1'='1"}`) + blobRow(testBlobID, good), "sqlite3", format},
		{"no blob row", goodMeta(), "sqlite3", format},
		{"blob without field 5", goodMeta() + blobRow(testBlobID, cat(pbBytes(1, []byte("x")), pbUint(3, 7))), "sqlite3", format},
		{"used_tokens 0", goodMeta() + blobRow(testBlobID, cat(pbBytes(5, cat(pbUint(1, 0), pbUint(2, 272000))))), "sqlite3", format},
		{"max_tokens 0", goodMeta() + blobRow(testBlobID, cat(pbBytes(5, pbUint(1, 15989)))), "sqlite3", format},
		{"truncated blob", goodMeta() + blobRow(testBlobID, cat(pbKey(1, wireBytes), pbVarint(100), []byte("short"))), "sqlite3", format},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			home := t.TempDir()
			if c.sql != "" {
				makeStore(t, home, c.sql)
			}
			_, err := ReadContextUsage(c.sqlite, home, testSessionID)
			if err == nil {
				t.Fatalf("got no error, want %q", c.wantErr)
			}
			if err.Error() != c.wantErr {
				t.Fatalf("got %q, want %q", err.Error(), c.wantErr)
			}
		})
	}
}

func TestReadContextUsageSQLiteFails(t *testing.T) {
	needSQLite(t)
	t.Setenv("CURSOR_CONFIG_DIR", "")
	home := t.TempDir()
	db := StorePath(home, testSessionID)
	if err := os.MkdirAll(filepath.Dir(db), 0o755); err != nil {
		t.Fatal(err)
	}
	// Not a database: sqlite3 exits non-zero.
	if err := os.WriteFile(db, []byte("this is not a sqlite database, just some bytes to fail on"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := ReadContextUsage("sqlite3", home, testSessionID)
	if err == nil {
		t.Fatal("got no error")
	}
	const prefix = "Cannot read Cursor session store: "
	if len(err.Error()) <= len(prefix) || err.Error()[:len(prefix)] != prefix {
		t.Fatalf("got %q, want prefix %q", err.Error(), prefix)
	}
}

func TestStorePath(t *testing.T) {
	t.Setenv("CURSOR_CONFIG_DIR", "")
	if got, want := StorePath("/home/u", "abc"), "/home/u/.cursor/acp-sessions/abc/store.db"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	t.Setenv("CURSOR_CONFIG_DIR", "/cfg/cursor")
	if got, want := StorePath("/home/u", "abc"), "/cfg/cursor/acp-sessions/abc/store.db"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestChildStorePath(t *testing.T) {
	hash := func(s string) string { sum := md5.Sum([]byte(s)); return hex.EncodeToString(sum[:]) }

	t.Setenv("CURSOR_CONFIG_DIR", "")
	cwd := "/no/such/project"
	if got, want := ChildStorePath("/home/u", cwd, "S1"), "/home/u/.cursor/chats/"+hash(cwd)+"/S1/store.db"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	t.Setenv("CURSOR_CONFIG_DIR", "/cfg/cursor")
	if got, want := ChildStorePath("/home/u", cwd, "S1"), "/cfg/cursor/chats/"+hash(cwd)+"/S1/store.db"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}

	// A symlinked cwd: the hash is of the resolved path.
	t.Setenv("CURSOR_CONFIG_DIR", "")
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(real) // the temp dir itself may sit behind a symlink
	if err != nil {
		t.Fatal(err)
	}
	if hash(resolved) == hash(link) {
		t.Fatal("test setup: link and target hash the same")
	}
	if got, want := ChildStorePath("/home/u", link, "S2"), "/home/u/.cursor/chats/"+hash(resolved)+"/S2/store.db"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// splitCategory is one category of token_details' breakdown: id, label, tokens (left out when
// 0, as Cursor does), characters.
func splitCategory(id, label string, tokens, chars uint64) []byte {
	b := cat(pbBytes(1, []byte(id)), pbBytes(2, []byte(label)))
	if tokens > 0 {
		b = cat(b, pbUint(3, tokens))
	}
	return pbBytes(3, cat(b, pbUint(4, chars)))
}

// splitRoot is a root blob whose token_details has a breakdown (field 3) as Cursor writes it.
func splitRoot() []byte {
	breakdown := cat(pbUint(1, 3230), pbUint(2, 272000),
		splitCategory("system_prompt", "System prompt", 3230, 14423),
		splitCategory("rules", "Rules", 0, 0),
		splitCategory("conversation", "Conversation", 191, 877))
	details := cat(pbUint(1, 3421), pbUint(2, 272000), pbBytes(3, breakdown))
	return cat(pbBytes(1, []byte("turn")), pbBytes(5, details), pbBytes(8, []byte("tail")))
}

func TestReadContextSplit(t *testing.T) {
	needSQLite(t)
	t.Setenv("CURSOR_CONFIG_DIR", "")
	home := t.TempDir()
	makeStore(t, home, goodMeta()+blobRow(testBlobID, splitRoot()))

	s, err := (&Spawner{Home: home}).ReadContextSplit(agent.SpawnOptions{SessionID: testSessionID})
	if err != nil {
		t.Fatal(err)
	}
	want := model.ContextSplit{Total: 3421, Window: 272000, Categories: []model.ContextCategory{
		{ID: "system_prompt", Label: "System prompt", Tokens: 3230, Kind: "used", Chars: 14423},
		{ID: "rules", Label: "Rules", Kind: "used"},
		{ID: "conversation", Label: "Conversation", Tokens: 191, Kind: "used", Chars: 877},
		{ID: "free", Label: "Free space", Tokens: 272000 - 3421, Kind: "free"},
	}}
	if !reflect.DeepEqual(s, want) {
		t.Fatalf("got %+v\nwant %+v", s, want)
	}
}

func TestReadContextSplitErrors(t *testing.T) {
	needSQLite(t)
	t.Setenv("CURSOR_CONFIG_DIR", "")
	const format = "Cursor session store has an unexpected format"
	for name, root := range map[string][]byte{
		"no breakdown":        sampleRoot(15989, 272000),
		"breakdown not bytes": cat(pbBytes(5, cat(pbUint(1, 10), pbUint(2, 100), pbUint(3, 7)))),
		"empty breakdown":     cat(pbBytes(5, cat(pbUint(1, 10), pbUint(2, 100), pbBytes(3, pbUint(1, 10))))),
		"bad category":        cat(pbBytes(5, cat(pbUint(1, 10), pbUint(2, 100), pbBytes(3, pbBytes(3, cat(pbKey(1, wireBytes), pbVarint(50))))))),
	} {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			makeStore(t, home, goodMeta()+blobRow(testBlobID, root))
			_, err := (&Spawner{Home: home}).ReadContextSplit(agent.SpawnOptions{SessionID: testSessionID})
			if err == nil || err.Error() != format {
				t.Fatalf("err %v, want %q", err, format)
			}
		})
	}
	if _, err := (&Spawner{Home: t.TempDir()}).ReadContextSplit(agent.SpawnOptions{SessionID: testSessionID}); err == nil ||
		err.Error() != "Cursor session store not found" {
		t.Fatalf("no store: err %v", err)
	}
}

func TestReadContextUsageWithSplit(t *testing.T) {
	// The meter's read is unchanged by the breakdown next to the counts.
	u, ok := decodeTokenDetails(splitRoot())
	if !ok || u != (ContextUsage{Used: 3421, Max: 272000}) {
		t.Fatalf("got %+v %v", u, ok)
	}
}
