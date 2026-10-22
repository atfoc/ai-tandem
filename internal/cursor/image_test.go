//go:build !windows

package cursor

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// promptTexts are the blocks of the one session/prompt in the record, which must all be text.
func promptTexts(t *testing.T, record string) []string {
	t.Helper()
	pr, ok := find(readRecord(t, record), "session/prompt")
	if !ok {
		t.Fatal("no session/prompt in the record")
	}
	var params struct {
		Prompt []struct{ Type, Text string } `json:"prompt"`
	}
	if err := json.Unmarshal(pr.Params, &params); err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, b := range params.Prompt {
		if b.Type != "text" {
			t.Errorf("a %q block in the prompt: %s", b.Type, pr.Params)
		}
		out = append(out, b.Text)
	}
	return out
}

// imagePath returns the file an image's text block names, and checks the sentence around it.
func imagePath(t *testing.T, text, before, kind string) string {
	t.Helper()
	after := " (" + kind + "). Open it with your file tools."
	if !strings.HasPrefix(text, before+" Image file: ") || !strings.HasSuffix(text, after) {
		t.Fatalf("text %q, want %q, the file and %q", text, before+" Image file: ", after)
	}
	return text[len(before+" Image file: ") : len(text)-len(after)]
}

// An attached image reaches Cursor as a file named in the message text with its type, in the
// image's place before the user's text; no image block is sent. The file holds the image's bytes
// in the private folder, readable by the user alone.
func TestSendImageAsFile(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	dir := filepath.Join(t.TempDir(), "imgs")
	e.s.Images = agent.ImageFiles{Dir: dir}
	a := e.spawn(t, agent.SpawnOptions{ChatID: "c1"})
	png, gif := []byte("\x89PNG\r\n\x1a\nbytes"), []byte("GIF89a\x00\xff")
	if err := a.Send([]agent.ContentBlock{
		{Text: "<ui-context>x</ui-context>"},
		{Image: &agent.Image{Name: `shot "one".png`, Type: "image/png", Data: png}},
		{Image: &agent.Image{Type: "image/gif", Data: gif}, Text: "not looked at"},
		{Text: ""},
		{Text: "what is on these?"},
	}); err != nil {
		t.Fatal(err)
	}
	until(t, a, isKind(agent.EvTurnEnd))

	texts := promptTexts(t, e.record)
	if len(texts) != 4 || texts[0] != "<ui-context>x</ui-context>" || texts[3] != "what is on these?" {
		t.Fatalf("prompt texts %q", texts)
	}
	for i, c := range []struct {
		before, kind, ext string
		data              []byte
	}{
		{`The user attached an image, "shot \"one\".png".`, "PNG", ".png", png},
		{"The user attached an image.", "GIF", ".gif", gif},
	} {
		path := imagePath(t, texts[1+i], c.before, c.kind)
		if !filepath.IsAbs(path) || filepath.Dir(path) != dir || filepath.Ext(path) != c.ext {
			t.Errorf("image %d: path %q", i, path)
		}
		if b, err := os.ReadFile(path); err != nil || string(b) != string(c.data) {
			t.Errorf("image %d: file %q: %v %q", i, path, err, b)
		}
		if runtime.GOOS == "windows" {
			continue
		}
		if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
			t.Errorf("image %d: file %v %v", i, fi, err)
		}
	}
	if runtime.GOOS != "windows" {
		if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
			t.Errorf("dir %v %v", fi, err)
		}
	}
}

// A message of images alone has an empty text: the prompt is the image's text block alone.
func TestSendImageAlone(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	e.s.Images = agent.ImageFiles{Dir: filepath.Join(t.TempDir(), "imgs")}
	a := e.spawn(t, agent.SpawnOptions{ChatID: "c1"})
	if err := a.Send([]agent.ContentBlock{{Image: &agent.Image{Name: "Pasted image", Type: "image/jpeg", Data: []byte("\xff\xd8\xff")}}, {Text: ""}}); err != nil {
		t.Fatal(err)
	}
	until(t, a, isKind(agent.EvTurnEnd))
	texts := promptTexts(t, e.record)
	if len(texts) != 1 {
		t.Fatalf("prompt texts %q", texts)
	}
	imagePath(t, texts[0], `The user attached an image, "Pasted image".`, "JPEG")
}

// With no folder set the file goes where a get_image picture goes: the user's own folder in the
// OS temp dir, not the app's data folder, which Cursor is denied.
func TestSendImageDefaultDirIsInTempNotDataFolder(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	t.Setenv("TEMP", tmp)
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{ChatID: "c1"})
	if err := a.Send([]agent.ContentBlock{{Image: &agent.Image{Name: "a.webp", Type: "image/webp", Data: []byte("RIFF")}}, {Text: "look"}}); err != nil {
		t.Fatal(err)
	}
	until(t, a, isKind(agent.EvTurnEnd))
	path := imagePath(t, promptTexts(t, e.record)[0], `The user attached an image, "a.webp".`, "WEBP")
	if want := filepath.Join(tmp, fmt.Sprintf("aiwb-images-%d", os.Getuid())); filepath.Dir(path) != want {
		t.Errorf("path %q is not in %q", path, want)
	}
	if strings.HasPrefix(path, e.s.AppRoot) {
		t.Errorf("path %q is under the data folder %q", path, e.s.AppRoot)
	}
	if _, err := os.Stat(path); err != nil {
		t.Error(err)
	}
}

