package cursor

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"ai-whiteboard/internal/agent"
)

// ContextUsage is ConversationStateStructure.token_details of a session's latest root blob.
type ContextUsage struct{ Used, Max int }

// Error texts of ReadContextUsage; each is shown in the context meter as is.
const (
	errSQLiteNotFound = "sqlite3 not found; the context meter needs it"
	errStoreNotFound  = "Cursor session store not found"
	errStoreRead      = "Cannot read Cursor session store: "
	errStoreFormat    = "Cursor session store has an unexpected format"
)

// sqliteTimeout bounds each sqlite3 process.
const sqliteTimeout = 2 * time.Second

var blobIDRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// StorePath is where `agent acp` keeps a session:
// $CURSOR_CONFIG_DIR/acp-sessions/<id>/store.db when that variable is set in the server's
// environment (the agent gets the same environment), else <home>/.cursor/acp-sessions/<id>/store.db.
// <id> is the ACP sessionId from session/new (ChatMeta.SessionID).
func StorePath(home, sessionID string) string {
	dir := os.Getenv("CURSOR_CONFIG_DIR")
	if dir == "" {
		dir = filepath.Join(home, ".cursor")
	}
	return filepath.Join(dir, "acp-sessions", sessionID, "store.db")
}

// ReadContextUsage reads the store with the sqlite3 CLI. Every failure is an error whose text is
// shown in the meter; there is no fallback.
func ReadContextUsage(sqlite, home, sessionID string) (ContextUsage, error) {
	db := StorePath(home, sessionID)
	if _, err := os.Stat(db); err != nil {
		return ContextUsage{}, errors.New(errStoreNotFound)
	}
	if _, err := exec.LookPath(sqlite); err != nil {
		return ContextUsage{}, errors.New(errSQLiteNotFound)
	}

	out, err := runSQLite(sqlite, db, "SELECT value FROM meta WHERE key = '0';")
	if err != nil {
		return ContextUsage{}, err
	}
	metaJSON, err := hex.DecodeString(out)
	if err != nil || len(metaJSON) == 0 {
		return ContextUsage{}, errors.New(errStoreFormat)
	}
	var meta struct {
		LatestRootBlobID string `json:"latestRootBlobId"`
	}
	if err := json.Unmarshal(metaJSON, &meta); err != nil || !blobIDRe.MatchString(meta.LatestRootBlobID) {
		return ContextUsage{}, errors.New(errStoreFormat)
	}

	out, err = runSQLite(sqlite, db, "SELECT hex(data) FROM blobs WHERE id = '"+meta.LatestRootBlobID+"';")
	if err != nil {
		return ContextUsage{}, err
	}
	blob, err := hex.DecodeString(out)
	if err != nil || len(blob) == 0 {
		return ContextUsage{}, errors.New(errStoreFormat)
	}
	u, ok := decodeTokenDetails(blob)
	if !ok {
		return ContextUsage{}, errors.New(errStoreFormat)
	}
	return u, nil
}

// ctxPoller re-reads the context usage while a turn runs: a ticker goroutine (1 s by default), at
// most one read at a time (a tick is skipped while one runs), an event only when the result changed.
type ctxPoller struct {
	interval time.Duration

	mu   sync.Mutex    // guards stop and done
	stop chan struct{} // non-nil while polling
	done chan struct{} // closed when the ticker goroutine has returned

	read    sync.Mutex // held during a read
	last    agent.Event
	hasLast bool
}

func (c *ctxPoller) startPolling(p *proc) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stop != nil {
		return
	}
	iv := c.interval
	if iv <= 0 {
		iv = time.Second
	}
	stop, done := make(chan struct{}), make(chan struct{})
	c.stop, c.done = stop, done
	go func() {
		defer close(done)
		t := time.NewTicker(iv)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				if c.read.TryLock() {
					p.readCtxLocked(true)
					c.read.Unlock()
				}
			}
		}
	}()
}

// stopPolling ends the ticker and waits for its goroutine (and any read it is doing).
func (c *ctxPoller) stopPolling() {
	c.mu.Lock()
	stop, done := c.stop, c.done
	c.stop, c.done = nil, nil
	c.mu.Unlock()
	if stop != nil {
		close(stop)
		<-done
	}
}

// readCtx reads the session's context usage and sends it as EvUsage, or its error as
// EvUsage{CtxError}. It waits for a read that is already running.
func (p *proc) readCtx() {
	p.ctx.read.Lock()
	defer p.ctx.read.Unlock()
	p.readCtxLocked(false)
}

