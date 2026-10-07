package runs

import (
	"reflect"
	"sync"
	"time"

	"ai-whiteboard/internal/model"
)

// This file is the service's event queue: what is sent to clients, and when.
//
// Everything a client is told about runs goes through one queue and one goroutine (sender), which
// calls Emit.SendRun with no lock held. So nothing is sent under a run's lock, the events
// of a run arrive in the order they were queued, and there is no lock order between a run and the
// bridge (the snapshot reads r.view without a lock).

// svcRunEvent is the `run` event: the run as the sidebar and the meters show it.
type svcRunEvent struct {
	Type string        `json:"type"` // "run"
	Run  model.RunView `json:"run"`
}

// svcRemovedEvent is the `run_removed` event: the run's folder is gone, and so are its agents.
type svcRemovedEvent struct {
	Type string `json:"type"` // "run_removed"
	ID   string `json:"id"`
}

// svcQueued is one thing the sender has to do, in the order it was queued.
type svcQueued struct {
	run   string
	ev    any           // an event to broadcast as it is
	mark  bool          // the run's view may have changed
	timer bool          // the second after the run's last `run` event is over
	done  chan struct{} // closed when the sender gets here (svcFlush)
}

// svcEvents is the queue and what the sender remembers. mu guards items and started and is a
// leaf: nothing else is taken while it is held. sent belongs to the sender goroutine alone.
type svcEvents struct {
	mu      sync.Mutex
	items   []svcQueued
	wake    chan struct{} // buffered 1
	started bool

	sent map[string]*svcSent
}

// svcSent is the last `run` event sent for one run.
type svcSent struct {
	view  model.RunView
	at    time.Time
	armed bool // a timer will look at the run's view again
}

// svcRunEventGap is the least time between two `run` events of one run that differ only in
// counters.
const svcRunEventGap = time.Second

// queue appends an event to the service's queue for the clients. One goroutine (Service.sender)
// sends the queue in order with Emit.SendRun, so nothing is sent under a lock and the
// events of a run arrive in the order they were queued. It is called with the run's lock (run.mu)
// held by commit, and without it by the engine (a `run_activity` event): it takes nothing but
// the queue's own lock, and does not block.
//
// ev is the event as it is marshalled: commit queues a detailEvent (`run_detail`) for every entry.
func (s *Service) queue(run string, ev any) {
	if ev == nil {
		return
	}
	s.svcPush(svcQueued{run: run, ev: ev})
}

// changed says that the run's view (r.view, read with viewNow) may have changed: after every
// committed entry and every write of run.json. The sender builds nothing itself: it reads the
// view, compares it with the last one it sent for the run and sends a `run` event by the rule of
// the contract (the identity, setup and status fields at once; when only counts, idleStreak,
// attention, cost and costPartial differ, at most one per second per run, by a timer on the
// service's Clock). It is called with or without run.mu held: it takes nothing but the queue's
// own lock, and does not block.
func (r *run) changed() { r.svc.svcPush(svcQueued{run: r.id, mark: true}) }

// svcPush puts one item at the end of the queue and wakes the sender, which is started by the first
// item.
func (s *Service) svcPush(it svcQueued) {
	q := &s.ev
	q.mu.Lock()
	q.items = append(q.items, it)
	if !q.started {
		q.started = true
		q.wake = make(chan struct{}, 1)
		q.sent = map[string]*svcSent{}
		go s.sender()
	}
	wake := q.wake
	q.mu.Unlock()
	select {
	case wake <- struct{}{}:
	default:
	}
}

// sender sends the queue, in order, for as long as the service lives. It holds no lock while it
// broadcasts.
func (s *Service) sender() {
	q := &s.ev
	for range q.wake {
		for {
			q.mu.Lock()
			items := q.items
			q.items = nil
			q.mu.Unlock()
			if len(items) == 0 {
				break
			}
			for _, it := range items {
				s.svcSendOne(it)
			}
		}
	}
}

// svcSendOne does one queued thing. Sender goroutine only.
func (s *Service) svcSendOne(it svcQueued) {
	switch {
	case it.done != nil:
		close(it.done)
	case it.ev != nil:
		run := it.run
		if rm, ok := it.ev.(svcRemovedEvent); ok {
			delete(s.ev.sent, rm.ID)
			run = rm.ID
		}
		s.svcEmit(run, it.ev)
	case it.mark || it.timer:
		s.svcSendRun(it.run, it.timer)
	}
}

// svcSendRun sends the run's view as a `run` event when the rule says so. Sender goroutine only.
//
// The rule (the contract's): a view that differs from the last one sent in anything but the
// counters goes at once. One that differs only in counts, idleStreak, attention, cost or
// costPartial goes at once when the last `run` event of the run is at least a second old, else
// when that second is over, with the view as it is then.
func (s *Service) svcSendRun(id string, timer bool) {
	sent := s.ev.sent
	r, err := s.run(id)
	if err != nil { // deleted: `run_removed` says the rest
		delete(sent, id)
		return
	}
	v := r.viewNow()
	st, known := sent[id]
	if !known {
		st = &svcSent{}
		sent[id] = st
	}
	if timer {
		st.armed = false
	}
	if known && reflect.DeepEqual(v, st.view) {
		return
	}
	now := s.Clock.Now()
	if !known || !reflect.DeepEqual(svcSteady(v), svcSteady(st.view)) || now.Sub(st.at) >= svcRunEventGap {
		st.view, st.at = v, now
		s.svcEmit(id, svcRunEvent{Type: "run", Run: v})
		return
	}
	if st.armed {
		return
	}
	st.armed = true
	due := s.Clock.After(st.at.Add(svcRunEventGap).Sub(now))
	go func() {
		<-due
		s.svcPush(svcQueued{run: id, timer: true})
	}()
}

// svcSteady is the view without the fields that change while agents work: what is left decides
// whether a `run` event goes at once.
func svcSteady(v model.RunView) model.RunView {
	v.Counts, v.IdleStreak, v.Attention, v.Cost, v.CostPartial = model.RunCounts{}, 0, 0, nil, false
	return v
}

// svcEmit sends one event of the run with this id to the clients it concerns. No lock is held.
func (s *Service) svcEmit(run string, ev any) {
	if s.Emit != nil {
		s.Emit.SendRun(run, ev)
	}
}

// svcFlush returns when everything queued before the call has been sent. Tests wait with it; the
// server never needs to.
func (s *Service) svcFlush() {
	done := make(chan struct{})
	s.svcPush(svcQueued{done: done})
	<-done
}
