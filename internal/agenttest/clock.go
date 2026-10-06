package agenttest

import (
	"sync"
	"time"
)

// Clock is a clock a test moves by hand. It has the methods of runs.Clock: Now and After.
type Clock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*timer
}

type timer struct {
	at time.Time
	ch chan time.Time
}

func NewClock(start time.Time) *Clock { return &Clock{now: start} }

func (c *Clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// After returns a channel that gets the clock's time once Advance has moved it d ahead of now.
// With d <= 0 the time is there at once. The channel is buffered: nobody has to read it.
func (c *Clock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch := make(chan time.Time, 1)
	if d <= 0 {
		ch <- c.now
		return ch
	}
	c.timers = append(c.timers, &timer{at: c.now.Add(d), ch: ch})
	return ch
}

// Advance moves the clock ahead by d and fires every After that is due, earliest first.
func (c *Clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	var left, due []*timer
	for _, t := range c.timers {
		if t.at.After(c.now) {
			left = append(left, t)
		} else {
			due = append(due, t)
		}
	}
	c.timers = left
	for len(due) > 0 {
		first := 0
		for i, t := range due {
			if t.at.Before(due[first].at) {
				first = i
			}
		}
		due[first].ch <- c.now
		due = append(due[:first], due[first+1:]...)
	}
}

// Waiting is the number of After channels that have not fired: a test waits for the code under
// test to be asleep on the clock before it moves it.
func (c *Clock) Waiting() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.timers)
}

// DueIn is the number of After channels that have not fired and are set for exactly d from now:
// the ones asked for with After(d) since the clock last moved. A test that moves the clock for a
// ticker first waits for the ticker's next After(d) to be there, or the move is lost on it.
func (c *Clock) DueIn(d time.Duration) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, t := range c.timers {
		if t.at.Equal(c.now.Add(d)) {
			n++
		}
	}
	return n
}
