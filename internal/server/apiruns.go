package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
)

// The run routes that exist for an API client alone: the start call and the draft check. Both
// answer a caller on the loopback listener with 404: a page's client id must never become a
// run's mark, and a local draft has its own view. The other run routes of RemoteRoutes are the
// handlers of runRoutes.

// apiRunRoutes registers the start call and the draft check; handle is runRoutes' own.
func (s *Server) apiRunRoutes(handle func(pattern string, h func(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string))) {
	handle("PUT /api/runs/{id}", s.apiRunStart)
	handle("GET /api/runs/check", s.apiRunCheck)
}

// apiRunStart is PUT /api/runs/{id}, the start call: it finds the caller's started run with the
// id, or checks the call's values, makes the run in the group "Remote" and starts it
// (runs.Service.StartCall). The call can be repeated: of any number of calls with one id one
// makes the run, and the others change nothing.
//
// Body: {"name", "userNamed", "agent", "tiers", "cwd", "settings", "goal"}. agent, cwd, goal and
// a model for every tier are required; settings is a runs.SettingsPatch on top of the built-in
// values. An "id" must be the path's. A body that names a group is refused.
//
// Every answer, an error too, holds {"started", "made", "run"}: whether the caller's run with
// this id is there and started, whether this call made it, and the run when started. A success
// adds "ok": true, an error "error" and, where a client tells it from others, "code". An answer
// with started false means nothing of this call is there.
func (s *Server) apiRunStart(w http.ResponseWriter, r *http.Request, rs *runs.Service, id string) {
	if !fromRemote(r) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if !runs.ValidID(id) {
		writeRunStart(w, http.StatusBadRequest, runs.StartResult{}, runs.ErrBadID.Error(), "bad_id")
		return
	}
	var body struct {
		ID        *string
		Name      string
		UserNamed bool
		Agent     model.AgentKind
		Tiers     model.RunTiers
		Cwd       string
		Settings  runs.SettingsPatch
		Goal      string
		Group     string
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeRunStart(w, http.StatusBadRequest, runs.StartResult{}, err.Error(), "bad_request")
		return
	}
	if body.ID != nil && *body.ID != id {
		writeRunStart(w, http.StatusBadRequest, runs.StartResult{}, "the id of the body is not the id of the path", "bad_id")
		return
	}
	if body.Group != "" {
		writeRunStart(w, http.StatusBadRequest, runs.StartResult{}, "an API client cannot name a group", "group_refused")
		return
	}
	// An error of the group's making is the server's, not the request's.
	placed := true
	res, err := rs.StartCall(runs.StartReq{
		ID: id, Client: r.Header.Get(ClientHeader),
		Name: body.Name, UserNamed: body.UserNamed, Agent: body.Agent, Tiers: body.Tiers,
		Cwd: body.Cwd, Settings: body.Settings, Goal: body.Goal,
		Place: func() (string, error) {
			g, err := s.App.RemoteGroup()
			placed = err == nil
			return g, err
		},
	})
	if err != nil {
		status := statusOf(err, http.StatusBadRequest)
		switch {
		case !placed:
			status = http.StatusInternalServerError
		case errors.Is(err, runs.ErrIDTaken):
			status = http.StatusConflict
		}
		writeRunStart(w, status, res, err.Error(), runStartCode(err))
		return
	}
	writeRunStart(w, http.StatusOK, res, "", "")
}

// runStartCode is the "code" of a refused start call: the codes of this call alone, and codeOf's.
func runStartCode(err error) string {
	var blocked *runs.BlockedError
	switch {
	case errors.Is(err, runs.ErrBadID):
		return "bad_id"
	case errors.Is(err, runs.ErrStartValue), errors.Is(err, runs.ErrNoGoal):
		return "bad_request"
	case errors.Is(err, runs.ErrNoModel), errors.Is(err, runs.ErrUnknownModel):
		return "bad_choice"
	case errors.Is(err, agent.ErrFolderMissing):
		return "folder_missing"
	case errors.As(err, &blocked):
		return "blocked"
	case errors.Is(err, runs.ErrIDTaken):
		return "id_taken"
	}
	return codeOf(err)
}

// writeRunStart writes the answer of a start call; errText "" is a success.
func writeRunStart(w http.ResponseWriter, status int, res runs.StartResult, errText, code string) {
	out := map[string]any{"started": res.Started, "made": res.Made}
	if res.Started {
		out["run"] = res.Run
	}
	if errText == "" {
		out["ok"] = true
	} else {
		out["error"] = errText
		if code != "" {
			out["code"] = code
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(out)
}

// apiRunCheck is GET /api/runs/check?agent=&cwd=, the draft check: what a draft run of the agent
// in the folder would show on this machine (runs.DraftFacts, every field always present). It
// writes nothing and sends nothing. A blank cwd or an agent that is none of "", claude, cursor
// and pi is refused (400, "bad_request").
func (s *Server) apiRunCheck(w http.ResponseWriter, r *http.Request, rs *runs.Service, _ string) {
	if !fromRemote(r) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	q := r.URL.Query()
	facts, err := rs.CheckDraft(model.AgentKind(q.Get("agent")), q.Get("cwd"))
	if err != nil {
		if errors.Is(err, runs.ErrStartValue) {
			writeErrorCode(w, http.StatusBadRequest, "a draft check needs a folder, and an agent that is claude, cursor or pi when one is given", "bad_request")
			return
		}
		fail(w, err, http.StatusInternalServerError)
		return
	}
	writeJSON(w, facts)
}

// apiRunRename is PATCH /api/runs/{id} on the remote listener: the name alone. The body must be
// an object with the key "name" and no other (400, "rename_only").
func apiRunRename(w http.ResponseWriter, r *http.Request) (runs.PatchReq, bool) {
	var body map[string]json.RawMessage
	if !readJSON(w, r, &body) {
		return runs.PatchReq{}, false
	}
	raw, has := body["name"]
	var name string
	if !has || len(body) != 1 || json.Unmarshal(raw, &name) != nil || string(raw) == "null" {
		writeErrorCode(w, http.StatusBadRequest, "only a run's name can be changed from another server", "rename_only")
		return runs.PatchReq{}, false
	}
	return runs.PatchReq{Name: &name}, true
}
