package claude

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"ai-whiteboard/internal/model"
)

const usageTimeout = 30 * time.Second

// UsageArgs are the arguments for `claude -p /usage`. /usage is a local command: it is answered
// without a model call and costs nothing. There is no --disable-slash-commands, which would send
// "/usage" to the model as a prompt.
func UsageArgs() []string {
	return []string{"-p", "/usage", "--output-format", "stream-json", "--verbose",
		"--no-session-persistence", "--strict-mcp-config"}
}

// Usage runs `claude -p /usage` and returns the plan's limits.
func (s *Spawner) Usage() (model.PlanUsage, error) {
	bin := s.Bin
	if bin == "" {
		bin = "claude"
	}
	ctx, cancel := context.WithTimeout(context.Background(), usageTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, UsageArgs()...)
	cmd.Dir = os.TempDir()
	cmd.Env = append(os.Environ(), "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1")
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(bytes.TrimSpace(ee.Stderr)) > 0 {
			return model.PlanUsage{}, fmt.Errorf("claude /usage: %s", firstLine(string(ee.Stderr)))
		}
		if ctx.Err() != nil {
			return model.PlanUsage{}, fmt.Errorf("claude /usage: no answer within %s", usageTimeout)
		}
		return model.PlanUsage{}, fmt.Errorf("claude /usage: %w", err)
	}
	return ParseUsage(out, time.Now())
}

