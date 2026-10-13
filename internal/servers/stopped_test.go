package servers

import (
	"slices"
	"testing"
	"time"

	"ai-whiteboard/internal/servers/standin"
)

// TestOnlyATooOldEntryAsksAgain: the wait of Timing.TooOld is the too old entry's alone. An entry
// in another state that waits for the user (here: its secret is not accepted, and something else
// answers at its address) sends nothing by itself, however short that wait is: it asked once,
// and stays as it is until an edit, an accept or a test.
func TestOnlyATooOldEntryAsksAgain(t *testing.T) {
	t.Parallel()
	for name, c := range map[string]struct {
		start func(t *testing.T) *standin.Server
		state State
	}{
		"the secret is not accepted": {func(t *testing.T) *standin.Server {
			s := standin.Start(t, standin.Options{})
			s.SetSecret("another secret")
			return s
		}, StateSecretNotAccepted},
		"something else answers": {func(t *testing.T) *standin.Server { return standin.NotAIWB(t) }, StateNotAIWB},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			s := c.start(t)
			r := startRig(t, func(o *Options) { o.Timing.TooOld = 20 * time.Millisecond })
			id := r.add(form("Studio", s))
			r.waitState(id, c.state)
			asked := len(s.Requests())
			time.Sleep(10 * 20 * time.Millisecond) // ten of the waits a too old entry asks again after
			staysQuiet(t, s)
			if got := paths(s); len(got) != asked || !slices.Equal(got, []string{HelloPath}) {
				t.Errorf("requests %q; want the one hello", got)
			}
			if v := r.view(id); v.State != c.state || !v.State.stops() {
				t.Errorf("view %+v; want it to wait for the user", v)
			}
		})
	}
}
