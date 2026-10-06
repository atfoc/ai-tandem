package pi

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ai-whiteboard/internal/agent"
)

var _ agent.Forker = (*Spawner)(nil)

// forkStart is what a fork start hands the process setup and the handshake.
type forkStart struct {
	file  string // the source session file, opened with --session
	entry string // the user message to fork before; "" = the fork is at the source's end
	end   string // with no entry: the id on the end mark at the point; "" = none recorded
	check bool   // the fork must end at end's user message, or it fails (forkEndsAt)
}

// SpawnFork starts the chat's pi process on the source session file, with the chat's own folder
// as session dir, and forks it in the handshake before anything else writes to the session:
// clone when the point is the source's end, else fork before the user message of the turn after
// the point (src.Next). It returns once the handshake has finished, with the id pi gave the new
// session; the handshake also reports it with EvSession. o.SessionID is ignored.
//
// The source may have taken a message since its end was found. So at the end, when the session
// pi opened holds a user message after the one src.Point names, the fork is made before that
// message in place of the clone (forkSession).
//
// A point with no src.Next and no src.End is the end of a turn whose following turn has no mark
// yet: the source is in the middle of it. Its user message is found the same way, in this second
// process and from the session file, so the running source process is never asked anything. The
// source can append between that lookup and the fork, so there the result is checked: the fork
// fails unless it ends at src.Point.
//
// pi gives no error for a missing source file (it would start an empty session at that path), so
// the file is checked here first.
func (s *Spawner) SpawnFork(o agent.SpawnOptions, src agent.ForkSource) (agent.Agent, string, error) {
	if !src.End && src.Next == "" && src.Point == "" {
		return nil, "", errors.New("pi: no fork point after that turn")
	}
	file, err := s.findSessionFile(s.chatDir(src.ChatID, src.Dir), src.SessionID)
	if err != nil {
		return nil, "", err
	}
	fork := &forkStart{file: file}
	switch {
	case src.End:
		fork.end = src.Point
	case src.Next != "":
		fork.entry = src.Next
	default:
		fork.end, fork.check = src.Point, true
	}
	o.SessionID = ""
	p, err := s.start(o, fork)
	if err != nil {
		return nil, "", err
	}
	timeout := s.forkTimeout
	if timeout <= 0 {
		timeout = agent.ForkTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-p.ready:
		err = p.readyErr
	case <-timer.C:
		err = fmt.Errorf("pi did not confirm the fork within %s", timeout)
	}
	if err != nil {
		// Wait for the process to be gone, so nothing writes into the chat's folder afterwards.
		p.Close()
		<-p.done
		return nil, "", err
	}
	return p, p.sessionID, nil
}

// DiscardFork does nothing: a pi fork's session file lives in the chat's or branch's own folder,
// which the chat manager removes.
func (s *Spawner) DiscardFork(sessionID string) {}

// findSessionFile finds the session file of the chat whose folder is chatDir,
// <chatDir>/pi/*_<sessionID>.jsonl (pi names it <timestamp>_<session id>.jsonl); the newest when
// several match.
func (s *Spawner) findSessionFile(chatDir, sessionID string) (string, error) {
	missing := fmt.Errorf("pi: the session file of session %q is missing", sessionID)
	if sessionID == "" {
		return "", missing
	}
	dir := filepath.Join(chatDir, "pi")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", missing
	}
	var found string
	var newest time.Time
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), "_"+sessionID+".jsonl") {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		if found == "" || fi.ModTime().After(newest) {
			found, newest = filepath.Join(dir, e.Name()), fi.ModTime()
		}
	}
	if found == "" {
		return "", missing
	}
	return found, nil
}

