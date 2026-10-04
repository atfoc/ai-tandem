package cursor

import (
	"bytes"
	"context"
	"crypto/md5"
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
	"ai-whiteboard/internal/model"
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

// ChildStorePath is where Cursor keeps a subagent's store:
// <config dir>/chats/<md5 hex of the real path of cwd>/<subagentSessionId>/store.db, where the
// config dir is $CURSOR_CONFIG_DIR or <home>/.cursor, as for StorePath.
func ChildStorePath(home, cwd, childID string) string {
	dir := os.Getenv("CURSOR_CONFIG_DIR")
	if dir == "" {
		dir = filepath.Join(home, ".cursor")
	}
	if real, err := filepath.EvalSymlinks(cwd); err == nil {
		cwd = real
	}
	sum := md5.Sum([]byte(cwd))
	return filepath.Join(dir, "chats", hex.EncodeToString(sum[:]), childID, "store.db")
}

// ReadContextUsage reads the store with the sqlite3 CLI. Every failure is an error whose text is
// shown in the meter; there is no fallback.
func ReadContextUsage(sqlite, home, sessionID string) (ContextUsage, error) {
	return readUsageAt(sqlite, StorePath(home, sessionID))
}

// readUsageAt reads the store at db; see ReadContextUsage.
func readUsageAt(sqlite, db string) (ContextUsage, error) {
	u, _, err := readUsageRootAt(sqlite, db)
	return u, err
}

// readUsageRootAt is readUsageAt that also returns the id of the root blob it read (the store's
// latestRootBlobId): "" when the root could not be read, set even when the root has no usage.
func readUsageRootAt(sqlite, db string) (ContextUsage, string, error) {
	root, blob, err := readRootAt(sqlite, db)
	if err != nil {
		return ContextUsage{}, "", err
	}
	u, ok := decodeTokenDetails(blob)
	if !ok {
		return ContextUsage{}, root, errors.New(errStoreFormat)
	}
	return u, root, nil
}

// ReadContextSplit reads the chat's context split from its session store: token_details'
// categories, in Cursor's order, and the room left as "free". No process is needed.
func (s *Spawner) ReadContextSplit(o agent.SpawnOptions) (model.ContextSplit, error) {
	_, blob, err := readRootAt(s.sqlite(), StorePath(s.Home, o.SessionID))
	if err != nil {
		return model.ContextSplit{}, err
	}
	split, ok := decodeSplit(blob)
	if !ok {
		return model.ContextSplit{}, errors.New(errStoreFormat)
	}
	return split, nil
}

// readRootAt returns the latest root blob (a ConversationStateStructure) of the store at db, and
// its id.
func readRootAt(sqlite, db string) (id string, blob []byte, err error) {
	if _, err := os.Stat(db); err != nil {
		return "", nil, errors.New(errStoreNotFound)
	}
	if _, err := exec.LookPath(sqlite); err != nil {
		return "", nil, errors.New(errSQLiteNotFound)
	}

	out, err := runSQLite(sqlite, db, "SELECT value FROM meta WHERE key = '0';")
	if err != nil {
		return "", nil, err
	}
	metaJSON, err := hex.DecodeString(out)
	if err != nil || len(metaJSON) == 0 {
		return "", nil, errors.New(errStoreFormat)
	}
	var meta struct {
		LatestRootBlobID string `json:"latestRootBlobId"`
	}
	if err := json.Unmarshal(metaJSON, &meta); err != nil || !blobIDRe.MatchString(meta.LatestRootBlobID) {
		return "", nil, errors.New(errStoreFormat)
	}

	out, err = runSQLite(sqlite, db, "SELECT hex(data) FROM blobs WHERE id = '"+meta.LatestRootBlobID+"';")
	if err != nil {
		return "", nil, err
	}
	blob, err = hex.DecodeString(out)
	if err != nil || len(blob) == 0 {
		return "", nil, errors.New(errStoreFormat)
	}
	return meta.LatestRootBlobID, blob, nil
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
// EvUsage{CtxError}. It waits for a read that is already running. It returns the id of the root
// blob it read, "" when the store could not be read.
func (p *proc) readCtx() string {
	p.ctx.read.Lock()
	defer p.ctx.read.Unlock()
	return p.readCtxLocked(false)
}

// readCtxLocked does one read with p.ctx.read held; onlyChanged drops a result equal to the last.
func (p *proc) readCtxLocked(onlyChanged bool) (root string) {
	e := agent.Event{Kind: agent.EvUsage}
	u, root, err := readUsageRootAt(p.s.sqlite(), StorePath(p.s.Home, p.sessionID))
	if err != nil {
		e.CtxError = err.Error()
	} else {
		e.CtxIn, e.CtxWindow = u.Used, u.Max
	}
	if onlyChanged && p.ctx.hasLast && p.ctx.last.CtxIn == e.CtxIn && p.ctx.last.CtxWindow == e.CtxWindow && p.ctx.last.CtxError == e.CtxError {
		return root
	}
	p.ctx.last, p.ctx.hasLast = e, true
	p.emit(e)
	return root
}

// pollChild reads a subagent's store every p.ctx.interval (1 s by default) until stopChild.
// The store appears about 1 s after the spawn and has no usage before the first model step, so
// failed reads are silent: the subagent's meter just shows nothing yet.
func (p *proc) pollChild(c *child) {
	iv := p.ctx.interval
	if iv <= 0 {
		iv = time.Second
	}
	stop, done := make(chan struct{}), make(chan struct{})
	p.mu.Lock()
	c.stop, c.done = stop, done
	p.mu.Unlock()
	go func() {
		defer close(done)
		t := time.NewTicker(iv)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				p.readChildCtx(c, true)
			}
		}
	}()
}

