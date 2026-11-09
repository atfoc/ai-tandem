package aliaschats

import (
	"time"

	"ai-whiteboard/internal/chats"
)

// WithTimeout is the namer n with the time limit d instead of 60 s; n must come from Namer.
func WithTimeout(n chats.Namer, d time.Duration) chats.Namer {
	nm := n.(namer)
	nm.timeout = d
	return nm
}