// ParseUsage reads the stream-json output of `claude -p /usage`: the assistant line's
// usage_report.rate_limits, or else the limit lines of its text. now places the text's
// year-less reset times.
func ParseUsage(out []byte, now time.Time) (model.PlanUsage, error) {
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for sc.Scan() {
		var line struct {
			Type    string `json:"type"`
			Message struct {
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
			Report struct {
				RateLimits *struct {
					Limits []reportLimit `json:"limits"`
				} `json:"rate_limits"`
			} `json:"usage_report"`
		}
		if json.Unmarshal(sc.Bytes(), &line) != nil || line.Type != "assistant" {
			continue
		}
		text := ""
		for _, c := range line.Message.Content {
			if c.Type == "text" {
				text += c.Text
			}
		}
		u := model.PlanUsage{Limits: []model.UsageLimit{}}
		if rl := line.Report.RateLimits; rl != nil && len(rl.Limits) > 0 {
			for _, l := range rl.Limits {
				u.Limits = append(u.Limits, l.limit())
			}
		} else {
			u.Limits = append(u.Limits, textLimits(text, now)...)
		}
		u.Plan = len(u.Limits) > 0
		if !u.Plan {
			u.Note = firstLine(text)
		}
		return u, nil
	}
	return model.PlanUsage{}, errors.New("claude /usage: no answer in its output")
}

// reportLimit is one entry of usage_report.rate_limits.limits.
type reportLimit struct {
	Kind     string  `json:"kind"`
	Percent  float64 `json:"percent"`
	ResetsAt string  `json:"resets_at"`
	Scope    *struct {
		Model *struct {
			DisplayName string `json:"display_name"`
		} `json:"model"`
	} `json:"scope"`
	Severity string `json:"severity"`
	IsActive bool   `json:"is_active"`
}

func (r reportLimit) limit() model.UsageLimit {
	l := model.UsageLimit{Kind: r.Kind, Percent: r.Percent, Severity: r.Severity, Active: r.IsActive}
	if t, err := time.Parse(time.RFC3339Nano, r.ResetsAt); err == nil {
		l.ResetsAt = t
	}
	scope := ""
	if r.Scope != nil && r.Scope.Model != nil {
		scope = r.Scope.Model.DisplayName
	}
	switch {
	case r.Kind == "session":
		l.Label = "Current session"
	case r.Kind == "weekly_all":
		l.Label = "Current week (all models)"
	case strings.HasPrefix(r.Kind, "weekly") && scope != "":
		l.Label = "Current week (" + scope + ")"
	default:
		l.Label = strings.ReplaceAll(r.Kind, "_", " ")
		if l.Label != "" {
			l.Label = strings.ToUpper(l.Label[:1]) + l.Label[1:]
		}
		if scope != "" {
			l.Label += " (" + scope + ")"
		}
	}
	return l
}

// limitLine is a limit in /usage's text:
// "Current week (all models): 18% used · resets Sep 28 at 6:59pm (Europe/Belgrade)".
var limitLine = regexp.MustCompile(`^(Current [^:]+): (\d+(?:\.\d+)?)% used(?: · resets (.+?) \(([^()]+)\))?$`)

// textLimits reads the limit lines of /usage's text, for output without usage_report.
func textLimits(text string, now time.Time) []model.UsageLimit {
	var out []model.UsageLimit
	for _, ln := range strings.Split(text, "\n") {
		m := limitLine.FindStringSubmatch(strings.TrimSpace(ln))
		if m == nil {
			continue
		}
		pct, _ := strconv.ParseFloat(m[2], 64)
		l := model.UsageLimit{Label: m[1], Percent: pct}
		switch {
		case m[1] == "Current session":
			l.Kind = "session"
		case m[1] == "Current week (all models)":
			l.Kind = "weekly_all"
		case strings.HasPrefix(m[1], "Current week ("):
			l.Kind = "weekly_scoped"
		}
		if m[3] != "" {
			l.ResetsAt = resetTime(m[3], m[4], now)
		}
		out = append(out, l)
	}
	return out
}

// resetTime reads "Sep 28 at 6:59pm" or "6:59pm" in the named zone. The text has no year (and
// a bare time no day), so it is the first such time from a day before now. Zero if unreadable.
func resetTime(s, zone string, now time.Time) time.Time {
	loc, err := time.LoadLocation(zone)
	if err != nil {
		loc = time.Local
	}
	now = now.In(loc)
	s = strings.TrimSpace(s)
	for _, layout := range []string{"Jan 2 at 3:04pm", "Jan 2 at 3pm"} {
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			t = time.Date(now.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), 0, 0, loc)
			if t.Before(now.AddDate(0, 0, -1)) {
				t = t.AddDate(1, 0, 0)
			}
			return t
		}
	}
	for _, layout := range []string{"3:04pm", "3pm"} {
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			t = time.Date(now.Year(), now.Month(), now.Day(), t.Hour(), t.Minute(), 0, 0, loc)
			if t.Before(now) {
				t = t.AddDate(0, 0, 1)
			}
			return t
		}
	}
	return time.Time{}
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// UsageCache keeps the last /usage result in memory for TTL, so clicks close together share
// one `claude` run. Callers that come while a run is going wait for it. Nothing is stored.
type UsageCache struct {
	Fetch func() (model.PlanUsage, error)
	TTL   time.Duration
	Now   func() time.Time // nil = time.Now; for tests

	mu   sync.Mutex
	last *model.PlanUsage // the last good result
	run  *usageRun        // the run going now
}

type usageRun struct {
	done chan struct{}
	u    model.PlanUsage
	err  error
}

// Get returns the cached result while it is fresh, else runs Fetch. fresh skips the cache.
func (c *UsageCache) Get(fresh bool) (model.PlanUsage, error) {
	now := c.Now
	if now == nil {
		now = time.Now
	}
	c.mu.Lock()
	if !fresh && c.last != nil && now().Sub(c.last.FetchedAt) < c.TTL {
		u := *c.last
		c.mu.Unlock()
		return u, nil
	}
	r := c.run
	if r == nil {
		r = &usageRun{done: make(chan struct{})}
		c.run = r
		go func() {
			u, err := c.Fetch()
			c.mu.Lock()
			if err == nil {
				u.FetchedAt = now()
				c.last = &u
			}
			r.u, r.err = u, err
			c.run = nil
			c.mu.Unlock()
			close(r.done)
		}()
	}
	c.mu.Unlock()
	<-r.done
	return r.u, r.err
}
