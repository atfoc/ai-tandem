package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
)

type usageResult struct {
	Agent model.AgentKind  `json:"agent"`
	Usage *model.PlanUsage `json:"usage,omitempty"`
	Error string           `json:"error,omitempty"`
}

// UsageCheck reads one agent's subscription limits.
type UsageCheck func(context.Context, bool) (model.PlanUsage, error)

func (s *Server) usageFor(kind model.AgentKind) UsageCheck {
	if get := s.Usage[kind]; get != nil {
		return get
	}
	if s.UsageFor != nil {
		return s.UsageFor(kind)
	}
	return nil
}

// usageOverview returns one ordered result per usable agent. The optional request ID also
// lets the caller receive each result on its existing event stream while the others run.
func (s *Server) usageOverview(w http.ResponseWriter, r *http.Request) {
	kinds := s.App.Agents.List()
	ctx := r.Context()
	fresh := r.URL.Query().Get("fresh") == "1"
	request := r.URL.Query().Get("request")
	type answer struct {
		index int
		usageResult
	}
	done := make(chan answer, len(kinds))
	for i, kind := range kinds {
		go func() {
			result := usageResult{Agent: kind}
			var usage model.PlanUsage
			var err error
			if get := s.usageFor(kind); get != nil {
				usage, err = checkUsage(ctx, get, fresh)
			} else {
				usage = model.PlanUsage{Note: "This agent does not report plan limits."}
			}
			if err != nil {
				result.Error = err.Error()
			} else {
				if usage.Limits == nil {
					usage.Limits = []model.UsageLimit{}
				}
				result.Usage = &usage
			}
			done <- answer{i, result}
		}()
	}
	results := make([]usageResult, len(kinds))
	for range kinds {
		select {
		case <-ctx.Done():
			return
		case got := <-done:
			results[got.index] = got.usageResult
			if request != "" && len(request) <= 80 && s.Bridge != nil {
				s.Bridge.SendTo(r.Header.Get(ClientHeader), map[string]any{"type": "plan_usage", "request": request, "result": got.usageResult})
			}
		}
	}
	writeJSON(w, results)
}

func checkUsage(ctx context.Context, check UsageCheck, fresh bool) (model.PlanUsage, error) {
	timeout := 32 * time.Second
	if fresh {
		timeout += time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	usage, err := check(ctx, fresh)
	if errors.Is(err, context.DeadlineExceeded) {
		err = errors.New("The plan usage check timed out.")
	}
	return usage, err
}

// PublishPlanUsage forwards the latest in-memory plan usage after a passive update.
func PublishPlanUsage(bridge *editorbridge.Bridge, kind model.AgentKind, usage model.PlanUsage) {
	bridge.Broadcast(map[string]any{"type": "plan_usage", "result": usageResult{Agent: kind, Usage: &usage}})
}