// readCtxLocked does one read with p.ctx.read held; onlyChanged drops a result equal to the last.
func (p *proc) readCtxLocked(onlyChanged bool) {
	e := agent.Event{Kind: agent.EvUsage}
	if u, err := ReadContextUsage(p.s.sqlite(), p.s.Home, p.sessionID); err != nil {
		e.CtxError = err.Error()
	} else {
		e.CtxIn, e.CtxWindow = u.Used, u.Max
	}
	if onlyChanged && p.ctx.hasLast && p.ctx.last.CtxIn == e.CtxIn && p.ctx.last.CtxWindow == e.CtxWindow && p.ctx.last.CtxError == e.CtxError {
		return
	}
	p.ctx.last, p.ctx.hasLast = e, true
	p.emit(e)
}

// runSQLite runs one query as its own sqlite3 process (no -readonly: in WAL mode a read-only open
// fails once the agent has exited) and returns its trimmed stdout.
func runSQLite(sqlite, db, query string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sqliteTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, sqlite, db, query)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
			return "", errors.New(errSQLiteNotFound)
		}
		if ctx.Err() == context.DeadlineExceeded {
			return "", errors.New(errStoreRead + "timed out")
		}
		line := strings.TrimSpace(strings.SplitN(strings.TrimSpace(stderr.String()), "\n", 2)[0])
		if line == "" {
			line = err.Error()
		}
		return "", errors.New(errStoreRead + line)
	}
	return strings.TrimSpace(stdout.String()), nil
}

// decodeTokenDetails takes the first field 5 of wire type 2 in a ConversationStateStructure
// message and reads used_tokens (field 1) and max_tokens (field 2) from it. It reports false when
// the message is malformed, field 5 is missing, or either count is 0.
func decodeTokenDetails(root []byte) (ContextUsage, bool) {
	var details []byte
	found := false
	err := walkFields(root, func(num int, wt int, v uint64, b []byte) bool {
		if num == 5 && wt == wireBytes {
			details, found = b, true
			return false
		}
		return true
	})
	if err != nil || !found {
		return ContextUsage{}, false
	}
	var u ContextUsage
	err = walkFields(details, func(num int, wt int, v uint64, b []byte) bool {
		if wt == wireVarint {
			switch num {
			case 1:
				u.Used = int(v)
			case 2:
				u.Max = int(v)
			}
		}
		return true
	})
	if err != nil || u.Used <= 0 || u.Max <= 0 {
		return ContextUsage{}, false
	}
	return u, true
}

// Protobuf wire types.
const (
	wireVarint  = 0
	wireFixed64 = 1
	wireBytes   = 2
	wireFixed32 = 5
)

var errWire = errors.New("malformed protobuf")

// walkFields calls fn for each top-level field of a protobuf message: v holds a varint or fixed
// value, b a length-delimited value. fn returns false to stop early. Groups (wire types 3 and 4)
// are treated as malformed.
func walkFields(msg []byte, fn func(num int, wt int, v uint64, b []byte) bool) error {
	for len(msg) > 0 {
		key, n := readVarint(msg)
		if n == 0 {
			return errWire
		}
		msg = msg[n:]
		num, wt := int(key>>3), int(key&7)
		if num == 0 {
			return errWire
		}
		var v uint64
		var b []byte
		switch wt {
		case wireVarint:
			v, n = readVarint(msg)
			if n == 0 {
				return errWire
			}
			msg = msg[n:]
		case wireFixed64:
			if len(msg) < 8 {
				return errWire
			}
			for i := 7; i >= 0; i-- {
				v = v<<8 | uint64(msg[i])
			}
			msg = msg[8:]
		case wireFixed32:
			if len(msg) < 4 {
				return errWire
			}
			for i := 3; i >= 0; i-- {
				v = v<<8 | uint64(msg[i])
			}
			msg = msg[4:]
		case wireBytes:
			l, n := readVarint(msg)
			if n == 0 || l > uint64(len(msg)-n) {
				return errWire
			}
			b = msg[n : n+int(l)]
			msg = msg[n+int(l):]
		default:
			return errWire
		}
		if !fn(num, wt, v, b) {
			return nil
		}
	}
	return nil
}

// readVarint decodes a base-128 varint and returns it with the number of bytes read, or n == 0
// when buf holds no complete varint of at most 10 bytes.
func readVarint(buf []byte) (v uint64, n int) {
	for i := 0; i < len(buf) && i < 10; i++ {
		c := buf[i]
		v |= uint64(c&0x7f) << (7 * i)
		if c < 0x80 {
			return v, i + 1
		}
	}
	return 0, 0
}