// stopChild ends a child's poller and waits for it; a second call does nothing.
func (p *proc) stopChild(c *child) {
	p.mu.Lock()
	stop, done := c.stop, c.done
	c.stop = nil
	p.mu.Unlock()
	if stop != nil {
		close(stop)
		<-done
	}
}

func (p *proc) stopChildren() {
	p.mu.Lock()
	cs := make([]*child, 0, len(p.children))
	for _, c := range p.children {
		cs = append(cs, c)
	}
	p.mu.Unlock()
	for _, c := range cs {
		p.stopChild(c)
	}
}

// readChildCtx reads a child's store once and sends its usage as EvSub{Tokens, Window}; errors are
// dropped, and so is a result equal to the last one sent when onlyChanged is set.
func (p *proc) readChildCtx(c *child, onlyChanged bool) {
	c.readMu.Lock()
	defer c.readMu.Unlock()
	u, err := readUsageAt(p.s.sqlite(), ChildStorePath(p.s.Home, p.o.Cwd, c.id))
	if err != nil || (onlyChanged && u == c.last) {
		return
	}
	c.last = u
	p.emit(agent.Event{Kind: agent.EvSub, Sub: c.tool, SubInfo: &agent.SubInfo{Tokens: u.Used, Window: u.Max}})
}

// runSQLite runs one query as its own sqlite3 process (no -readonly: in WAL mode a read-only open
// fails once the agent has exited) and returns its trimmed stdout.
func runSQLite(sqlite, db, query string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sqliteTimeout)
	defer cancel()
	return runSQLiteCtx(ctx, sqlite, "", db, query)
}

// runSQLiteCtx runs sqlite3 on db with args (SQL or dot-commands, run in order) until ctx ends,
// in the directory dir ("" = the server's), and returns its trimmed stdout.
func runSQLiteCtx(ctx context.Context, sqlite, dir, db string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, sqlite, append([]string{db}, args...)...)
	cmd.Dir = dir
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

// tokenDetails returns the first field 5 of wire type 2 in a ConversationStateStructure message.
func tokenDetails(root []byte) ([]byte, bool) {
	var details []byte
	found := false
	err := walkFields(root, func(num int, wt int, v uint64, b []byte) bool {
		if num == 5 && wt == wireBytes {
			details, found = b, true
			return false
		}
		return true
	})
	return details, err == nil && found
}

// decodeTokenDetails reads used_tokens (field 1) and max_tokens (field 2) from the root's
// token_details. It reports false when the message is malformed, field 5 is missing, or either
// count is 0.
func decodeTokenDetails(root []byte) (ContextUsage, bool) {
	details, ok := tokenDetails(root)
	if !ok {
		return ContextUsage{}, false
	}
	var u ContextUsage
	err := walkFields(details, func(num int, wt int, v uint64, b []byte) bool {
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

// decodeSplit reads token_details' used and max tokens and its breakdown (field 3), whose
// categories (field 3, repeated) each hold an id (1), a label (2), tokens (3, absent when 0) and
// characters (4). The room left is added as a "free" category. It reports false when the counts
// cannot be read or there is no breakdown.
func decodeSplit(root []byte) (model.ContextSplit, bool) {
	u, ok := decodeTokenDetails(root)
	if !ok {
		return model.ContextSplit{}, false
	}
	details, _ := tokenDetails(root)
	var breakdown []byte
	found := false
	if walkFields(details, func(num int, wt int, v uint64, b []byte) bool {
		if num == 3 && wt == wireBytes {
			breakdown, found = b, true
			return false
		}
		return true
	}) != nil || !found {
		return model.ContextSplit{}, false
	}
	split := model.ContextSplit{Total: u.Used, Window: u.Max, Categories: []model.ContextCategory{}}
	var bad bool
	if walkFields(breakdown, func(num int, wt int, v uint64, b []byte) bool {
		if num != 3 || wt != wireBytes {
			return true
		}
		c := model.ContextCategory{Kind: "used"}
		bad = walkFields(b, func(num int, wt int, v uint64, b []byte) bool {
			switch {
			case num == 1 && wt == wireBytes:
				c.ID = string(b)
			case num == 2 && wt == wireBytes:
				c.Label = string(b)
			case num == 3 && wt == wireVarint:
				c.Tokens = int(v)
			case num == 4 && wt == wireVarint:
				c.Chars = int(v)
			}
			return true
		}) != nil
		if c.Label == "" {
			c.Label = c.ID
		}
		split.Categories = append(split.Categories, c)
		return !bad
	}) != nil || bad || len(split.Categories) == 0 {
		return model.ContextSplit{}, false
	}
	if free := u.Max - u.Used; free > 0 {
		split.Categories = append(split.Categories, model.ContextCategory{ID: "free", Label: "Free space", Tokens: free, Kind: "free"})
	}
	return split, true
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
