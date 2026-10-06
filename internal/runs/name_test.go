package runs

import "testing"

func TestNameFromGoal(t *testing.T) {
	for _, c := range []struct{ goal, want string }{
		{"# QA of the last few features: verify, review, debug and fix\n\n## What to do\n", "QA of the last few features: verify, review, debug and fix"},
		{"create a plan how to build a feature that allows this app to have multiple remote servers", "Create a plan how to build a feature that allows this app to…"},
		{"Bring the \"autobuild\" run process into this app as a new first-class thing called a run.\n\nReference", "Bring the \"autobuild\" run process into this app as a new…"},
		{"", ""}, {"   \n---\n", ""}, {"# Fix the login bug\nmore", "Fix the login bug"}, {"fix it", "Fix it"},
		{"- [ ] Add dark mode to the settings page, and make sure every dialog follows it", "Add dark mode to the settings page, and make sure every…"},
		{"Why does `go test ./...` fail on CI? Find out and fix it.", "Why does go test ./... fail on CI?"},
		{"Add OAuth.\nThen ship.", "Add OAuth."}, {"Add OAuth to the login page. Then ship.", "Add OAuth to the login page"},
		{"See [the plan](https://example.com/p) and build step 2", "See the plan and build step 2"},
		{"Сделай тёмную тему для всех диалогов приложения.", "Сделай тёмную тему для всех диалогов приложения"},
	} {
		if got := NameFromGoal(c.goal); got != c.want {
			t.Errorf("NameFromGoal(%q) = %q, want %q", c.goal, got, c.want)
		}
	}
}

func TestCleanName(t *testing.T) {
	if n, err := CleanName("  My  first run "); err != nil || n != "My first run" {
		t.Errorf("got %q, %v", n, err)
	}
	for _, bad := range []string{"", "   ", "a\x00b", string(make([]rune, 0)) + "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"} {
		if _, err := CleanName(bad); err == nil {
			t.Errorf("CleanName(%q) accepted", bad)
		}
	}
	if _, err := CleanName("a/b: c"); err != nil {
		t.Errorf("a slash and a colon are fine in a label: %v", err)
	}
}
