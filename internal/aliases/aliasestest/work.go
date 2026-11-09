package aliasestest

import (
	"sync"

	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/model"
)

var _ aliases.Work = (*Work)(nil)

// Work is a fake aliases.Work: who works is set by the test.
type Work struct {
	mu      sync.Mutex
	busy    map[model.AgentKind]int
	stopped []model.AgentKind
	onStop  func(kind model.AgentKind)
}

// NewWork returns a Work where nobody works.
func NewWork() *Work { return &Work{busy: map[model.AgentKind]int{}} }

// SetBusy sets how many chat objects of kind work now.
func (w *Work) SetBusy(kind model.AgentKind, n int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.busy[kind] = n
}

// Busy is the SetBusy value of kind.
func (w *Work) Busy(kind model.AgentKind) int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.busy[kind]
}

// OnStop makes StopKind call f with its kind, with no lock of w held, before it records it:
// what the service looks like while it ends an account's processes. nil = none.
func (w *Work) OnStop(f func(kind model.AgentKind)) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.onStop = f
}

// StopKind calls the OnStop function, then records kind and sets its busy count to 0.
func (w *Work) StopKind(kind model.AgentKind) {
	w.mu.Lock()
	f := w.onStop
	w.mu.Unlock()
	if f != nil {
		f(kind)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.stopped = append(w.stopped, kind)
	w.busy[kind] = 0
}

// Stopped is every kind StopKind was called with, in order.
func (w *Work) Stopped() []model.AgentKind {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]model.AgentKind(nil), w.stopped...)
}
