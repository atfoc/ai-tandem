package aliases

import (
	"os"
	"path/filepath"
	"slices"
	"strings"

	"ai-whiteboard/internal/container"
)

// CleanName is an account's name without the spaces around it; an empty one is ErrNoName.
func CleanName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", ErrNoName
	}
	return s, nil
}

// CleanImage is an account's image without the spaces around it. The default image is "", so
// that an account on the default follows the app's upgrades. An image that is not an image
// reference is an *ImageError (goal §1.8.2): it must start with a letter or a digit and hold
// only letters, digits and . _ - / : @ (no space, no control character), so that nothing of it
// can be read as an option of docker create (`--privileged`, `-v=/:/host`). Docker itself
// refuses a reference that passes this and is still not one.
func CleanImage(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" || s == container.DefaultImage() {
		return "", nil
	}
	if !imageRef(s) {
		return "", &ImageError{Image: s}
	}
	return s, nil
}

// imageRef reports whether s has the characters of an image reference (CleanImage).
func imageRef(s string) bool {
	for i, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case i > 0 && strings.ContainsRune("._-/:@", r):
		default:
			return false
		}
	}
	return len(s) <= 512
}

// CleanMounts checks the folders of an account (goal §1.2.4 and §1.8, D25) and returns them
// cleaned, in the given order; none is fine. The first refusal is a *FolderError naming the
// folder as given. A folder is refused when it is not an absolute path, does not exist, is not
// a folder, has a ":" in its path (docker create -v cannot mount it), is listed twice, is, contains
// or is inside home's .claude (skipped when home is ""), is or contains root, or is inside root.
// Paths are compared both as written and with their symbolic links resolved. A folder inside
// another listed folder is fine.
func CleanMounts(mounts []string, home, root string) ([]string, error) {
	var claude []string
	if home != "" {
		claude = pathForms(filepath.Join(home, ".claude"))
	}
	var data []string
	if root != "" {
		data = pathForms(root)
	}
	out := make([]string, 0, len(mounts))
	var seen []string // cleaned and resolved paths of the folders before
	for _, m := range mounts {
		refuse := func(why string) ([]string, error) { return nil, &FolderError{Folder: m, Why: why} }
		if m == "" || !filepath.IsAbs(m) {
			return refuse("is not an absolute path")
		}
		clean := filepath.Clean(m)
		fi, err := os.Stat(clean)
		if err != nil {
			return refuse("does not exist")
		}
		if !fi.IsDir() {
			return refuse("is not a folder")
		}
		// docker create -v <path>:<path> splits on ":" (a "," is fine: checked with Docker).
		if strings.Contains(clean[len(filepath.VolumeName(clean)):], ":") {
			return refuse("has a “:” in its path, which Docker cannot mount")
		}
		self := pathForms(clean)
		if slices.ContainsFunc(self, func(p string) bool { return slices.Contains(seen, p) }) {
			return refuse("is listed twice")
		}
		if holdsAny(self, claude) {
			return refuse("holds this computer's Claude login (~/.claude)")
		}
		if holdsAny(claude, self) {
			return refuse("is inside this computer's Claude folder (~/.claude)")
		}
		if holdsAny(self, data) {
			return refuse("holds the app's data folder")
		}
		if holdsAny(data, self) {
			return refuse("is inside the app's data folder")
		}
		seen = append(seen, self...)
		out = append(out, clean)
	}
	return out, nil
}

// pathForms is p cleaned, and p with its symbolic links resolved when that differs (and p
// exists).
func pathForms(p string) []string {
	p = filepath.Clean(p)
	out := []string{p}
	if r, err := filepath.EvalSymlinks(p); err == nil && r != p {
		out = append(out, r)
	}
	return out
}

// holdsAny reports whether one of outer is one of inner or a folder above it.
func holdsAny(outer, inner []string) bool {
	for _, o := range outer {
		for _, i := range inner {
			if Under([]string{o}, i) {
				return true
			}
		}
	}
	return false
}