// forkSession is the fork step of the handshake, run right after the first get_state: set_model
// and set_thinking_level append entries to whatever session is open, which until the fork is
// still the source. Both fork and clone rebind the process to the new session, so the state is
// read again; it is returned for the rest of the handshake.
//
// A fork at the source's end is a clone, unless the source holds a user message after its end
// mark's (entryAfter): then it is a fork before that message. So is a fork at a point whose next
// turn is running in the source; that one is checked afterwards (forkEndsAt), before set_model
// and set_thinking_level write to the new session.
func (p *proc) forkSession(call func(string, map[string]any) (rpcResponse, error), state rpcResponse) (rpcResponse, error) {
	var src piState
	json.Unmarshal(state.Data, &src)
	if !samePath(src.SessionFile, p.fork.file) {
		return rpcResponse{}, fmt.Errorf("pi fork: pi opened %q, not the source session %q", src.SessionFile, p.fork.file)
	}
	entry := p.fork.entry
	if entry == "" && p.fork.end != "" {
		var err error
		if entry, err = entryAfter(call, p.fork.end); err != nil {
			return rpcResponse{}, err
		}
	}
	command, fields := "clone", map[string]any(nil)
	if entry != "" {
		command, fields = "fork", map[string]any{"entryId": entry}
	}
	res, err := call(command, fields)
	if err != nil {
		return rpcResponse{}, err
	}
	if !res.Success {
		return rpcResponse{}, fmt.Errorf("pi fork: %s", res.Error)
	}
	var out struct {
		Cancelled bool `json:"cancelled"`
	}
	if json.Unmarshal(res.Data, &out) == nil && out.Cancelled {
		return rpcResponse{}, errors.New("pi fork: cancelled by an extension")
	}
	forked, err := call("get_state", nil)
	if err != nil {
		return rpcResponse{}, err
	}
	if !forked.Success {
		return rpcResponse{}, fmt.Errorf("pi get_state: %s", forked.Error)
	}
	var dst piState
	json.Unmarshal(forked.Data, &dst)
	if dst.SessionID == "" || samePath(dst.SessionFile, p.fork.file) {
		return rpcResponse{}, errors.New("pi fork: pi is still on the source session")
	}
	if p.fork.check {
		if err := forkEndsAt(call, p.fork.end); err != nil {
			return rpcResponse{}, err
		}
	}
	return forked, nil
}

// forkEndsAt checks that the last user message of the open session, the fork, is the one with
// entry id point (copied entries keep their ids). A listing that fails or is empty is an error
// too: with a point pi does not list, the clone would have taken the source's running turn in.
func forkEndsAt(call func(string, map[string]any) (rpcResponse, error), point string) error {
	res, err := call("get_fork_messages", nil)
	if err != nil {
		return err
	}
	if !res.Success {
		return fmt.Errorf("pi fork: cannot check where the fork ends: %s", res.Error)
	}
	var data struct {
		Messages []struct {
			EntryID string `json:"entryId"`
		} `json:"messages"`
	}
	if json.Unmarshal(res.Data, &data) != nil || len(data.Messages) == 0 {
		return errors.New("pi fork: cannot check where the fork ends: pi listed no messages")
	}
	if last := data.Messages[len(data.Messages)-1].EntryID; last != point {
		return fmt.Errorf("pi fork: the fork ends at %q, not at the point %q: the source moved on during the fork", last, point)
	}
	return nil
}

// entryAfter is the entry id of the user message that follows the one with entry id point in the
// open session, from get_fork_messages (the session's user messages in order). It is "" when
// that message is the last one, when point is not among them, or when pi does not list them.
func entryAfter(call func(string, map[string]any) (rpcResponse, error), point string) (string, error) {
	res, err := call("get_fork_messages", nil)
	if err != nil {
		return "", err
	}
	var data struct {
		Messages []struct {
			EntryID string `json:"entryId"`
		} `json:"messages"`
	}
	if !res.Success || json.Unmarshal(res.Data, &data) != nil {
		return "", nil
	}
	for i, m := range data.Messages {
		if m.EntryID == point && i+1 < len(data.Messages) {
			return data.Messages[i+1].EntryID, nil
		}
	}
	return "", nil
}

// samePath reports whether two paths name the same file. pi may report a path with its symlinks
// resolved, so paths that differ as text are also compared as files.
func samePath(a, b string) bool {
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	fa, err := os.Stat(a)
	if err != nil {
		return false
	}
	fb, err := os.Stat(b)
	return err == nil && os.SameFile(fa, fb)
}
