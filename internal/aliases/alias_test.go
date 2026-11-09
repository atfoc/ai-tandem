package aliases

import (
	"slices"
	"testing"

	"ai-whiteboard/internal/container"
)

func TestRestartRules(t *testing.T) {
	a := Alias{ID: "a_k3j2m9x0", Name: "Work", Mounts: []string{"/w/one", "/w/two"}}
	if a.SpecDiffers() || a.Pending() != nil {
		t.Fatal("an account with no container differs or has pending folders")
	}
	a.Applied = &Applied{Image: container.DefaultImage(), Mounts: []string{"/w/two/", "/w/one"}}
	if a.SpecDiffers() || len(a.Pending()) != 0 {
		t.Fatalf("the same mounts in another order differ: %v", a.Pending())
	}
	a.Mounts = append(a.Mounts, "/w/three")
	if !a.SpecDiffers() || !slices.Equal(a.Pending(), []string{"/w/three"}) {
		t.Fatalf("a new folder: differs %v, pending %v", a.SpecDiffers(), a.Pending())
	}
	a.Mounts = []string{"/w/one", "/w/two"}
	a.Image = "mine:1"
	if !a.SpecDiffers() || len(a.Pending()) != 0 {
		t.Fatal("another image does not differ")
	}
	if a.Kind() != "claude:a_k3j2m9x0" {
		t.Fatalf("Kind = %q", a.Kind())
	}
}

// An update of the app changes the default image's tag: an account on the default image whose
// container was made from another tag of it does not differ (it takes the new image at its next
// create); a custom image, or a change of folders, still does.
func TestSpecDiffersAfterAnUpdate(t *testing.T) {
	old := container.DefaultImageRepo + ":0.0.1-old"
	if old == container.DefaultImage() {
		t.Fatal("the test's old tag is the default")
	}
	a := Alias{ID: "a_k3j2m9x0", Mounts: []string{"/w/one"},
		Applied: &Applied{Image: old, Default: true, Mounts: []string{"/w/one"}}}
	if a.SpecDiffers() || len(a.Pending()) != 0 {
		t.Fatal("an old tag of the default image differs")
	}
	// Review finding #9: a container made from an image the person named, of the default's
	// repository, is not the default: going back to the default needs a restart.
	custom := a.deepCopy()
	custom.Applied.Default = false
	custom.Applied.Image = container.DefaultImageRepo + ":mine"
	if !custom.SpecDiffers() {
		t.Error("back to the default from aiwb/claude:mine does not differ")
	}
	a.Mounts = []string{"/w/one", "/w/two"}
	if !a.SpecDiffers() || !slices.Equal(a.Pending(), []string{"/w/two"}) {
		t.Fatalf("a new folder on an old default tag: differs %v, pending %v", a.SpecDiffers(), a.Pending())
	}
	a.Mounts = []string{"/w/one"}
	for _, image := range []string{"mine:1", old, container.DefaultImageRepo + ":other"} {
		a.Image = image
		if image == old {
			if a.SpecDiffers() {
				t.Errorf("custom image %q equal to the applied one differs", image)
			}
			continue
		}
		if !a.SpecDiffers() {
			t.Errorf("custom image %q over %q does not differ", image, old)
		}
	}
	// A container made from a custom image, the account now on the default: it differs.
	a.Image = ""
	for _, applied := range []string{"mine:1", "aiwb/claudex:1", "other/aiwb/claude:1"} {
		a.Applied.Image = applied
		if !a.SpecDiffers() {
			t.Errorf("applied %q, account on the default: does not differ", applied)
		}
	}
}

func TestKindOfAlias(t *testing.T) {
	a := Alias{ID: "a_k3j2m9x0"}
	if a.Kind() != "claude:a_k3j2m9x0" {
		t.Fatalf("Kind = %q", a.Kind())
	}
}

func TestUnder(t *testing.T) {
	m := []string{"/w/one", "/x/"}
	for dir, want := range map[string]bool{
		"/w/one": true, "/w/one/": true, "/w/one/a/b": true, "/x": true, "/x/y": true,
		"/w/onex": false, "/w": false, "/": false, "/y": false,
	} {
		if got := Under(m, dir); got != want {
			t.Errorf("Under(%v, %q) = %v", m, dir, got)
		}
	}
	if !Under([]string{"/"}, "/any") {
		t.Error("everything is under /")
	}
}
