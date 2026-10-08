package cursor

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

var (
	testBlobID2 = "9d2c4e6f8a0b1c3d5e7f9a1b2c3d4e5f603b1f0c9a7e5d2b4f6a8c0e1d3f5b7a"
	testBlobID3 = "c3d5e7f9a1b2c3d4e5f603b1f0c9a7e5d2b4f6a8c0e1d3f5b7a9d2c4e6f8a0b1"
)

// forkMeta is a source store's meta row as Cursor writes it: its own id, the latest root and the
// keys a fork must keep.
func forkMeta(root string) string {
	return `{"agentId":"` + testSessionID + `","latestRootBlobId":"` + root + `","name":"A <b> & c chat","createdAt":1759500000123,"mode":"default","isRunEverything":false}`
}

// query runs sql on the store at db with the sqlite3 CLI and returns its trimmed output.
func query(t *testing.T, db, sql string) string {
	t.Helper()
	out, err := exec.Command("sqlite3", db, sql).CombinedOutput()
	if err != nil {
		t.Fatalf("sqlite3 %s: %v: %s", sql, err, out)
	}
	return strings.TrimSpace(string(out))
}

// holdStore opens the store at db in another sqlite3 process, runs sql there and keeps it open
// until the test ends (or kill is called): what sql wrote is in the WAL only, as everything is
// while the session's `agent acp` lives. kill ends the process without a checkpoint.
func holdStore(t *testing.T, db, sql string) (kill func()) {
	t.Helper()
	cmd := exec.Command("sqlite3", db)
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		in.Close()
		cmd.Wait()
	})
	io.WriteString(in, "PRAGMA wal_autocheckpoint=0;\n"+sql+"\nSELECT 'held';\n")
	sc := bufio.NewScanner(out)
	for sc.Scan() {
		if sc.Text() == "held" {
			return func() {
				cmd.Process.Kill()
				cmd.Wait()
			}
		}
	}
	t.Fatal("the sqlite3 process holding the store did not answer")
	return nil
}

// storeMeta decodes the meta row '0' of the store at db.
func storeMeta(t *testing.T, db string) map[string]any {
	t.Helper()
	b, err := hex.DecodeString(query(t, db, "SELECT value FROM meta WHERE key = '0';"))
	if err != nil {
		t.Fatalf("meta row is not hex: %v", err)
	}
	var m map[string]any
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	if err := d.Decode(&m); err != nil {
		t.Fatalf("meta row %s: %v", b, err)
	}
	return m
}

// sessions lists the session directories of home's (or $CURSOR_CONFIG_DIR's) store.
func sessions(t *testing.T, home string) []string {
	t.Helper()
	es, err := os.ReadDir(filepath.Dir(filepath.Dir(StorePath(home, "x"))))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var out []string
	for _, e := range es {
		out = append(out, e.Name())
	}
	return out
}

const allBlobs = "SELECT group_concat(id || ':' || hex(data), ' ') FROM (SELECT id, data FROM blobs ORDER BY id);"

