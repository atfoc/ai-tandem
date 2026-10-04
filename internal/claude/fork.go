package claude

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"ai-whiteboard/internal/agent"
)

var _ agent.Forker = (*Spawner)(nil)

// inUse is in the stderr line "Error: Session ID <id> is already in use." (exit status 1, nothing
// on stdout) of a fork launch whose own session file exists. The CLI checks that before anything
// about the source session or the point.
const inUse = "is already in use"

// SpawnFork starts the process of o on a fork of src: the resume arguments of the source session
// plus --fork-session, the point (--resume-session-at, unless the fork is at the source's end or
// no point is recorded) and the fork's own id, o.SessionID. It returns once the process has
// answered its initialize request. Nothing but that request is written to the process: the forked
// session has no file until its first message is sent.
//
// When the fork's file exists already (a message was accepted by an earlier process of this
// fork) the launch is refused as "already in use", and a plain resume of o.SessionID is started
// instead. Any other failure is the fork's: a result line before the initialize answer (a source
// session or a point that is gone), the process's exit, or agent.ForkTimeout, which bounds both
// attempts together. A failed attempt's process is closed and none of its events are passed on.
func (s *Spawner) SpawnFork(o agent.SpawnOptions, src agent.ForkSource) (agent.Agent, string, error) {
	if o.SessionID == "" || src.SessionID == "" {
		return nil, "", errors.New("claude: a fork needs its own session id and its source's")
	}
	limit := agent.ForkTimeout
	if s.forkTimeout > 0 {
		limit = s.forkTimeout
	}
	box := time.NewTimer(limit)
	defer box.Stop()

	fork := o
	fork.SessionID, fork.Resume = src.SessionID, true
	extra := []string{"--fork-session"}
	if !src.End && src.Point != "" {
		extra = append(extra, "--resume-session-at", src.Point)
	}
	p, err := s.start(fork, append(extra, "--session-id", o.SessionID)...)
	if err != nil {
		return nil, "", err
	}
	exists, err := p.confirmed(box.C, limit)
	if err == nil {
		return p, o.SessionID, nil
	}
	if !exists {
		return nil, "", err
	}
	resume := o
	resume.Resume = true
	if p, err = s.start(resume); err != nil {
		return nil, "", err
	}
	if _, err = p.confirmed(box.C, limit); err != nil {
		return nil, "", err
	}
	return p, o.SessionID, nil
}

// DiscardFork has nothing to remove: a Claude fork has no session file until its first message
// is sent, and the app never deletes Claude's session files.
func (s *Spawner) DiscardFork(sessionID string) {}

// confirmed waits until the process has answered its initialize request, or has failed to: a
// result line before that answer, its exit, or the time box. A failed process is closed and its
// events are dropped. exists reports the exit of a fork launch whose own session file exists.
func (p *proc) confirmed(box <-chan time.Time, limit time.Duration) (exists bool, err error) {
	select {
	case <-p.initDone:
	case <-p.early:
	case <-p.done:
	case <-box:
		p.drop()
		return false, fmt.Errorf("claude: the fork did not start within %s", limit)
	}
	// The read loop closes these in the order of the lines, so the first to happen is closed by now.
	msg := ""
	select {
	case <-p.early:
		p.drop()
		if msg = p.earlyErr; msg == "" { // stderr has the reason too, complete once the process has ended
			select {
			case <-p.done:
				msg = firstLine(p.stderr.String())
			case <-box:
			}
		}
	default:
		select {
		case <-p.initDone:
			return false, nil
		default:
		}
		p.drop() // it has exited: this only drains its exit event
		stderr := p.stderr.String()
		exists, msg = strings.Contains(stderr, inUse), firstLine(stderr)
	}
	if msg == "" {
		return exists, errors.New("claude: the fork failed")
	}
	return exists, fmt.Errorf("claude: %s", msg)
}

// drop closes a process that is given up and throws its events away.
func (p *proc) drop() {
	p.Close()
	go func() {
		for range p.events {
		}
	}()
}
