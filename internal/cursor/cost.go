package cursor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"ai-whiteboard/internal/model"
)

const costTimeout = 10 * time.Second

// CostReader reads the Cursor plan's usage with `cursor-cost`. It prints what its refresh job
// (`cursor-cost-refresh`) last put in a local cache, so a run makes no request and costs nothing.
type CostReader struct {
	Bin  string // -cursor-cost flag, default "cursor-cost"
	Home string // for ~/bin/<Bin> when Bin is not on PATH (an app launched from Finder has a short PATH)
}

// CostArgs are the arguments for `cursor-cost`. -max-age 0: never "stale"; the popover shows how
// old the numbers are itself.
func CostArgs() []string { return []string{"-compact", "-max-age", "0"} }

func (r *CostReader) bin() string {
	bin := r.Bin
	if bin == "" {
		bin = "cursor-cost"
	}
	if strings.ContainsRune(bin, filepath.Separator) || r.Home == "" {
		return bin
	}
	if _, err := exec.LookPath(bin); err != nil {
		if p := filepath.Join(r.Home, "bin", bin); isFile(p) {
			return p
		}
	}
	return bin
}

func isFile(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}

// Usage runs `cursor-cost` and returns the plan's limits.
func (r *CostReader) Usage() (model.PlanUsage, error) {
	ctx, cancel := context.WithTimeout(context.Background(), costTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.bin(), CostArgs()...)
	cmd.Dir = os.TempDir()
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(bytes.TrimSpace(ee.Stderr)) > 0 {
			return model.PlanUsage{}, fmt.Errorf("cursor-cost: %s", firstLine(string(ee.Stderr)))
		}
		if ctx.Err() != nil {
			return model.PlanUsage{}, fmt.Errorf("cursor-cost: no answer within %s", costTimeout)
		}
		if errors.Is(err, exec.ErrNotFound) {
			return model.PlanUsage{}, errors.New("cursor-cost not found (set -cursor-cost)")
		}
		return model.PlanUsage{}, fmt.Errorf("cursor-cost: %w", err)
	}
	return ParseCost(out)
}

// costOutput is what `cursor-cost` prints.
type costOutput struct {
	Status    string       `json:"status"` // ok | stale | not_logged_in | error | no_cache
	Bucket    string       `json:"bucket"` // the bucket the top-level numbers are for
	Used      *float64     `json:"used"`   // dollars
	Limit     *float64     `json:"limit"`
	Unlimited bool         `json:"unlimited"`
	ResetAt   string       `json:"reset_at"`
	Buckets   []costBucket `json:"buckets"`
	UpdatedAt time.Time    `json:"updated_at"`
	Error     string       `json:"error"`
}

type costBucket struct {
	Key   string   `json:"key"` // "individual.overall", "team.onDemand"
	Used  *float64 `json:"used"`
	Limit *float64 `json:"limit"`
}

// ParseCost reads the output of `cursor-cost`: one limit per bucket that has one. On a failed
// status it still returns the last good numbers, with the error as the note.
func ParseCost(out []byte) (model.PlanUsage, error) {
	var c costOutput
	if err := json.Unmarshal(bytes.TrimSpace(out), &c); err != nil {
		return model.PlanUsage{}, fmt.Errorf("cursor-cost: unreadable output: %w", err)
	}
	if c.Status == "" {
		return model.PlanUsage{}, errors.New("cursor-cost: no status in its output")
	}
	buckets := c.Buckets
	if len(buckets) == 0 && c.Bucket != "" {
		buckets = []costBucket{{Key: c.Bucket, Used: c.Used, Limit: c.Limit}}
	}
	var resets time.Time
	if t, err := time.Parse(time.RFC3339Nano, c.ResetAt); err == nil {
		resets = t
	}
	u := model.PlanUsage{Limits: []model.UsageLimit{}, FetchedAt: c.UpdatedAt}
	for _, b := range buckets {
		if b.Limit == nil || *b.Limit <= 0 {
			continue
		}
		used := 0.0
		if b.Used != nil {
			used = *b.Used
		}
		u.Limits = append(u.Limits, model.UsageLimit{
			Kind: b.Key, Label: bucketLabel(b.Key), Percent: used / *b.Limit * 100,
			Detail: dollars(used) + " of " + dollars(*b.Limit), ResetsAt: resets, Active: b.Key == c.Bucket,
		})
	}
	u.Plan = len(u.Limits) > 0
	switch {
	case c.Status != "ok" && c.Status != "stale":
		u.Note = c.Error
		if u.Note == "" {
			u.Note = "cursor-cost: " + strings.ReplaceAll(c.Status, "_", " ")
		}
	case !u.Plan && c.Unlimited:
		u.Note = "Your Cursor plan has no usage limit."
	case !u.Plan:
		u.Note = "Cursor reported no usage limits."
	}
	return u, nil
}

// bucketLabel: "individual.overall" → "Your usage", "team.onDemand" → "Team on demand".
func bucketLabel(key string) string {
	group, name, _ := strings.Cut(key, ".")
	words := splitCamel(name)
	switch group {
	case "individual":
		if name == "overall" || name == "" {
			return "Your usage"
		}
		return "Your usage (" + words + ")"
	case "team":
		return strings.TrimSpace("Team " + words)
	}
	if words == "" {
		return key
	}
	return strings.ToUpper(words[:1]) + words[1:]
}

// splitCamel: "onDemand" → "on demand".
func splitCamel(s string) string {
	var b strings.Builder
	for i, r := range s {
		if unicode.IsUpper(r) && i > 0 {
			b.WriteByte(' ')
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

// dollars: 413.89 → "$413.89", 1101 → "$1,101".
func dollars(v float64) string {
	s := strconv.FormatFloat(v, 'f', 2, 64)
	if v == math.Trunc(v) {
		s = strconv.FormatFloat(v, 'f', 0, 64)
	}
	whole, frac, _ := strings.Cut(s, ".")
	sign := ""
	if strings.HasPrefix(whole, "-") {
		sign, whole = "-", whole[1:]
	}
	for i := len(whole) - 3; i > 0; i -= 3 {
		whole = whole[:i] + "," + whole[i:]
	}
	if frac != "" {
		whole += "." + frac
	}
	return sign + "$" + whole
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}
