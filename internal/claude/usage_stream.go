package claude

import (
	"time"

	"ai-whiteboard/internal/model"
)

// A rate_limit_event can have utilization for one window, or separate entries in
// unifiedWindows on newer CLIs. Status alone gives no share used. Only the included
// session and weekly windows map unambiguously to the corresponding /usage rows.
// Claude Code 2.1.328's event schema uses fractions for both utilization fields
// and Unix seconds for reset times. The explicit /usage report uses percentages.
func streamPlanUsage(info map[string]any, now time.Time) model.PlanUsage {
	u := model.PlanUsage{FetchedAt: now}
	windows := obj(info["unifiedWindows"])
	current := str(info["rateLimitType"])
	for _, window := range []struct{ key, kind string }{
		{"five_hour", "session"},
		{"seven_day", "weekly_all"},
	} {
		report := obj(windows[window.key])
		used, ok := report["utilization"].(float64)
		if !ok && current == window.key {
			report = info
			used, ok = info["utilization"].(float64)
		}
		if !ok || used < 0 {
			continue
		}
		severity := str(report["status"])
		if severity == "" && current == window.key {
			severity = str(info["status"])
		}
		if severity == "allowed" {
			severity = "normal"
		}
		r := reportLimit{Kind: window.kind, Percent: used * 100, Severity: severity, IsActive: used >= 1 || severity == "rejected"}
		l := r.limit()
		if seconds, ok := report["resetsAt"].(float64); ok && seconds > 0 {
			l.ResetsAt = time.Unix(int64(seconds), 0)
		}
		u.Limits = append(u.Limits, l)
	}
	u.Plan = len(u.Limits) > 0
	return u
}
