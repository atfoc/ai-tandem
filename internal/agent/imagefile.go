package agent

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// imageMaxAge is how long a picture file written for an agent is kept.
const imageMaxAge = time.Hour

// imageFilePrefix starts the name of every file ImageFiles writes in its directory; a sweep
// deletes nothing else.
const imageFilePrefix = "img-"

var imageExt = map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}

// ImageFiles writes pictures to files for an agent that is not handed an image part but can open
// a file (Cursor): a picture of a board (get_image) and an image the user attached to a message.
// The zero value is the one both use.
type ImageFiles struct {
	// Dir is the private directory the files are written to. Empty means aiwb-images-<uid> in the
	// OS temp dir, never under the app's data folder (the Cursor deny rules and the agent guards
	// cover that folder, so the agent could not open a file there).
	Dir string
	// MaxAge is how long a file is kept; zero means an hour.
	MaxAge time.Duration
}

func (f ImageFiles) dir() string {
	if f.Dir != "" {
		return f.Dir
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("aiwb-images-%d", os.Getuid()))
}

func (f ImageFiles) age() time.Duration {
	if f.MaxAge > 0 {
		return f.MaxAge
	}
	return imageMaxAge
}

// Write removes the files that are too old, then writes the picture to a new file (0600) in the
// private directory (0700) and returns its absolute path. A type that is not one of
// model.ImageTypes is refused.
func (f ImageFiles) Write(mimeType string, data []byte) (string, error) {
	ext, ok := imageExt[mimeType]
	if !ok {
		return "", fmt.Errorf("unsupported image type %q", mimeType)
	}
	dir, err := filepath.Abs(f.dir())
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() { // not a link to somewhere else
		return "", fmt.Errorf("%s is not a directory", dir)
	}
	if err := os.Chmod(dir, 0o700); err != nil { // fails on a directory that is not ours
		return "", err
	}
	sweepImages(dir, f.age())
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	path := filepath.Join(dir, imageFilePrefix+hex.EncodeToString(id[:])+"."+ext)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		os.Remove(path)
		return "", err
	}
	if err := file.Close(); err != nil {
		os.Remove(path)
		return "", err
	}
	return path, nil
}

// ImageFileText is the sentence that names a file Write made, with the picture's type, for the
// text the agent is given.
func ImageFileText(path, mimeType string) string {
	kind := strings.ToUpper(imageExt[mimeType])
	if kind == "JPG" {
		kind = "JPEG"
	}
	return fmt.Sprintf("Image file: %s (%s). Open it with your file tools.", path, kind)
}

// sweepImages deletes the picture files in dir that were last written more than maxAge ago.
func sweepImages(dir string, maxAge time.Duration) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-maxAge)
	for _, e := range entries {
		if !e.Type().IsRegular() || !strings.HasPrefix(e.Name(), imageFilePrefix) {
			continue
		}
		if fi, err := e.Info(); err == nil && fi.ModTime().Before(cutoff) {
			os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