// The sqlite3 CLI check: its .backup copies a WAL-mode store that another process holds open,
// rows that are only in the WAL included, and the meta row of the copy can be rewritten.
func TestForkStoreCopy(t *testing.T) {
	needSQLite(t)
	// A config dir whose path would need quoting in a dot-command or in SQL.
	cfg := filepath.Join(t.TempDir(), "it's a config dir")
	t.Setenv("CURSOR_CONFIG_DIR", cfg)
	s := &Spawner{Home: filepath.Join(t.TempDir(), "unused")}
	src := StorePath(s.Home, testSessionID)
	makeStoreAt(t, src, metaRow(forkMeta(testBlobID))+blobRow(testBlobID, sampleRoot(100, 272000)))
	sidecar := `{"schemaVersion":1,"cwd":"/some/project","title":"A chat"}`
	if err := os.WriteFile(filepath.Join(filepath.Dir(src), "meta.json"), []byte(sidecar), 0o644); err != nil {
		t.Fatal(err)
	}
	// Two more turns by the "live agent": the fork point and the new latest root are in the WAL.
	holdStore(t, src, blobRow(testBlobID2, sampleRoot(200, 272000))+blobRow(testBlobID3, sampleRoot(300, 272000))+
		"UPDATE meta SET value = '"+hex.EncodeToString([]byte(forkMeta(testBlobID3)))+"' WHERE key = '0';")
	before, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(before, []byte(testBlobID2)) {
		t.Fatal("test setup: the held rows are in the main file, not only in the WAL")
	}

	id, err := s.copyStore(agent.ForkSource{SessionID: testSessionID, Point: testBlobID2}, "/fork/cwd", time.Now().Add(20*time.Second))
	if err != nil {
		t.Fatalf("copyStore: %v", err)
	}
	after, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("the source store.db changed")
	}
	if !sessionIDRe.MatchString(id) || id == testSessionID {
		t.Fatalf("new session id %q", id)
	}
	dst := StorePath(s.Home, id)
	if fi, err := os.Stat(filepath.Dir(dst)); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("new session directory: %v, %v", fi, err)
	}

	if got, want := query(t, dst, allBlobs), query(t, src, allBlobs); got != want || strings.Count(got, ":") != 3 {
		t.Fatalf("blobs of the copy %q, of the source %q", got, want)
	}
	if got := query(t, dst, "PRAGMA integrity_check;"); got != "ok" {
		t.Fatalf("integrity_check: %s", got)
	}
	meta, srcMeta := storeMeta(t, dst), storeMeta(t, src)
	if meta["agentId"] != id || meta["latestRootBlobId"] != testBlobID2 {
		t.Fatalf("meta of the copy %v", meta)
	}
	if srcMeta["agentId"] != testSessionID || srcMeta["latestRootBlobId"] != testBlobID3 {
		t.Fatalf("meta of the source %v", srcMeta)
	}
	for _, m := range []map[string]any{meta, srcMeta} {
		delete(m, "agentId")
		delete(m, "latestRootBlobId")
	}
	if len(meta) != 4 || !reflect.DeepEqual(meta, srcMeta) {
		t.Fatalf("other meta keys of the copy %v, of the source %v", meta, srcMeta)
	}
	if b, err := os.ReadFile(filepath.Join(filepath.Dir(dst), "meta.json")); err != nil || string(b) != sidecar {
		t.Fatalf("meta.json %q, %v", b, err)
	}
	// The copy is a session the meter reads: its root is the fork point.
	if u, root, err := readUsageRootAt("sqlite3", dst); err != nil || root != testBlobID2 || u.Used != 200 {
		t.Fatalf("read of the copy: %+v %q %v", u, root, err)
	}
	if after, _ = os.ReadFile(src); !bytes.Equal(before, after) {
		t.Fatal("the source store.db changed")
	}
}

