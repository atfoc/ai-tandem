package pi

import (
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"

	"ai-whiteboard/internal/agent"
)

// The attached images go in the prompt command's images list, each in pi's ImageContent form, in
// the order they were attached, and the texts are joined as before. No file is written for them.
// That the model gets them before the text is the extension's (pibridge: TestImageOrderNode, and
// TestRealPiImageBeforeText with the real pi).
func TestSendImagesInThePromptCommand(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	t.Setenv("TEMP", tmp)
	f := newFake(t)
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	jpeg, webp := []byte("\xff\xd8\xff\xe0bytes"), []byte("RIFF\x00\x00\x00\x00WEBP")
	if err := a.Send([]agent.ContentBlock{
		{Text: "<ui-context>x</ui-context>"},
		{Image: &agent.Image{Name: "photo.jpg", Type: "image/jpeg", Data: jpeg}},
		{Image: &agent.Image{Name: "Pasted image", Type: "image/webp", Data: webp}, Text: "not looked at"},
		{Text: "what is on these?"},
	}); err != nil {
		t.Fatal(err)
	}
	lines := f.stdinLines(t, a)
	if got := commandTypes(lines); !equalStrings(got, []string{"get_state", "get_available_models", "prompt"}) {
		t.Fatalf("commands %q", got)
	}
	prompt := lines[2]
	delete(prompt, "id")
	var want map[string]any
	if err := json.Unmarshal([]byte(`{"type":"prompt","message":"<ui-context>x</ui-context>\n\nwhat is on these?","images":[
		{"type":"image","data":"`+base64.StdEncoding.EncodeToString(jpeg)+`","mimeType":"image/jpeg"},
		{"type":"image","data":"`+base64.StdEncoding.EncodeToString(webp)+`","mimeType":"image/webp"}]}`), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(prompt, want) {
		t.Errorf("prompt command %v\nwant %v", prompt, want)
	}
	if es, _ := filepath.Glob(filepath.Join(tmp, "aiwb-images-*")); len(es) != 0 {
		t.Errorf("an image folder was made in the temp dir: %v", es)
	}
}

// A message of images alone is a prompt with an empty message and the images. A message without
// images has no images field at all.
func TestSendImagesAloneAndNone(t *testing.T) {
	f := newFake(t)
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	png := []byte("\x89PNG\r\n\x1a\nbytes")
	if err := a.Send([]agent.ContentBlock{{Image: &agent.Image{Type: "image/png", Data: png}}, {Text: ""}}); err != nil {
		t.Fatal(err)
	}
	if err := a.Send([]agent.ContentBlock{{Text: "words"}}); err != nil {
		t.Fatal(err)
	}
	lines := f.stdinLines(t, a)
	if got := commandTypes(lines); !equalStrings(got, []string{"get_state", "get_available_models", "prompt", "prompt"}) {
		t.Fatalf("commands %q", got)
	}
	alone, none := lines[2], lines[3]
	wantImages := []any{map[string]any{"type": "image", "data": base64.StdEncoding.EncodeToString(png), "mimeType": "image/png"}}
	if alone["message"] != "" || !reflect.DeepEqual(alone["images"], wantImages) {
		t.Errorf("prompt of an image alone: message %q, images %v", alone["message"], alone["images"])
	}
	if _, has := none["images"]; has || none["message"] != "words" {
		t.Errorf("prompt without images: %v", none)
	}
}

// The mark of a model that takes no images comes from pi's own model list: a model whose input
// list has no "image" is marked. One that names "image", and one with no list, is not.
func TestCatalogNoImagesFromInput(t *testing.T) {
	models := json.RawMessage(`{"models":[
		{"id":"vision","provider":"p","input":["text","image"]},
		{"id":"text-only","provider":"p","input":["text"]},
		{"id":"no-list","provider":"p"},
		{"id":"empty-list","provider":"p","input":[]},
		{"id":"null-list","provider":"p","input":null}
	]}`)
	cat := catalogFrom(nil, models)
	if cat == nil || len(cat.Models) != 5 {
		t.Fatalf("catalog %+v", cat)
	}
	want := map[string]bool{"p/vision": false, "p/text-only": true, "p/no-list": false, "p/empty-list": false, "p/null-list": false}
	for _, m := range cat.Models {
		if m.NoImages != want[m.ID] {
			t.Errorf("%s: NoImages %v, want %v", m.ID, m.NoImages, want[m.ID])
		}
	}
	// The mark is in the catalog's JSON only for a marked model, so a reader that does not know
	// it sees the catalog it always saw.
	b, _ := json.Marshal(cat.Models)
	var rows []map[string]any
	json.Unmarshal(b, &rows)
	for _, r := range rows {
		if _, has := r["noImages"]; has != want[r["id"].(string)] {
			t.Errorf("%s: noImages in the JSON %v", r["id"], has)
		}
	}
}
