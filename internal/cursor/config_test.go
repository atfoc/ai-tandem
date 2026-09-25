package cursor

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

const testRoot = "/Users/me/.ai-whiteboard"

var wantRules = []string{"Read(" + testRoot + "/**)", "Write(" + testRoot + "/**)"}

// withConfig points CURSOR_CONFIG_DIR at a temp folder and, when content is not nil,
// writes it there as cli-config.json with the given mode. It returns the file's path.
func withConfig(t *testing.T, content *string, mode os.FileMode) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CURSOR_CONFIG_DIR", dir)
	path := filepath.Join(dir, "cli-config.json")
	if content != nil {
		if err := os.WriteFile(path, []byte(*content), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func readConfig(t *testing.T, path string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(b, &cfg); err != nil {
		t.Fatalf("config is not JSON: %v\n%s", err, b)
	}
	return cfg
}

func denyList(t *testing.T, cfg map[string]any) []string {
	t.Helper()
	perms, ok := cfg["permissions"].(map[string]any)
	if !ok {
		t.Fatalf("permissions missing: %v", cfg)
	}
	raw, ok := perms["deny"].([]any)
	if !ok {
		t.Fatalf("permissions.deny missing: %v", perms)
	}
	var out []string
	for _, r := range raw {
		out = append(out, r.(string))
	}
	return out
}

func count(list []string, s string) int {
	n := 0
	for _, x := range list {
		if x == s {
			n++
		}
	}
	return n
}

func strp(s string) *string { return &s }

func TestEnsureDenyRulesAddsOnceAndKeepsKeys(t *testing.T) {
	path := withConfig(t, strp(`{
  "version": 1,
  "editor": {"vimMode": true},
  "model": {"modelId": "gpt-5"},
  "permissions": {"allow": ["Shell(ls)"], "deny": ["Shell(rm)"]}
}`), 0o600)

	for i := 0; i < 3; i++ {
		if err := EnsureDenyRules(testRoot); err != nil {
			t.Fatalf("run %d: %v", i, err)
		}
	}
	cfg := readConfig(t, path)
	deny := denyList(t, cfg)
	for _, r := range wantRules {
		if count(deny, r) != 1 {
			t.Errorf("rule %q appears %d times in %v", r, count(deny, r), deny)
		}
	}
	if count(deny, "Shell(rm)") != 1 || len(deny) != 3 {
		t.Errorf("deny = %v", deny)
	}
	perms := cfg["permissions"].(map[string]any)
	if allow := perms["allow"].([]any); len(allow) != 1 || allow[0] != "Shell(ls)" {
		t.Errorf("allow = %v", allow)
	}
	if cfg["version"] != float64(1) {
		t.Errorf("version = %v", cfg["version"])
	}
	if ed := cfg["editor"].(map[string]any); ed["vimMode"] != true {
		t.Errorf("editor = %v", ed)
	}
	if m := cfg["model"].(map[string]any); m["modelId"] != "gpt-5" {
		t.Errorf("model = %v", m)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestEnsureDenyRulesNoWriteWhenPresent(t *testing.T) {
	content := `{"permissions":{"allow":[],"deny":["Read(` + testRoot + `/**)","Write(` + testRoot + `/**)"]}}`
	path := withConfig(t, strp(content), 0o644)
	if err := EnsureDenyRules(testRoot); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != content {
		t.Errorf("file rewritten although nothing was added:\n%s", b)
	}
}

func TestEnsureDenyRulesAddsMissingOne(t *testing.T) {
	path := withConfig(t, strp(`{"permissions":{"allow":[],"deny":["Read(`+testRoot+`/**)"]}}`), 0o640)
	if err := EnsureDenyRules(testRoot); err != nil {
		t.Fatal(err)
	}
	deny := denyList(t, readConfig(t, path))
	if len(deny) != 2 || count(deny, wantRules[0]) != 1 || count(deny, wantRules[1]) != 1 {
		t.Errorf("deny = %v", deny)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o640 {
		t.Errorf("mode = %v, want 0640", info.Mode().Perm())
	}
}

func TestEnsureDenyRulesCreatesDeny(t *testing.T) {
	path := withConfig(t, strp(`{"permissions":{"allow":["Shell(ls)"]},"other":"x"}`), 0o644)
	if err := EnsureDenyRules(testRoot); err != nil {
		t.Fatal(err)
	}
	cfg := readConfig(t, path)
	deny := denyList(t, cfg)
	if len(deny) != 2 || deny[0] != wantRules[0] || deny[1] != wantRules[1] {
		t.Errorf("deny = %v", deny)
	}
	if allow := cfg["permissions"].(map[string]any)["allow"].([]any); len(allow) != 1 {
		t.Errorf("allow = %v", allow)
	}
	if cfg["other"] != "x" {
		t.Errorf("other = %v", cfg["other"])
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o644 {
		t.Errorf("mode = %v, want 0644", info.Mode().Perm())
	}
}

func TestEnsureDenyRulesCreatesPermissions(t *testing.T) {
	path := withConfig(t, strp(`{"version":1}`), 0o600)
	if err := EnsureDenyRules(testRoot); err != nil {
		t.Fatal(err)
	}
	cfg := readConfig(t, path)
	deny := denyList(t, cfg)
	if len(deny) != 2 {
		t.Errorf("deny = %v", deny)
	}
	if allow, ok := cfg["permissions"].(map[string]any)["allow"].([]any); !ok || len(allow) != 0 {
		t.Errorf("allow = %v", cfg["permissions"])
	}
	if cfg["version"] != float64(1) {
		t.Errorf("version = %v", cfg["version"])
	}
}

func TestEnsureDenyRulesMissingFile(t *testing.T) {
	path := withConfig(t, nil, 0)
	if err := EnsureDenyRules(testRoot); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("config file created: %v", err)
	}
}

func TestEnsureDenyRulesInvalidJSON(t *testing.T) {
	content := `{"permissions": {"deny": [` // truncated
	path := withConfig(t, strp(content), 0o600)
	if err := EnsureDenyRules(testRoot); err == nil {
		t.Fatal("want an error for invalid JSON")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != content {
		t.Errorf("invalid config was overwritten:\n%s", b)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Errorf("stray files left: %v", entries)
	}
}

func TestEnsureDenyRulesDefaultPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CURSOR_CONFIG_DIR", "")
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".cursor")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "cli-config.json")
	if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDenyRules(testRoot); err != nil {
		t.Fatal(err)
	}
	if deny := denyList(t, readConfig(t, path)); len(deny) != 2 {
		t.Errorf("deny = %v", deny)
	}
}