// A WAL that the source's process left behind is not written into the source's store.db by the
// copy's own connection closing.
func TestForkStoreCopyLeftoverWAL(t *testing.T) {
	needSQLite(t)
	t.Parallel()
	s := &Spawner{Home: t.TempDir()}
	src := StorePath(s.Home, testSessionID)
	makeStoreAt(t, src, metaRow(forkMeta(testBlobID))+blobRow(testBlobID, sampleRoot(100, 272000)))
	kill := holdStore(t, src, blobRow(testBlobID2, sampleRoot(200, 272000)))
	kill()
	before, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}

	// End with no point: the latest root stays the source's, and with no sidecar one is written
	// for the cwd.
	id, err := s.copyStore(agent.ForkSource{SessionID: testSessionID, End: true}, "/fork/cwd", time.Now().Add(20*time.Second))
	if err != nil {
		t.Fatalf("copyStore: %v", err)
	}
	if after, _ := os.ReadFile(src); !bytes.Equal(before, after) {
		t.Fatal("the source store.db changed")
	}
	dst := StorePath(s.Home, id)
	if got := query(t, dst, "SELECT count(*) FROM blobs;"); got != "2" {
		t.Fatalf("blobs in the copy: %s", got)
	}
	if meta := storeMeta(t, dst); meta["agentId"] != id || meta["latestRootBlobId"] != testBlobID {
		t.Fatalf("meta of the copy %v", meta)
	}
	b, err := os.ReadFile(filepath.Join(filepath.Dir(dst), "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	jsonEq(t, b, `{"schemaVersion":1,"cwd":"/fork/cwd"}`)
}

// A fork at the source's end is cut back to the recorded point like any other: the source may have
// gone on since the end was found. Only without a point is the latest root kept.
func TestForkStoreCopyEnd(t *testing.T) {
	needSQLite(t)
	t.Parallel()
	cases := []struct {
		name        string
		latest      string // the source's latest root when the copy is made
		point, want string
		wantUsedCtx int
	}{
		{"a later root of a running turn", testBlobID3, testBlobID2, testBlobID2, 200},
		{"the point is the latest root", testBlobID2, testBlobID2, testBlobID2, 200},
		{"no point", testBlobID3, "", testBlobID3, 300},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			s := &Spawner{Home: t.TempDir()}
			src := StorePath(s.Home, testSessionID)
			makeStoreAt(t, src, metaRow(forkMeta(testBlobID))+blobRow(testBlobID, sampleRoot(100, 272000)))
			// The "live agent" has ended a turn at testBlobID2 and, in the first case, has written a
			// root of the next one since.
			live := blobRow(testBlobID2, sampleRoot(200, 272000))
			if c.latest == testBlobID3 {
				live += blobRow(testBlobID3, sampleRoot(300, 272000))
			}
			holdStore(t, src, live+"UPDATE meta SET value = '"+hex.EncodeToString([]byte(forkMeta(c.latest)))+"' WHERE key = '0';")
			before, err := os.ReadFile(src)
			if err != nil {
				t.Fatal(err)
			}

			id, err := s.copyStore(agent.ForkSource{SessionID: testSessionID, Point: c.point, End: true}, "/fork/cwd", time.Now().Add(20*time.Second))
			if err != nil {
				t.Fatalf("copyStore: %v", err)
			}
			dst := StorePath(s.Home, id)
			if meta := storeMeta(t, dst); meta["agentId"] != id || meta["latestRootBlobId"] != c.want {
				t.Fatalf("meta of the copy %v", meta)
			}
			if got, want := query(t, dst, allBlobs), query(t, src, allBlobs); got != want {
				t.Fatalf("blobs of the copy %q, of the source %q", got, want)
			}
			if u, root, err := readUsageRootAt("sqlite3", dst); err != nil || root != c.want || u.Used != c.wantUsedCtx {
				t.Fatalf("read of the copy: %+v %q %v", u, root, err)
			}
			if meta := storeMeta(t, src); meta["agentId"] != testSessionID || meta["latestRootBlobId"] != c.latest {
				t.Fatalf("meta of the source %v", meta)
			}
			if after, _ := os.ReadFile(src); !bytes.Equal(before, after) {
				t.Fatal("the source store.db changed")
			}
		})
	}
}

