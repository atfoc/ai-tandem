package runs

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"slices"
	"time"

	"ai-whiteboard/internal/model"
)

// This file is what the server does with runs when it starts and when it stops.

// Boot is called once, last in the server's start, after the runs and the chats are loaded and
// Chats is set. For every started run:
//
//   - A run found running or stopping (the server died without Shutdown) gets run_halted: a
//     stop with reason app_quit at the time of its last entry (or the target of the halt that
//     was under way), running agents become interrupted with their cost from CostOf. It is not
//     continued by itself: the dead server's agent processes may still be alive in its
//     checkouts. A person resumes it.
//   - A run found live whose result is set and that has no active task is finished at once.
//   - A run that Shutdown halted (its open stop has the reason app_quit and its reason sentence
//     is Shutdown's), that is not archived, whose folder exists and that is not blocked
//     continues by itself (run_resumed, startEngine), unless its last three stops are all
//     app_quit and each came less than 60 s after the resume before it.
//
// Holds by chats are not touched here: the scheduler's first pass releases the chats that are
// idle.
func (s *Service) Boot() {
	for _, r := range s.all() {
		s.engBootRun(r)
	}
}

func (s *Service) engBootRun(r *run) {
	v := r.viewNow()
	switch {
	case !v.Status.Started() || v.Status.Final():
		return
	case v.Status.Live():
		if err := r.load(); err != nil {
			log.Printf("runs: boot %s: %v", r.id, err)
			return
		}
		r.mu.Lock()
		finished := r.L.State.Result != nil
		for i := range r.L.Tasks {
			if r.L.Tasks[i].State().Active() {
				finished = false
			}
		}
		r.mu.Unlock()
		if finished {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			if err := r.engFinish(ctx, nil); err != nil {
				log.Printf("runs: finish %s at the server's start: %v", r.id, err)
			}
			return
		}
		def := Halting{Status: model.RunStopped, Reason: engReasonCrash, Stop: model.StopAppQuit}
		if err := r.engWriteHalted(def, engLastEntryTime(r.dir)); err != nil {
			log.Printf("runs: halt %s at the server's start: %v", r.id, err)
		}
		return
	case v.Status != model.RunStopped || v.Reason != engReasonQuit:
		return
	}

	// Halted by an orderly shutdown: continue by itself.
	if v.Archived || v.FolderMissing || v.Blocked != "" {
		return
	}
	if _, err := os.Stat(v.Cwd); err != nil {
		return
	}
	if err := r.load(); err != nil {
		log.Printf("runs: boot %s: %v", r.id, err)
		return
	}
	r.mu.Lock()
	stops, started := slices.Clone(r.L.Stops), r.L.State.StartedAt
	r.mu.Unlock()
	if n := len(stops); n == 0 || stops[n-1].ResumedAt != 0 || stops[n-1].Reason != model.StopAppQuit {
		return
	}
	if engQuickCloses(stops, started) {
		_, err := r.commit(KRunHalted, func(tx *Tx) error {
			st := tx.State()
			if st.Status != model.RunStopped {
				tx.Skip()
				return nil
			}
			st.Reason = engReasonLoop
			return nil
		})
		if err == nil {
			err = r.checkpoint()
		}
		if err != nil {
			log.Printf("runs: boot %s: %v", r.id, err)
		}
		return
	}
	if err := r.engResumeAs(false); err != nil {
		log.Printf("runs: continue %s at the server's start: %v", r.id, err)
	}
}

// engQuickCloses reports whether the run's last three stops were all made by the app closing,
// each less than 60 s after the run was continued (the first of them: after the resume before
// it, or the run's start).
func engQuickCloses(stops []model.RunStop, startedAt int64) bool {
	n := len(stops)
	if n < 3 {
		return false
	}
	for i := n - 3; i < n; i++ {
		since := startedAt
		if i > 0 {
			since = stops[i-1].ResumedAt
		}
		if stops[i].Reason != model.StopAppQuit || stops[i].At-since >= 60_000 {
			return false
		}
	}
	return true
}

// engLastEntryTime is the time of the journal's last whole entry; 0 (now, for engWriteHalted) when
// it cannot be read.
func engLastEntryTime(dir string) int64 {
	b, err := os.ReadFile(filepath.Join(dir, fileJournal))
	if err != nil {
		return 0
	}
	for len(b) > 0 {
		b = bytes.TrimRight(b, "\n")
		at := bytes.LastIndexByte(b, '\n') + 1
		var e Entry
		if json.Unmarshal(b[at:], &e) == nil && e.V > 0 {
			return e.T
		}
		b = b[:at] // a torn last line: the one before it
	}
	return 0
}

// Shutdown is called first when the server stops. It sets a quit flag (no new agent, task or
// turn starts), cancels every worker's context, waits up to wait for the workers, and writes one
// run_halted entry (app_quit, or the Halting target of a run that was stopping) and a checkpoint
// per live run. It closes no agent process: the chat manager's Shutdown does.
func (s *Service) Shutdown(wait time.Duration) {
	s.eng.quit.Store(true)
	s.eng.mu.Lock()
	engs := make([]*engine, 0, len(s.eng.active))
	for e := range s.eng.active {
		engs = append(engs, e)
	}
	s.eng.mu.Unlock()
	for _, e := range engs {
		e.stop()
	}
	if !s.eng.wait(nil, wait) {
		log.Printf("runs: some run workers had not returned when the server stopped")
	}
	def := Halting{Status: model.RunStopped, Reason: engReasonQuit, Stop: model.StopAppQuit}
	for _, r := range s.all() {
		if !r.viewNow().Status.Live() {
			continue
		}
		if err := r.engWriteHalted(def, 0); err != nil {
			log.Printf("runs: halt %s at the server's stop: %v", r.id, err)
		}
	}
}
