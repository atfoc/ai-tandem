package editorbridge

import "time"

// SetHandoverDelay sets how long the holder of a board has to release it (handoverDelay, and
// apiHandoverDelay for a holder that is an API client) for the takes that follow. It is for the tests of the packages that use a Bridge: nothing in the app
// calls it.
func (b *Bridge) SetHandoverDelay(d time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.handoverAfter = d
	b.apiHandoverAfter = d
}
