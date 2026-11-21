package codex

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"ai-whiteboard/internal/model"
)

func (s *Spawner) probe(run func(context.Context, *rpcConn) error) error {
	ctx, cancel := context.WithTimeout(context.Background(), rpcTimeout)
	defer cancel()
	c, err := startRPC(ctx, s.bin(), []string{"app-server"}, "", nil, nil, nil)
	if err != nil {
		return err
	}
	defer c.close()
	if err := initialize(ctx, c); err != nil {
		return err
	}
	return run(ctx, c)
}

func (s *Spawner) ProbeCatalog() (*model.Catalog, error) {
	cat := &model.Catalog{}
	err := s.probe(func(ctx context.Context, c *rpcConn) error {
		cursor := ""
		for {
			params := map[string]any{"limit": 100}
			if cursor != "" {
				params["cursor"] = cursor
			}
			var page struct {
				Data []struct {
					Model, DisplayName, Description, DefaultReasoningEffort string
					IsDefault                                               bool
					InputModalities                                         []string
					SupportedReasoningEfforts                               []struct{ ReasoningEffort string }
				}
				NextCursor string
			}
			if err := c.call(ctx, "model/list", params, &page); err != nil {
				return err
			}
			for _, m := range page.Data {
				if m.Model == "" {
					continue
				}
				entry := model.CatalogModel{ID: m.Model, Label: m.DisplayName, Note: m.Description,
					DefaultEffort: m.DefaultReasoningEffort, NoImages: len(m.InputModalities) > 0}
				if entry.Label == "" {
					entry.Label = entry.ID
				}
				for _, modality := range m.InputModalities {
					if modality == "image" {
						entry.NoImages = false
					}
				}
				for _, effort := range m.SupportedReasoningEfforts {
					entry.Efforts = append(entry.Efforts, effort.ReasoningEffort)
				}
				cat.Models = append(cat.Models, entry)
				if m.IsDefault || cat.Default.Model == "" {
					cat.Default = model.ModelChoice{Model: entry.ID, Effort: entry.DefaultEffort}
				}
			}
			if page.NextCursor == "" || page.NextCursor == cursor {
				break
			}
			cursor = page.NextCursor
		}
		if len(cat.Models) == 0 {
			return errors.New("Codex reported no models")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return cat, nil
}

type rateWindow struct {
	UsedPercent        *float64
	WindowDurationMins int
	ResetsAt           int64
}

type rateSnapshot struct {
	LimitID, LimitName string
	Primary, Secondary *rateWindow
}

func (s *Spawner) Usage() (model.PlanUsage, error) {
	var out model.PlanUsage
	err := s.probe(func(ctx context.Context, c *rpcConn) error {
		var account struct {
			Account *struct{ Type string }
		}
		if err := c.call(ctx, "account/read", map[string]bool{"refreshToken": false}, &account); err != nil {
			return err
		}
		out.FetchedAt = time.Now()
		if account.Account == nil || account.Account.Type == "apiKey" {
			out.Note = "Codex plan limits require a ChatGPT login."
			return nil
		}
		var r struct {
			RateLimits          rateSnapshot
			RateLimitsByLimitID map[string]rateSnapshot
		}
		if err := c.call(ctx, "account/rateLimits/read", nil, &r); err != nil {
			return err
		}
		if len(r.RateLimitsByLimitID) == 0 {
			r.RateLimitsByLimitID = map[string]rateSnapshot{"codex": r.RateLimits}
		}
		keys := make([]string, 0, len(r.RateLimitsByLimitID))
		for key := range r.RateLimitsByLimitID {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			out.Limits = appendRateSnapshot(out.Limits, key, r.RateLimitsByLimitID[key])
		}
		out.FetchedAt = time.Now()
		out.Plan = len(out.Limits) > 0
		if !out.Plan {
			out.Note = "Codex reported no plan limits."
		}
		return nil
	})
	return out, err
}

func appendRateSnapshot(limits []model.UsageLimit, key string, snap rateSnapshot) []model.UsageLimit {
	limits = appendRateWindow(limits, key, snap.LimitName, "primary", snap.Primary)
	return appendRateWindow(limits, key, snap.LimitName, "secondary", snap.Secondary)
}

func appendRateWindow(limits []model.UsageLimit, key, name, kind string, w *rateWindow) []model.UsageLimit {
	if w == nil || w.UsedPercent == nil {
		return limits
	}
	if name == "" {
		name = key
		if key == "codex" {
			name = "Codex"
		}
	}
	label := name + " " + kind
	if w.WindowDurationMins > 0 {
		label = fmt.Sprintf("%s · %s window", name, (time.Duration(w.WindowDurationMins) * time.Minute).String())
	}
	l := model.UsageLimit{Kind: key + "_" + kind, Label: label, Percent: *w.UsedPercent, Active: *w.UsedPercent >= 100}
	if w.ResetsAt > 0 {
		l.ResetsAt = time.Unix(w.ResetsAt, 0)
	}
	return append(limits, l)
}
