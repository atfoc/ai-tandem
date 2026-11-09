package aliasestest

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/aliases"
)

// Events records what the service broadcasts (aliases.Options.Broadcast). Its zero value is
// ready to use, and it is safe for concurrent use.
type Events struct {
	mu    sync.Mutex
	raw   []string
	lists []aliases.List
}

// Broadcast records ev.
func (e *Events) Broadcast(ev any) {
	b, err := json.Marshal(ev)
	if err != nil {
		b = []byte(fmt.Sprintf("%q", fmt.Sprintf("unmarshalable event %#v: %v", ev, err)))
	}
	var head struct {
		Type    string          `json:"type"`
		Aliases json.RawMessage `json:"aliases"`
	}
	var list aliases.List
	isList := false
	if json.Unmarshal(b, &head) == nil && head.Type == aliases.EventAliases && len(head.Aliases) > 0 {
		isList = json.Unmarshal(head.Aliases, &list) == nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.raw = append(e.raw, string(b))
	if isList {
		e.lists = append(e.lists, list)
	}
}

// Lists is the List of every aliases event, in order.
func (e *Events) Lists() []aliases.List {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]aliases.List(nil), e.lists...)
}

// Count is the number of aliases events.
func (e *Events) Count() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.lists)
}

// Last is the List of the last aliases event; false when there was none.
func (e *Events) Last() (aliases.List, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.lists) == 0 {
		return aliases.List{}, false
	}
	return e.lists[len(e.lists)-1], true
}

// WaitFor waits until an aliases event, received already or later, has a List that satisfies
// pred, and returns that List. It fails the test after timeout.
func (e *Events) WaitFor(t testing.TB, timeout time.Duration, pred func(aliases.List) bool) aliases.List {
	t.Helper()
	deadline := time.Now().Add(timeout)
	seen := 0
	for {
		lists := e.Lists()
		for _, l := range lists[seen:] {
			if pred(l) {
				return l
			}
		}
		seen = len(lists)
		if time.Now().After(deadline) {
			last := "none"
			if seen > 0 {
				b, _ := json.Marshal(lists[seen-1])
				last = string(b)
			}
			t.Fatalf("no aliases event matched within %v (%d events; last: %s)", timeout, seen, last)
			return aliases.List{}
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Raw is every event as JSON text, in order: aliases events and any others.
func (e *Events) Raw() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.raw...)
}