// When the file goes: it is still there when the turn has ended, and it is removed by the next
// image that is written once it is older than the age (an hour; the test lowers it).
func TestSendImageFileGoesAfterItsAge(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	dir := filepath.Join(t.TempDir(), "imgs")
	e.s.Images = agent.ImageFiles{Dir: dir, MaxAge: time.Minute}
	a := e.spawn(t, agent.SpawnOptions{ChatID: "c1"})
	sendImage := func() string {
		t.Helper()
		if err := a.Send([]agent.ContentBlock{{Image: &agent.Image{Type: "image/png", Data: []byte("x")}}, {Text: "look"}}); err != nil {
			t.Fatal(err)
		}
		until(t, a, isKind(agent.EvTurnEnd))
		es, err := filepath.Glob(filepath.Join(dir, "img-*.png"))
		if err != nil || len(es) == 0 {
			t.Fatalf("files %v %v", es, err)
		}
		newest, at := "", time.Time{}
		for _, p := range es {
			if fi, err := os.Stat(p); err == nil && fi.ModTime().After(at) {
				newest, at = p, fi.ModTime()
			}
		}
		return newest
	}
	first := sendImage()
	if _, err := os.Stat(first); err != nil {
		t.Fatalf("the file is gone when the turn has ended: %v", err)
	}
	send(t, a, "a turn without an image")
	until(t, a, isKind(agent.EvTurnEnd))
	past := time.Now().Add(-2 * time.Minute)
	if err := os.Chtimes(first, past, past); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(first); err != nil {
		t.Fatalf("a turn without an image removed the file: %v", err)
	}
	second := sendImage()
	if _, err := os.Stat(first); !os.IsNotExist(err) {
		t.Errorf("the old file is still there: %v", err)
	}
	if _, err := os.Stat(second); err != nil || second == first {
		t.Errorf("the new file %q: %v", second, err)
	}
}

// An image that cannot be written fails the Send: nothing is sent to Cursor, no turn begins, and
// the files already written for the message are removed.
func TestSendImageWriteFailure(t *testing.T) {
	t.Parallel()
	t.Run("the folder cannot be made", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, baseScript())
		blocker := filepath.Join(t.TempDir(), "file")
		if err := os.WriteFile(blocker, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		e.s.Images = agent.ImageFiles{Dir: filepath.Join(blocker, "imgs")} // below a file
		a := e.spawn(t, agent.SpawnOptions{ChatID: "c1"})
		err := a.Send([]agent.ContentBlock{{Image: &agent.Image{Type: "image/png", Data: []byte("x")}}, {Text: "look"}})
		if err == nil || !strings.HasPrefix(err.Error(), "could not save the attached image for Cursor to open: ") {
			t.Fatalf("Send error %v", err)
		}
		a.Close()
		onlyHandshakeMethods(t, readRecord(t, e.record)) // no prompt
	})
	t.Run("the second image is refused", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t, baseScript())
		dir := filepath.Join(t.TempDir(), "imgs")
		e.s.Images = agent.ImageFiles{Dir: dir}
		a := e.spawn(t, agent.SpawnOptions{ChatID: "c1"})
		err := a.Send([]agent.ContentBlock{
			{Image: &agent.Image{Type: "image/png", Data: []byte("x")}},
			{Image: &agent.Image{Type: "image/svg+xml", Data: []byte("<svg/>")}},
			{Text: "look"},
		})
		if err == nil || !strings.Contains(err.Error(), "unsupported image type") {
			t.Fatalf("Send error %v", err)
		}
		a.Close()
		onlyHandshakeMethods(t, readRecord(t, e.record))
		if es, _ := os.ReadDir(dir); len(es) != 0 {
			t.Errorf("%d files were left", len(es))
		}
	})
}

// A message with nothing in it is refused before anything is sent.
func TestSendEmptyMessage(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{ChatID: "c1"})
	if err := a.Send([]agent.ContentBlock{{}, {Text: ""}}); err == nil {
		t.Fatal("an empty message was sent")
	}
	a.Close()
	onlyHandshakeMethods(t, readRecord(t, e.record))
}

// No Cursor model is marked as taking no images: Cursor reports nothing per model.
func TestNoCursorModelIsMarkedNoImages(t *testing.T) {
	t.Parallel()
	_, file := loadModelList(t)
	for _, c := range []*model.Catalog{file, ParseModelList(fakeModels)} {
		if c == nil || len(c.Models) == 0 {
			t.Fatalf("catalog %+v", c)
		}
		for _, m := range c.Models {
			if m.NoImages {
				t.Errorf("model %s is marked", m.ID)
			}
		}
	}
}
