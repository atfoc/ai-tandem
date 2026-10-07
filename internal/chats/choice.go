// The model and effort of a new branch or fork (4.6 of the concurrent branches plan): they may
// differ from its source's, chosen with the message that starts the branch or with the fork
// request. Here are the resolution of such a choice and the guard on the model's context window.
package chats

import (
	"errors"
	"fmt"
	"slices"

	"ai-whiteboard/internal/model"
)

// piReserve is what pi keeps free of a model's context window for its answer and a compaction.
const piReserve = 16384

// ErrWindow refuses a model whose context window the conversation it would be given does not fit.
var ErrWindow = errors.New("the model's context window is too small for this conversation")

// ErrBadChoice is what every refusal of choose is: a model the catalog lacks, or an effort the
// model lacks. The refusal's text is its own.
var ErrBadChoice = errors.New("that model or effort can't be chosen")

// badChoice is an error of choose: err with its own text, which is ErrBadChoice to errors.Is.
type badChoice struct{ err error }

func (e badChoice) Error() string        { return e.err.Error() }
func (e badChoice) Unwrap() error        { return e.err }
func (e badChoice) Is(target error) bool { return target == ErrBadChoice }

// choose resolves a wish for the model modelID and the effort effort, either of which may be
// empty, against the choice cur of a chat of kind: both empty is cur. A model alone keeps cur's
// effort when the model offers it, else takes the model's default effort, or none when the model
// has no efforts; an effort alone is checked against cur's model. A kind whose catalog is not
// known yet (see catalog) accepts anything. cm is the catalog's row of next.Model, nil when the
// catalog has none. Every error is an ErrBadChoice.
func (m *Manager) choose(kind model.AgentKind, cur model.ModelChoice, modelID, effort string) (next model.ModelChoice, cm *model.CatalogModel, err error) {
	return chooseIn(m.catalog(kind), cur, modelID, effort)
}

// chooseIn is choose against the catalog cat, which is this server's for a kind or another
// server's (see side); nil accepts anything.
func chooseIn(cat *model.Catalog, cur model.ModelChoice, modelID, effort string) (next model.ModelChoice, cm *model.CatalogModel, err error) {
	next = cur
	if modelID != "" {
		cm, err := findModel(cat, modelID)
		if err != nil {
			return cur, nil, badChoice{err}
		}
		next.Model = modelID
		if cm != nil && !slices.Contains(cm.Efforts, next.Effort) {
			// The chat must never hold an effort its model lacks: fall back to the model's
			// default effort, or none when the model has no efforts.
			next.Effort = ""
			if len(cm.Efforts) > 0 {
				next.Effort = cm.DefaultEffort
			}
		}
	}
	if effort != "" {
		cm, err := findModel(cat, next.Model)
		if err != nil {
			return cur, nil, badChoice{err}
		}
		if cm != nil && !slices.Contains(cm.Efforts, effort) {
			return cur, nil, badChoice{fmt.Errorf("%s has no effort %q", next.Model, effort)}
		}
		next.Effort = effort
	}
	cm, _ = findModel(cat, next.Model) // cur's own model may have left the catalog
	return next, cm, nil
}

// ctxOf is the context use known of the chat meta: its last turn's, or, for a fork that has had
// no turn of its own, that of the chat it was forked from when it was made.
func ctxOf(meta model.ChatMeta) int {
	return max(meta.Usage.CtxIn, meta.SourceCtx)
}

// windowGuard refuses to give a conversation that holds ctxIn tokens to the model nextModel, whose
// catalog row is cm, when it would not fit that model's context window. Only pi is refused, and
// only a change of model (curModel is the one the conversation is on): pi fails such a session at
// its first prompt, and the window of the model a conversation already runs on is not this
// guard's matter. A model whose window is not known passes.
func windowGuard(kind model.AgentKind, ctxIn int, curModel, nextModel string, cm *model.CatalogModel) error {
	if kind != model.Pi || nextModel == curModel || cm == nil || cm.ContextWindow <= 0 ||
		ctxIn <= cm.ContextWindow-piReserve {
		return nil
	}
	name := cm.Label
	if name == "" {
		name = cm.ID
	}
	return fmt.Errorf("%w: %s takes %d tokens and the conversation holds about %d; pick a larger model",
		ErrWindow, name, cm.ContextWindow, ctxIn)
}

// windowOf is the context window of the catalog row cm, 0 when there is no row.
func windowOf(cm *model.CatalogModel) int {
	if cm == nil {
		return 0
	}
	return cm.ContextWindow
}
