package chats

import (
	"reflect"
	"sort"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
)

// The list of paused and stopped subagents (design D14, goal 5.1) rides on the person's message and on
// every app message to an agent that started subagents which do not run and have a session. These
// helpers let a test about something else (results, holds, restarts) say which subagents the list
// names, and assert the rest of the message without it.

// isPausedList reports whether b is the list block.
func isPausedList(b agent.ContentBlock) bool {
	return strings.HasPrefix(b.Text, "<"+pausedListTag+">")
}

// splitPausedList returns msg without its list block and the sids the block names, in its order; nil
// when the message has no list. The list is never the only block and never the last: the person's
// text (or the carry-on's end) follows it.
func splitPausedList(t *testing.T, msg []agent.ContentBlock) (rest []agent.ContentBlock, listed []string) {
	t.Helper()
	for i, b := range msg {
		if !isPausedList(b) {
			rest = append(rest, b)
			continue
		}
		if listed != nil || i == len(msg)-1 {
			t.Fatalf("the message %q has more than one list block, or the list last", texts(msg))
		}
		listed = []string{}
		for _, m := range sidRe.FindAllStringSubmatch(b.Text, -1) {
			listed = append(listed, m[1])
		}
		if !strings.Contains(b.Text, "<state>") || !strings.Contains(b.Text, "resume_subagent") {
			t.Fatalf("the list block is not the list of D14: %q", b.Text)
		}
	}
	return rest, listed
}

// wantPausedList takes the list block off msg, checks that it names exactly want (as a set; none
// means no list block at all), and returns the message without it.
func wantPausedList(t *testing.T, msg []agent.ContentBlock, want ...string) []agent.ContentBlock {
	t.Helper()
	rest, got := splitPausedList(t, msg)
	g, w := append([]string(nil), got...), append([]string(nil), want...)
	sort.Strings(g)
	sort.Strings(w)
	if len(g) == 0 && len(w) == 0 {
		return rest
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("the message %q lists %v as paused or stopped, want %v", texts(msg), got, want)
	}
	return rest
}
