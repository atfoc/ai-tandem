package boardapi

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// imageMaxAge is how long a picture file written for a Cursor agent is kept.
const imageMaxAge = time.Hour

// imageFilePrefix starts the name of every file this package writes in the image directory; a
// sweep deletes nothing else.
const imageFilePrefix = "img-"

var imageExt = map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}

// imageDir is the private directory the pictures for Cursor agents are written to: under the OS
// temp dir, never under the app's data folder (the Cursor deny rules and the agent guards cover
// that folder, so the agent could not open a file there).
func (r *Relay) imageDir() string {
	if r.ImageDir != "" {
		return r.ImageDir
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("aiwb-images-%d", os.Getuid()))
}

func (r *Relay) imageAge() time.Duration {
	if r.ImageMaxAge > 0 {
		return r.ImageMaxAge
	}
	return imageMaxAge
}

// imageToFile turns a result with a picture into a text-only result: the picture is written to a
// file and its absolute path is added to the text. A Cursor agent is not handed an image part (it
// cannot take one), but it can open a file. A result without a picture is returned as it is; a
// write failure is an error result, never a silent drop.
func (r *Relay) imageToFile(tool string, res ToolResult) ToolResult {
	if res.IsErr || res.Image == nil {
		return res
	}
	path, err := r.writeImage(res.Image)
	if err != nil {
		return errResult(fmt.Sprintf("%s: could not save the image for you to open: %v", tool, err))
	}
	kind := strings.ToUpper(imageExt[res.Image.MimeType])
	if kind == "JPG" {
		kind = "JPEG"
	}
	return textResult(fmt.Sprintf("%s Image file: %s (%s). Open it with your file tools.", res.Text, path, kind), false)
}

// writeImage removes the files that are too old, then writes the picture to a new file (0600) in
// the private directory (0700) and returns its absolute path.
func (r *Relay) writeImage(img *Image) (string, error) {
	data, err := base64.StdEncoding.DecodeString(img.Data)
	if err != nil {
		return "", err
	}
	dir, err := filepath.Abs(r.imageDir())
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
	sweepImages(dir, r.imageAge())
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	path := filepath.Join(dir, imageFilePrefix+hex.EncodeToString(id[:])+"."+imageExt[img.MimeType])
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(path)
		return "", err
	}
	if err := f.Close(); err != nil {
		os.Remove(path)
		return "", err
	}
	return path, nil
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
