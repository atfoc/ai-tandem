package boardapi

import "time"

// SetCallTimeout sets how long a board tool call waits for the client's answer (callTimeout) for
// the calls that follow. It is for the tests of real server processes, which lower it through the
// server's hidden AIWB_TEST_WAITS ("calls"), as editorbridge.SetHandoverDelay is for the hand-off:
// nothing in the app calls it with a value of its own, and it must be called before the first call
// is served.
func SetCallTimeout(d time.Duration) { callTimeout = d }
