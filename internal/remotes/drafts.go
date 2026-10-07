package remotes

// The drafts of a record. A started chat's draft is typed in a page of this server and is kept
// here, with the record, by branch: the chat's server is never told of it. The rule is that of a
// local chat's draft (chats.SetDraftOf): each branch has a counter of its draft's changes, which
// is never removed, and a save names the counter it was typed on.

import (
	"net/http"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// SetDraft serves PUT /api/chats/{id}/draft?rev=&branch= for a record: d becomes the draft of
// the branch ("" = the chat's current one), or the branch has none when d is empty. base is the
// counter of the draft d was typed on. When it is not the stored counter the draft was changed
// elsewhere since: nothing is written and the answer is 409 "stale" with the stored counter
// ("rev") and the stored draft ("draft", null for none). Else the answer is {"ok":true,"rev":n}
// with the counter after the write, and the pages get the branch's state and the chat's view.
// Nothing is sent to the chat's server.
func (r *Relay) SetDraft(id, branch string, base int64, d model.Draft) Reply {
	rec := r.rec(id)
	if rec == nil {
		return noChat().Reply()
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return noChat().Reply()
	}
	if branch == "" {
		branch = branchOf(rec.d.View)
	}
	if !rec.d.hasBranch(branch) {
		return (&Error{Status: http.StatusNotFound, Text: chats.ErrNoBranch.Error(), cause: chats.ErrNoBranch}).Reply()
	}
	if rev := rec.d.DraftRevs[branch]; rev != base {
		return jsonReply(http.StatusConflict, map[string]any{
			"error": chats.ErrStaleDraft.Error(), "code": "stale", "rev": rev, "draft": rec.d.Drafts[branch],
		})
	}
	var draft *model.Draft
	if d.Text != "" || len(d.References) > 0 {
		draft = &d
	}
	if rec.d.setDraft(branch, draft) {
		r.keep(rec, true)
		r.emitState(rec, branch)
		r.emitChat(rec)
	}
	return jsonReply(http.StatusOK, map[string]any{"ok": true, "rev": rec.d.DraftRevs[branch]})
}

// clearDraft removes the draft of the branch, on which a message was sent, and raises the
// branch's counter, so that a save of the text that was sent, still on its way, is refused as
// stale. The pages get the branch's state and the chat's view.
func (r *Relay) clearDraft(rec *record, branch string) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return
	}
	if !rec.d.setDraft(branch, nil) {
		rec.d.raise(branch) // no draft was stored: the counter still goes up, by one in both cases
	}
	r.keep(rec, true)
	r.emitState(rec, branch)
	r.emitChat(rec)
}

// hasBranch reports whether the record knows the branch: the first one, the view's current one,
// or one it has a state of.
func (rec *Record) hasBranch(branch string) bool {
	if branch == mainBranch || branch == branchOf(rec.View) {
		return true
	}
	for _, st := range rec.States {
		if st.Branch == branch {
			return true
		}
	}
	return false
}

// setDraft makes d the draft of the branch, nil for none, and counts the change: the branch's
// counter goes up by one unless the branch had no draft and gets none. A stored draft is
// replaced, never changed, and a branch without a draft has no entry (see Record). It reports
// whether anything changed.
func (rec *Record) setDraft(branch string, d *model.Draft) bool {
	if _, has := rec.Drafts[branch]; d == nil && !has {
		return false
	}
	if d == nil {
		delete(rec.Drafts, branch)
		if len(rec.Drafts) == 0 {
			rec.Drafts = nil
		}
	} else {
		if rec.Drafts == nil {
			rec.Drafts = map[string]*model.Draft{}
		}
		rec.Drafts[branch] = d
	}
	rec.raise(branch)
	return true
}

// raise adds one to the branch's draft counter.
func (rec *Record) raise(branch string) {
	if rec.DraftRevs == nil {
		rec.DraftRevs = map[string]int64{}
	}
	rec.DraftRevs[branch]++
}
