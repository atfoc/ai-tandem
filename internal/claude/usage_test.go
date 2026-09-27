package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

// now is when testdata/usage.jsonl was captured.
var usageNow = time.Date(2026, 9, 26, 18, 54, 40, 0, time.UTC)

func usageFixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/usage.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseUsageReport(t *testing.T) {
	u, err := ParseUsage(usageFixture(t), usageNow)
	if err != nil {
		t.Fatal(err)
	}
	want := []model.UsageLimit{
		{Kind: "session", Label: "Current session", Percent: 8, ResetsAt: time.Date(2026, 9, 26, 23, 9, 59, 571846000, time.UTC), Severity: "normal"},
		{Kind: "weekly_all", Label: "Current week (all models)", Percent: 18, ResetsAt: time.Date(2026, 9, 28, 16, 59, 59, 571867000, time.UTC), Severity: "normal", Active: true},
		{Kind: "weekly_scoped", Label: "Current week (Fable)", Percent: 2, ResetsAt: time.Date(2026, 9, 28, 16, 59, 59, 572063000, time.UTC), Severity: "normal"},
	}
	if !u.Plan || u.Note != "" || len(u.Limits) != len(want) {
		t.Fatalf("usage %+v", u)
	}
	for i, l := range u.Limits {
		if l.Kind != want[i].Kind || l.Label != want[i].Label || l.Percent != want[i].Percent ||
			!l.ResetsAt.Equal(want[i].ResetsAt) || l.Severity != want[i].Severity || l.Active != want[i].Active {
			t.Errorf("limit %d = %+v, want %+v", i, l, want[i])
		}
	}
}

// Without usage_report the limits come from the text, in its time zone.
func TestParseUsageText(t *testing.T) {
	var lines []string
	for _, l := range strings.Split(strings.TrimSpace(string(usageFixture(t))), "\n") {
		var m map[string]any
		json.Unmarshal([]byte(l), &m)
		delete(m, "usage_report")
		b, _ := json.Marshal(m)
		lines = append(lines, string(b))
	}
	u, err := ParseUsage([]byte(strings.Join(lines, "\n")), usageNow)
	if err != nil {
		t.Fatal(err)
	}
	belgrade, _ := time.LoadLocation("Europe/Belgrade")
	want := []model.UsageLimit{
		{Kind: "session", Label: "Current session", Percent: 8, ResetsAt: time.Date(2026, 9, 27, 1, 9, 0, 0, belgrade)},
		{Kind: "weekly_all", Label: "Current week (all models)", Percent: 18, ResetsAt: time.Date(2026, 9, 28, 18, 59, 0, 0, belgrade)},
		{Kind: "weekly_scoped", Label: "Current week (Fable)", Percent: 2, ResetsAt: time.Date(2026, 9, 28, 18, 59, 0, 0, belgrade)},
	}
	if !u.Plan || len(u.Limits) != len(want) {
		t.Fatalf("usage %+v", u)
	}
	for i, l := range u.Limits {
		if l.Kind != want[i].Kind || l.Label != want[i].Label || l.Percent != want[i].Percent || !l.ResetsAt.Equal(want[i].ResetsAt) {
			t.Errorf("limit %d = %+v, want %+v", i, l, want[i])
		}
	}
}

func TestResetTime(t *testing.T) {
	belgrade, _ := time.LoadLocation("Europe/Belgrade")
	now := time.Date(2026, 12, 30, 22, 0, 0, 0, belgrade)
	cases := []struct {
		in   string
		want time.Time
	}{
		{"Jan 2 at 7pm", time.Date(2027, 1, 2, 19, 0, 0, 0, belgrade)}, // over the new year
		{"Dec 30 at 11:30pm", time.Date(2026, 12, 30, 23, 30, 0, 0, belgrade)},
		{"11:30pm", time.Date(2026, 12, 30, 23, 30, 0, 0, belgrade)},
		{"1:05am", time.Date(2026, 12, 31, 1, 5, 0, 0, belgrade)}, // a bare time already past is tomorrow
		{"soon", time.Time{}},
	}
	for _, c := range cases {
		if got := resetTime(c.in, "Europe/Belgrade", now); !got.Equal(c.want) {
			t.Errorf("resetTime(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// An API-key login prints no limits: no plan, and the first line as the note.
func TestParseUsageNoPlan(t *testing.T) {
	out := `{"type":"system","subtype":"init"}
{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"You are currently using API usage billing\n\nTotal cost: $0.00"}]}}
{"type":"result","subtype":"success"}`
	u, err := ParseUsage([]byte(out), usageNow)
	if err != nil {
		t.Fatal(err)
	}
	if u.Plan || u.Note != "You are currently using API usage billing" || u.Limits == nil || len(u.Limits) != 0 {
		t.Fatalf("usage %+v", u)
	}
	if _, err := ParseUsage([]byte(`{"type":"result","subtype":"success"}`), usageNow); err == nil {
		t.Fatal("no assistant line: want an error")
	}
}

func TestUsageArgs(t *testing.T) {
	args := UsageArgs()
	if args[0] != "-p" || args[1] != "/usage" || !slices.Contains(args, "--no-session-persistence") {
		t.Fatalf("args %v", args)
	}
	if slices.Contains(args, "--disable-slash-commands") {
		t.Fatal("--disable-slash-commands would send /usage to the model")
	}
}

func TestSpawnerUsage(t *testing.T) {
	f := newFake(t, strings.Split(strings.TrimSpace(string(usageFixture(t))), "\n")...)
	u, err := f.spawner().Usage()
	if err != nil {
		t.Fatal(err)
	}
	if !u.Plan || len(u.Limits) != 3 {
		t.Fatalf("usage %+v", u)
	}
	var rec struct {
		Cwd      string   `json:"cwd"`
		Args     []string `json:"args"`
		NoMemory string   `json:"noMemory"`
	}
	b, _ := os.ReadFile(f.args)
	json.Unmarshal(b, &rec)
	if !slices.Equal(rec.Args, UsageArgs()) || rec.NoMemory != "1" {
		t.Fatalf("ran with %+v", rec)
	}
	tmp, _ := filepath.EvalSymlinks(os.TempDir())
	if cwd, _ := filepath.EvalSymlinks(rec.Cwd); cwd != tmp {
		t.Fatalf("cwd %s, want %s", rec.Cwd, tmp)
	}
}

func TestSpawnerUsageError(t *testing.T) {
	newFake(t)
	t.Setenv(envScript, filepath.Join(t.TempDir(), "missing"))
	_, err := (&Spawner{Bin: os.Args[0]}).Usage()
	if err == nil || !strings.HasPrefix(err.Error(), "claude /usage: ") {
		t.Fatalf("err %v", err)
	}
}
