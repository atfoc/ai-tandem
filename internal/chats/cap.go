// The cap on running turns (4.4 of the concurrent branches plan). Branches of a chat work at the
// same time, so the app limits how many chat objects work at once: maxTurnsPerChat of one
// top-level chat (its main and its branches; a fork is a chat of its own) and maxTurns overall.
// Subagents are not counted, and neither are the chats of runs' agents, which a run limits by
// itself: they hold no slot and are never refused one. At the cap a human message is refused
// (ErrChatCap, ErrAppCap) and a turn of the app's own (deliver) is not started: nothing waits in a
// queue and nothing is retried.
//
// What is counted is what clients are shown as working: the mirror of each chat object's status
// (Chat.pub, written by emitChat alone). A turn that is starting has no status to show yet, so it
// holds its slot by a reservation (Chat.reserved) from its admission until the emitChat that
// publishes it as working has run, or until its start has failed. The admission (reserveTurn)
// counts and reserves under Manager.capMu, so two turns never take the last slot.
//
// The count is of chat objects, not of turns the app started, so it also has what the app never
// admitted: a turn an agent starts by itself, a chat object waiting for approval only for a
// subagent's request, and a start through the fork capability (spawnFork), which shows as
// thinking. Those are never refused, and the count can pass the cap by them.
package chats

import (
	"fmt"
	"strconv"
	"strings"
)

// The caps: the chat objects of one top-level chat that may work at once, and those of the whole
// app. They are vars so that tests can lower them, and SetCaps the app at its start; nothing
// changes them while a manager runs.
var maxTurnsPerChat, maxTurns = 4, 12

// capError is a refusal at the cap. Its text names the limit as it is when the text is read.
type capError struct{ app bool }

func (e *capError) Error() string {
	if e.app {
		if maxTurns == 1 {
			return "1 agent is already working; wait for it to finish or stop it"
		}
		return fmt.Sprintf("%d agents are already working; wait for one to finish or stop one", maxTurns)
	}
	if maxTurnsPerChat == 1 {
		return "this chat already has 1 branch working; wait for it to finish or stop it"
	}
	return fmt.Sprintf("this chat already has %d branches working; wait for one to finish or stop one", maxTurnsPerChat)
}

var (
	ErrChatCap error = &capError{}          // the chat has maxTurnsPerChat chat objects working
	ErrAppCap  error = &capError{app: true} // the app has maxTurns chat objects working
)

// SetCaps sets the caps from the values of AIWB_CHAT_CAP and AIWB_APP_CAP: a positive integer
// replaces the cap, anything else ("" included) leaves it. It is called once, before a manager is
// used, and returns the caps in force.
func SetCaps(chat, app string) (perChat, overall int) {
	if n, err := strconv.Atoi(strings.TrimSpace(chat)); err == nil && n > 0 {
		maxTurnsPerChat = n
	}
	if n, err := strconv.Atoi(strings.TrimSpace(app)); err == nil && n > 0 {
		maxTurns = n
	}
	return maxTurnsPerChat, maxTurns
}

// slots counts the chat objects that hold a slot, but left out: those of the top-level chat top,
// and all of them. A chat object holds one while it is reserved, and while clients are shown it
// as working, unless that is all that is left of a message its agent refused (Chat.noTurn). An
// unlisted chat object is counted as a listed one is: a new branch works before it is listed. A
// run agent's chat holds none. m.capMu held.
func (m *Manager) slots(top, but *Chat) (chat, all int) {
	for _, o := range m.all() {
		if o == but || o.role != "" || !(o.reserved || (o.pub.Load() != pubIdle && !o.noTurn.Load())) {
			continue
		}
		all++
		if topOf(o) == top {
			chat++
		}
	}
	return chat, all
}

// capped is the refusal of one more turn in the top-level chat top, the chat object but not
// counted: nil below the caps. m.capMu held.
func (m *Manager) capped(top, but *Chat) error {
	switch chat, all := m.slots(top, but); {
	case chat >= maxTurnsPerChat:
		return ErrChatCap
	case all >= maxTurns:
		return ErrAppCap
	}
	return nil
}

// reserveTurn admits a turn that is about to start on c, which is not busy, or refuses it at the
// cap. Counting and reserving are one step under capMu, so two turns never take the last slot.
// Admitted, c holds a slot from here on: the caller ends the reservation with releaseTurn once
// emitChat has published c as working, and on every way out that starts no turn. A run agent's
// chat is always admitted. c.mu held.
func (m *Manager) reserveTurn(c *Chat) error {
	m.capMu.Lock()
	defer m.capMu.Unlock()
	if c.role == "" {
		if err := m.capped(topOf(c), c); err != nil {
			return err
		}
	}
	c.reserved = true
	c.noTurn.Store(false)
	return nil
}

// releaseTurn ends c's reservation. From here c holds a slot for as long as its mirror says that
// it works. c.mu held.
func (m *Manager) releaseTurn(c *Chat) {
	m.capMu.Lock()
	c.reserved = false
	m.capMu.Unlock()
}

// capCheck is the refusal a message that starts a new branch of src's chat would get now, nil
// below the caps. It reserves nothing: it keeps the branch from being made, and its process from
// being started, for a message the admission (reserveTurn, in sendOn) would refuse. The branch is
// no chat object yet, so every chat object counts. src.mu may be held.
func (m *Manager) capCheck(src *Chat) error {
	m.capMu.Lock()
	defer m.capMu.Unlock()
	return m.capped(topOf(src), nil)
}
