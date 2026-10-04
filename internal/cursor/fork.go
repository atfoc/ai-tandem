package cursor

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"

	"ai-whiteboard/internal/agent"
)

var _ agent.Forker = (*Spawner)(nil)

// Error texts of a fork's store copy, besides those of the context meter.
const (
	errNoForkPoint   = "no fork point recorded for that turn"
	errForkPointGone = "Cursor no longer has that point of the conversation"
)

// forkBackupTimeout bounds the backup of a store (tens of megabytes for a long session; the
// meter's sqliteTimeout is for small reads). The fork's time box ends it earlier.
const forkBackupTimeout = 30 * time.Second

var sessionIDRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// newSessionID is a fresh uuid v4, the shape of Cursor's own session ids.
func newSessionID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// SpawnFork starts the process of o on a fork of src. Cursor has no fork over ACP, so the fork is
// a copy of the source's session store under a new id (copyStore), which a process started like
// Spawn's then loads as a resume does: initialize → authenticate → session/load with this
// process's own mcpServers → the model list → applyChoice. It returns once that handshake has
// finished. The copy and the handshake share one time box, agent.ForkTimeout; on a failure or a
// time-out the process is closed and the copy removed.
func (s *Spawner) SpawnFork(o agent.SpawnOptions, src agent.ForkSource) (agent.Agent, string, error) {
	if fi, err := os.Stat(o.Cwd); err != nil || !fi.IsDir() {
		return nil, "", agent.ErrFolderMissing
	}
	limit := agent.ForkTimeout
	if s.forkTimeout > 0 {
		limit = s.forkTimeout
	}
	deadline := time.Now().Add(limit)

	id, err := s.copyStore(src, o.Cwd, deadline)
	if err != nil {
		return nil, "", err
	}
	dir := filepath.Dir(StorePath(s.Home, id))
	o.SessionID, o.Resume = id, true
	p, err := s.start(o, deadline)
	if err != nil {
		os.RemoveAll(dir)
		return nil, "", err
	}
	// The deadline ends each call of the handshake; the box also covers what is not a call (the
	// meter read that ends a resume's handshake).
	box := time.NewTimer(time.Until(deadline))
	defer box.Stop()
	select {
	case <-p.ready:
		err = p.readyErr
	case <-box.C:
		err = fmt.Errorf("Cursor did not load the fork within %s", limit)
	}
	if err == nil {
		p.conn.SetDeadline(time.Time{}) // the chat's own calls have no limit
		return p, id, nil
	}
	// Close can wait for the process forever (when its children hold its output), so it runs in
	// the background and is waited for only as long as the box lasts.
	closed := make(chan struct{})
	go func() {
		p.Close()
		os.RemoveAll(dir) // again: until it ended, the process could write there
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(time.Until(deadline)):
	}
	os.RemoveAll(dir)
	return nil, "", err
}

// DiscardFork removes the store copy of a fork that is given up after SpawnFork succeeded and its
// process was closed: the session directory of sessionID. An id that is not a uuid names nothing
// SpawnFork made, and nothing is removed.
func (s *Spawner) DiscardFork(sessionID string) {
	if !sessionIDRe.MatchString(sessionID) {
		return
	}
	dir := filepath.Dir(StorePath(s.Home, sessionID))
	if _, err := os.Stat(dir); err != nil {
		return
	}
	if err := os.RemoveAll(dir); err != nil {
		log.Printf("cursor: remove fork store %s: %v", dir, err)
	}
}

// copyStore makes the session store of a fork of src and returns the fork's session id, a new
// uuid: a SQLite backup of the source's store.db in a new session directory, whose meta row names
// the new id and, unless the fork is at the source's end, src.Point as the latest root; and a
// meta.json sidecar like the source's (for cwd when the source has none). The root must be a blob
// of the copy: session/load would not report a missing one, it silently starts a new
// conversation. The source is only read. On an error nothing is left behind.
//
// Everything goes through the sqlite3 CLI, like the context meter, and ends at deadline.
func (s *Spawner) copyStore(src agent.ForkSource, cwd string, deadline time.Time) (id string, err error) {
	srcDB, err := filepath.Abs(StorePath(s.Home, src.SessionID))
	if err != nil {
		return "", errors.New(errStoreNotFound)
	}
	if _, err := os.Stat(srcDB); err != nil {
		return "", errors.New(errStoreNotFound)
	}
	sqlite, err := exec.LookPath(s.sqlite())
	if err == nil {
		sqlite, err = filepath.Abs(sqlite)
	}
	if err != nil {
		return "", errors.New(errSQLiteNotFound)
	}
	if !src.End {
		if src.Point == "" {
			return "", errors.New(errNoForkPoint)
		}
		if !blobIDRe.MatchString(src.Point) {
			return "", errors.New(errForkPointGone)
		}
	}

	id = newSessionID()
	dir := filepath.Dir(StorePath(s.Home, id))
	if err := os.Mkdir(dir, 0o700); err != nil {
		return "", fmt.Errorf("cannot create the Cursor session of the fork: %w", err)
	}
	defer func() {
		if err != nil {
			os.RemoveAll(dir)
		}
	}()
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()

	// SQLite's backup, never a file copy: while the source's process is alive the main file is an
	// empty page and everything is in the WAL. no_ckpt_on_close keeps this connection from
	// writing a WAL the process left behind into the source's store.db when it closes. The
	// destination is named relative to dir, so no path is quoted into the dot-command.
	backup, stop := context.WithTimeout(ctx, forkBackupTimeout)
	_, err = runSQLiteCtx(backup, sqlite, dir, srcDB, ".dbconfig no_ckpt_on_close on", ".timeout 5000", ".backup store.db")
	stop()
	if err != nil {
		return "", err
	}

	// The meta row: the SQL is built from hex and a checked blob id only.
	db := filepath.Join(dir, "store.db")
	out, err := runSQLiteCtx(ctx, sqlite, "", db, "SELECT value FROM meta WHERE key = '0';")
	if err != nil {
		return "", err
	}
	metaJSON, err := hex.DecodeString(out)
	if err != nil || len(metaJSON) == 0 {
		return "", errors.New(errStoreFormat)
	}
	var meta map[string]json.RawMessage // every other key is kept as it is
	if err := json.Unmarshal(metaJSON, &meta); err != nil || meta == nil {
		return "", errors.New(errStoreFormat)
	}
	meta["agentId"] = mustJSON(id)
	if !src.End {
		meta["latestRootBlobId"] = mustJSON(src.Point)
	}
	var root string
	if json.Unmarshal(meta["latestRootBlobId"], &root) != nil || !blobIDRe.MatchString(root) {
		return "", errors.New(errForkPointGone)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(meta); err != nil {
		return "", errors.New(errStoreFormat)
	}
	out, err = runSQLiteCtx(ctx, sqlite, "", db,
		"UPDATE meta SET value = '"+hex.EncodeToString(bytes.TrimSpace(buf.Bytes()))+"' WHERE key = '0'; "+
			"SELECT 1 FROM blobs WHERE id = '"+root+"';")
	if err != nil {
		return "", err
	}
	if out != "1" {
		return "", errors.New(errForkPointGone)
	}

	side, err := os.ReadFile(filepath.Join(filepath.Dir(srcDB), "meta.json"))
	var fields map[string]json.RawMessage
	if err != nil || json.Unmarshal(side, &fields) != nil || fields == nil {
		side = mustJSON(map[string]any{"schemaVersion": 1, "cwd": cwd})
	}
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), side, 0o644); err != nil {
		return "", fmt.Errorf("cannot write the Cursor session of the fork: %w", err)
	}
	return id, nil
}
