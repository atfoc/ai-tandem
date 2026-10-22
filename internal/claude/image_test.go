//go:build !windows

package claude

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"ai-whiteboard/internal/agent"
)

// An attached image reaches Claude as an image part of the user message, in its place before the
// user's text: base64 with its type, nothing of its name, and no file.
func TestSendImagePart(t *testing.T) {
	f := newFake(t)
	a, err := f.spawner().Spawn(agent.SpawnOptions{SessionID: "s1", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	png, gif := []byte("\x89PNG\r\n\x1a\nbytes"), []byte("GIF89a\x00\xff")
	if err := a.Send([]agent.ContentBlock{
		{Text: "<ui-context>x</ui-context>"},
		{Image: &agent.Image{Name: "shot.png", Type: "image/png", Data: png}},
		{Image: &agent.Image{Name: "anim.gif", Type: "image/gif", Data: gif}, Text: "not looked at"},
		{Text: "what is on these?"},
	}); err != nil {
		t.Fatal(err)
	}
	lines := skipInit(t, f.stdinLines(t, a))
	if len(lines) != 1 {
		t.Fatalf("stdin = %v", lines)
	}
	b, _ := json.Marshal(lines[0])
	want := `{"type":"user","message":{"role":"user","content":[
		{"type":"text","text":"<ui-context>x</ui-context>"},
		{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + base64.StdEncoding.EncodeToString(png) + `"}},
		{"type":"image","source":{"type":"base64","media_type":"image/gif","data":"` + base64.StdEncoding.EncodeToString(gif) + `"}},
		{"type":"text","text":"what is on these?"}]}}`
	if !jsonEqual(b, json.RawMessage(want)) {
		t.Errorf("send line %s\nwant %s", b, want)
	}
}

// A message of images alone has an empty text: the image part goes alone, with no empty text
// part. A message with nothing in it is refused and nothing is written to Claude.
func TestSendImageAloneAndEmpty(t *testing.T) {
	f := newFake(t)
	a, err := f.spawner().Spawn(agent.SpawnOptions{SessionID: "s1", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Send([]agent.ContentBlock{{}, {Text: ""}}); err == nil {
		t.Error("an empty message was sent")
	}
	webp := []byte("RIFF\x00\x00\x00\x00WEBP")
	if err := a.Send([]agent.ContentBlock{{Image: &agent.Image{Type: "image/webp", Data: webp}}, {Text: ""}}); err != nil {
		t.Fatal(err)
	}
	lines := skipInit(t, f.stdinLines(t, a))
	if len(lines) != 1 {
		t.Fatalf("stdin = %v", lines)
	}
	b, _ := json.Marshal(lines[0])
	want := `{"type":"user","message":{"role":"user","content":[
		{"type":"image","source":{"type":"base64","media_type":"image/webp","data":"` + base64.StdEncoding.EncodeToString(webp) + `"}}]}}`
	if !jsonEqual(b, json.RawMessage(want)) {
		t.Errorf("send line %s\nwant %s", b, want)
	}
}

// No Claude model is marked as taking no images: not in the built-in list, and not in a list the
// CLI reported.
func TestNoClaudeModelIsMarkedNoImages(t *testing.T) {
	for _, m := range Catalog.Models {
		if m.NoImages {
			t.Errorf("built-in model %s is marked", m.ID)
		}
	}
	cat := mapped(t, fixtureLine(t, "initialize.json"))
	if len(cat.Models) == 0 {
		t.Fatal("the reported list is empty")
	}
	for _, m := range cat.Models {
		if m.NoImages {
			t.Errorf("reported model %s is marked", m.ID)
		}
	}
}