func TestForkStoreCopyErrors(t *testing.T) {
	needSQLite(t)
	t.Parallel()
	good := metaRow(forkMeta(testBlobID)) + blobRow(testBlobID, sampleRoot(100, 272000))
	cases := []struct {
		name    string
		sql     string // "" = no store.db at all
		sqlite  string
		src     agent.ForkSource
		wantErr string
	}{
		{"no source store", "", "sqlite3", agent.ForkSource{Point: testBlobID}, "Cursor session store not found"},
		{"sqlite3 missing", good, "/nonexistent", agent.ForkSource{Point: testBlobID}, "sqlite3 not found; the context meter needs it"},
		{"no point", good, "sqlite3", agent.ForkSource{}, "no fork point recorded for that turn"},
		{"point is not a blob id", good, "sqlite3", agent.ForkSource{Point: "x' OR '1'='1"}, "Cursor no longer has that point of the conversation"},
		{"point not in the store", good, "sqlite3", agent.ForkSource{Point: testBlobID2}, "Cursor no longer has that point of the conversation"},
		{"end, point is not a blob id", good, "sqlite3", agent.ForkSource{Point: "x' OR '1'='1", End: true}, "Cursor no longer has that point of the conversation"},
		{"end, point not in the store", good, "sqlite3", agent.ForkSource{Point: testBlobID2, End: true}, "Cursor no longer has that point of the conversation"},
		{"end, root not in the store", metaRow(forkMeta(testBlobID2)) + blobRow(testBlobID, sampleRoot(100, 272000)), "sqlite3",
			agent.ForkSource{End: true}, "Cursor no longer has that point of the conversation"},
		{"end, no root in the meta row", metaRow(`{"agentId":"a"}`) + blobRow(testBlobID, sampleRoot(100, 272000)), "sqlite3",
			agent.ForkSource{End: true}, "Cursor no longer has that point of the conversation"},
		{"meta not json", metaRow("not json") + blobRow(testBlobID, sampleRoot(100, 272000)), "sqlite3",
			agent.ForkSource{Point: testBlobID}, "Cursor session store has an unexpected format"},
		{"no meta row", blobRow(testBlobID, sampleRoot(100, 272000)), "sqlite3",
			agent.ForkSource{Point: testBlobID}, "Cursor session store has an unexpected format"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			s := &Spawner{Home: t.TempDir(), SQLite: c.sqlite}
			if c.sql != "" {
				makeStore(t, s.Home, c.sql)
			}
			before := sessions(t, s.Home)
			c.src.SessionID = testSessionID
			id, err := s.copyStore(c.src, "/fork/cwd", time.Now().Add(20*time.Second))
			if err == nil || err.Error() != c.wantErr || id != "" {
				t.Fatalf("got %q, %v; want the error %q", id, err, c.wantErr)
			}
			if after := sessions(t, s.Home); !reflect.DeepEqual(after, before) {
				t.Fatalf("sessions %v, before %v", after, before)
			}
		})
	}
}

// A copy that cannot finish inside the time box is ended and leaves nothing.
func TestForkStoreCopyTimeout(t *testing.T) {
	needSQLite(t)
	t.Setenv("CURSOR_CONFIG_DIR", "")
	sh := filepath.Join(t.TempDir(), "sqlite3")
	if err := os.WriteFile(sh, []byte("#!/bin/sh\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := &Spawner{Home: t.TempDir(), SQLite: sh}
	makeStore(t, s.Home, metaRow(forkMeta(testBlobID))+blobRow(testBlobID, sampleRoot(100, 272000)))
	start := time.Now()
	_, err := s.copyStore(agent.ForkSource{SessionID: testSessionID, Point: testBlobID}, "/fork/cwd", start.Add(300*time.Millisecond))
	if err == nil || err.Error() != "Cannot read Cursor session store: timed out" {
		t.Fatalf("got %v", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("took %s", d)
	}
	if got := sessions(t, s.Home); !reflect.DeepEqual(got, []string{testSessionID}) {
		t.Fatalf("sessions %v", got)
	}
}

func TestCallDeadline(t *testing.T) {
	t.Parallel()
	f := fake(t, fakeScript{"slow": {{Hang: true}}})
	conn, err := Start(f.bin, []string{"acp"}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Call("initialize", initializeParams()); err != nil {
		t.Fatalf("a call answered before the deadline: %v", err)
	}
	conn.SetDeadline(time.Now().Add(200 * time.Millisecond))
	start := time.Now()
	if _, err := conn.Call("slow", map[string]any{}); err == nil || err.Error() != "slow: Cursor did not answer in time" {
		t.Fatalf("got %v", err)
	}
	if d := time.Since(start); d < 150*time.Millisecond || d > 5*time.Second {
		t.Fatalf("took %s", d)
	}
	// Past the deadline a call fails at once. With the limit removed a call waits again: the
	// fake, still hanging on "slow", answers nothing, and the call ends when the process does.
	if _, err := conn.Call("authenticate", map[string]any{}); err == nil {
		t.Fatal("a call after the deadline did not fail")
	}
	conn.SetDeadline(time.Time{})
	res := make(chan error, 1)
	go func() {
		_, err := conn.Call("authenticate", map[string]any{})
		res <- err
	}()
	select {
	case err := <-res:
		t.Fatalf("a call without a deadline returned: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	conn.Close()
	if err := <-res; err == nil || err.Error() != "authenticate: Cursor exited" {
		t.Fatalf("got %v", err)
	}
}

// waitEOF waits until the fake has recorded that its stdin was closed: the process was ended.
func waitEOF(t *testing.T, record string) []recorded {
	t.Helper()
	for stop := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		rs := readRecord(t, record)
		if rs[len(rs)-1].EOF {
			return rs
		}
		if time.Now().After(stop) {
			t.Fatalf("process not ended; it got %v", methods(rs))
		}
	}
}

const boardMCPServers = `[{"type":"http","name":"board","url":"http://localhost:6006/mcp","headers":[{"name":"Authorization","value":"Bearer ` + boardToken + `"}]}]`

func TestSpawnFork(t *testing.T) {
	needSQLite(t)
	t.Parallel()
	e := newEnv(t, fakeScript{"session/prompt": {{Result: raw(`{"stopReason":"end_turn"}`)}}})
	makeStore(t, e.home, metaRow(forkMeta(testBlobID2))+
		blobRow(testBlobID, sampleRoot(15989, 272000))+blobRow(testBlobID2, sampleRoot(20000, 272000)))
	src := StorePath(e.home, testSessionID)
	before, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}

	mcp := &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken}
	a, id, err := e.s.SpawnFork(agent.SpawnOptions{Cwd: e.cwd, MCP: mcp, BoardID: "board", Model: "claude-sonnet-5", Effort: "low"},
		agent.ForkSource{ChatID: "c1", SessionID: testSessionID, Point: testBlobID})
	if err != nil {
		t.Fatalf("SpawnFork: %v", err)
	}
	closed := false
	t.Cleanup(func() {
		if !closed {
			a.Close()
		}
	})
	if !sessionIDRe.MatchString(id) || id == testSessionID {
		t.Fatalf("session id %q", id)
	}
	if got := sessions(t, e.home); len(got) != 2 {
		t.Fatalf("sessions %v", got)
	}
	if after, _ := os.ReadFile(src); !bytes.Equal(before, after) {
		t.Fatal("the source store.db changed")
	}
	if meta := storeMeta(t, StorePath(e.home, id)); meta["agentId"] != id || meta["latestRootBlobId"] != testBlobID {
		t.Fatalf("meta of the fork %v", meta)
	}

	// The handshake has finished: everything it sent is recorded, a load of the new id with the
	// fork's own MCP servers and the model policy, and no session/new.
	rs := readRecord(t, e.record)
	if got := methods(rs); len(got) < 5 || !reflect.DeepEqual(got[:4], []string{"initialize", "authenticate", "session/load", "cursor/list_available_models"}) {
		t.Fatalf("methods %v", got)
	}
	onlyHandshakeMethods(t, rs, "session/load")
	if _, ok := find(rs, "session/new"); ok {
		t.Fatal("session/new was sent")
	}
	ld, _ := find(rs, "session/load")
	jsonEq(t, ld.Params, `{"sessionId":"`+id+`","cwd":`+string(mustMarshal(e.cwd))+`,"mcpServers":`+boardMCPServers+`}`)
	if got := sets(rs); !reflect.DeepEqual(got, []string{"model=claude-sonnet-5", "thinking=true", "context=1m", "effort=low"}) {
		t.Fatalf("sets %v", got)
	}
	if a.(*proc).conn.deadline.Load() != 0 {
		t.Fatal("the fork's time box still limits the chat's calls")
	}

	// Its events are those of a resume: the catalog and the fork's own meter. A turn then ends
	// with the fork's root.
	first := until(t, a, isKind(agent.EvUsage))
	if kinds(first) != "Catalog,Usage" || first[1].CtxIn != 15989 || first[1].CtxError != "" {
		t.Fatalf("events after the fork start %s: %+v", kinds(first), first[len(first)-1])
	}
	send(t, a, "hi")
	evs := until(t, a, isKind(agent.EvTurnEnd))
	if end := evs[len(evs)-1]; end.Error != "" || end.Point != testBlobID {
		t.Fatalf("turn end %+v", end)
	}
	pr, _ := find(readRecord(t, e.record), "session/prompt")
	var pp struct {
		SessionID string `json:"sessionId"`
	}
	if json.Unmarshal(pr.Params, &pp); pp.SessionID != id {
		t.Fatalf("prompt sent to session %q", pp.SessionID)
	}
	a.Close()
	closed = true
	until(t, a, isKind(agent.EvExit))

	// A later resume of the fork's id loads it.
	b := e.spawn(t, agent.SpawnOptions{SessionID: id, Resume: true})
	if u := until(t, b, isKind(agent.EvUsage)); u[len(u)-1].CtxIn != 15989 {
		t.Fatalf("resumed fork's usage %+v", u[len(u)-1])
	}
	var loads []string
	for _, r := range readRecord(t, e.record) {
		if r.Method == "session/load" {
			var p struct {
				SessionID string `json:"sessionId"`
			}
			json.Unmarshal(r.Params, &p)
			loads = append(loads, p.SessionID)
		}
	}
	if !reflect.DeepEqual(loads, []string{id, id}) {
		t.Fatalf("session/load of %v", loads)
	}
}

// A fork from a running source, at the finished boundary before its turn: the source's store has
// the rows of the running turn, in the WAL only, and a latest root of that turn. The fork loads a
// copy cut back to the point, takes a turn of its own, and leaves the source's store as it was.
func TestSpawnForkRunningSource(t *testing.T) {
	needSQLite(t)
	t.Parallel()
	e := newEnv(t, fakeScript{"session/prompt": {{Result: raw(`{"stopReason":"end_turn"}`)}}})
	// Two turns ended, at testBlobID and testBlobID2.
	makeStore(t, e.home, metaRow(forkMeta(testBlobID2))+
		blobRow(testBlobID, sampleRoot(15989, 272000))+blobRow(testBlobID2, sampleRoot(20000, 272000)))
	src := StorePath(e.home, testSessionID)
	// The third is running in the source's process: a root of it is the latest one.
	holdStore(t, src, blobRow(testBlobID3, sampleRoot(31000, 272000))+
		"UPDATE meta SET value = '"+hex.EncodeToString([]byte(forkMeta(testBlobID3)))+"' WHERE key = '0';")
	before, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(before, []byte(testBlobID3)) {
		t.Fatal("test setup: the held rows are in the main file, not only in the WAL")
	}

	a, id, err := e.s.SpawnFork(agent.SpawnOptions{Cwd: e.cwd}, agent.ForkSource{SessionID: testSessionID, Point: testBlobID2})
	if err != nil {
		t.Fatalf("SpawnFork: %v", err)
	}
	t.Cleanup(a.Close)
	dst := StorePath(e.home, id)
	if meta := storeMeta(t, dst); meta["agentId"] != id || meta["latestRootBlobId"] != testBlobID2 {
		t.Fatalf("meta of the fork %v", meta)
	}
	if got := query(t, dst, "PRAGMA integrity_check;"); got != "ok" {
		t.Fatalf("integrity_check: %s", got)
	}
	ld, _ := find(readRecord(t, e.record), "session/load")
	jsonEq(t, ld.Params, `{"sessionId":"`+id+`","cwd":`+string(mustMarshal(e.cwd))+`,"mcpServers":[]}`)

	// The fork's meter and its turn are at the point, not at the running turn's root.
	if u := until(t, a, isKind(agent.EvUsage)); u[len(u)-1].CtxIn != 20000 || u[len(u)-1].CtxError != "" {
		t.Fatalf("usage of the fork %+v", u[len(u)-1])
	}
	send(t, a, "hi")
	evs := until(t, a, isKind(agent.EvTurnEnd))
	if end := evs[len(evs)-1]; end.Error != "" || end.Point != testBlobID2 {
		t.Fatalf("turn end %+v", end)
	}
	pr, _ := find(readRecord(t, e.record), "session/prompt")
	var pp struct {
		SessionID string `json:"sessionId"`
	}
	if json.Unmarshal(pr.Params, &pp); pp.SessionID != id {
		t.Fatalf("prompt sent to session %q", pp.SessionID)
	}

	// The source is where it was: its file, and the running turn's root as its latest.
	if after, _ := os.ReadFile(src); !bytes.Equal(before, after) {
		t.Fatal("the source store.db changed")
	}
	if meta := storeMeta(t, src); meta["agentId"] != testSessionID || meta["latestRootBlobId"] != testBlobID3 {
		t.Fatalf("meta of the source %v", meta)
	}
}

// A fork at the source's end with no point recorded keeps the source's latest root.
func TestSpawnForkEnd(t *testing.T) {
	needSQLite(t)
	t.Parallel()
	e := newEnv(t, baseScript())
	makeStore(t, e.home, metaRow(forkMeta(testBlobID2))+
		blobRow(testBlobID, sampleRoot(15989, 272000))+blobRow(testBlobID2, sampleRoot(20000, 272000)))
	a, id, err := e.s.SpawnFork(agent.SpawnOptions{Cwd: e.cwd}, agent.ForkSource{SessionID: testSessionID, End: true})
	if err != nil {
		t.Fatalf("SpawnFork: %v", err)
	}
	t.Cleanup(a.Close)
	if meta := storeMeta(t, StorePath(e.home, id)); meta["agentId"] != id || meta["latestRootBlobId"] != testBlobID2 {
		t.Fatalf("meta of the fork %v", meta)
	}
	ld, _ := find(readRecord(t, e.record), "session/load")
	jsonEq(t, ld.Params, `{"sessionId":"`+id+`","cwd":`+string(mustMarshal(e.cwd))+`,"mcpServers":[]}`)
}

func TestSpawnForkTimeout(t *testing.T) {
	needSQLite(t)
	// Not parallel: the copy and the start of the fake should fit the first, short time box.
	waitsOutBox(t, 400*time.Millisecond, 20*time.Second, func(box time.Duration, short bool) bool {
		e := newEnv(t, fakeScript{"session/load": {{Hang: true}}})
		e.s.forkTimeout = box
		makeStore(t, e.home, metaRow(forkMeta(testBlobID))+blobRow(testBlobID, sampleRoot(15989, 272000)))

		start := time.Now()
		a, id, err := e.s.SpawnFork(agent.SpawnOptions{Cwd: e.cwd}, agent.ForkSource{SessionID: testSessionID, Point: testBlobID})
		d := time.Since(start)
		if err == nil || a != nil || id != "" {
			t.Fatalf("got %v, %q, %v", a, id, err)
		}
		if got := sessions(t, e.home); !reflect.DeepEqual(got, []string{testSessionID}) {
			t.Fatalf("sessions %v", got)
		}
		if short {
			// The box counts only when the fake got the load it never answers; the record is whole
			// once the fake has gone (SpawnFork does not wait for that past its box).
			fakeGone(t, e.fake)
			if _, got := find(readRecordSoFar(e.record), "session/load"); !got {
				if got := sessions(t, e.home); !reflect.DeepEqual(got, []string{testSessionID}) {
					t.Fatalf("sessions %v", got)
				}
				return false
			}
		}
		if d < box-100*time.Millisecond || d > box+5*time.Second {
			t.Fatalf("took %s in a box of %s", d, box)
		}
		rs := waitEOF(t, e.record)
		if got := methods(rs); !reflect.DeepEqual(got, []string{"initialize", "authenticate", "session/load"}) {
			t.Fatalf("methods %v", got)
		}
		// Still nothing once the process has gone.
		if got := sessions(t, e.home); !reflect.DeepEqual(got, []string{testSessionID}) {
			t.Fatalf("sessions %v", got)
		}
		return true
	})
}

func TestSpawnForkFailures(t *testing.T) {
	needSQLite(t)
	t.Parallel()
	good := metaRow(forkMeta(testBlobID)) + blobRow(testBlobID, sampleRoot(15989, 272000))

	t.Run("the load fails", func(t *testing.T) {
		e := newEnv(t, fakeScript{"session/load": {{Error: raw(`{"code":-32602,"message":"Invalid params","data":{"message":"Session not found"}}`)}}})
		makeStore(t, e.home, good)
		a, id, err := e.s.SpawnFork(agent.SpawnOptions{Cwd: e.cwd}, agent.ForkSource{SessionID: testSessionID, Point: testBlobID})
		if err == nil || !strings.HasPrefix(err.Error(), "session/load: Invalid params") || a != nil || id != "" {
			t.Fatalf("got %v, %q, %v", a, id, err)
		}
		if got := sessions(t, e.home); !reflect.DeepEqual(got, []string{testSessionID}) {
			t.Fatalf("sessions %v", got)
		}
		if rs := readRecord(t, e.record); !rs[len(rs)-1].EOF {
			t.Fatal("process not ended")
		}
	})
	t.Run("the point is gone", func(t *testing.T) {
		e := newEnv(t, baseScript())
		makeStore(t, e.home, good)
		_, _, err := e.s.SpawnFork(agent.SpawnOptions{Cwd: e.cwd}, agent.ForkSource{SessionID: testSessionID, Point: testBlobID2})
		if err == nil || err.Error() != "Cursor no longer has that point of the conversation" {
			t.Fatalf("got %v", err)
		}
		if got := sessions(t, e.home); !reflect.DeepEqual(got, []string{testSessionID}) {
			t.Fatalf("sessions %v", got)
		}
		if _, err := os.Stat(e.record); err == nil {
			t.Fatal("a process was started")
		}
	})
	t.Run("the folder is missing", func(t *testing.T) {
		e := newEnv(t, baseScript())
		makeStore(t, e.home, good)
		_, _, err := e.s.SpawnFork(agent.SpawnOptions{Cwd: filepath.Join(e.cwd, "gone")}, agent.ForkSource{SessionID: testSessionID, Point: testBlobID})
		if err != agent.ErrFolderMissing {
			t.Fatalf("got %v", err)
		}
		if got := sessions(t, e.home); !reflect.DeepEqual(got, []string{testSessionID}) {
			t.Fatalf("sessions %v", got)
		}
	})
}

func TestDiscardFork(t *testing.T) {
	t.Setenv("CURSOR_CONFIG_DIR", "")
	s := &Spawner{Home: t.TempDir()}
	fork := "5b0e7c1a-9d3f-4a62-8c17-2f4e6a8b0c1d"
	for _, id := range []string{testSessionID, fork} {
		db := StorePath(s.Home, id)
		if err := os.MkdirAll(filepath.Dir(db), 0o700); err != nil {
			t.Fatal(err)
		}
		for _, f := range []string{"store.db", "store.db-wal", "meta.json"} {
			if err := os.WriteFile(filepath.Join(filepath.Dir(db), f), []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	other := filepath.Join(s.Home, ".cursor", "cli-config.json")
	if err := os.WriteFile(other, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Ids that are not a uuid, with and without a path in them, remove nothing; nor does a uuid
	// that has no session.
	for _, id := range []string{"", "..", ".", "not-a-uuid", fork + "/..", "../acp-sessions/" + fork, fork + "/", "/" + fork,
		"0f4c2d9e-1a2b-4c3d-8e9f-00112233445", "00000000-0000-4000-8000-000000000000"} {
		s.DiscardFork(id)
		if got := sessions(t, s.Home); !reflect.DeepEqual(got, []string{testSessionID, fork}) {
			t.Fatalf("DiscardFork(%q) left the sessions %v", id, got)
		}
		if _, err := os.Stat(other); err != nil {
			t.Fatalf("DiscardFork(%q): %v", id, err)
		}
	}

	s.DiscardFork(fork)
	if got := sessions(t, s.Home); !reflect.DeepEqual(got, []string{testSessionID}) {
		t.Fatalf("sessions %v", got)
	}
	for _, f := range []string{StorePath(s.Home, testSessionID), other} {
		if _, err := os.Stat(f); err != nil {
			t.Fatal(err)
		}
	}
}
