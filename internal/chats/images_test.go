package chats

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/testset"
)

// ---- fixtures -------------------------------------------------------------

// pic is a small file that starts as a PNG does and differs by seed.
func pic(seed string) []byte { return append([]byte("\x89PNG\r\n\x1a\n"), seed...) }

// idOf is the id an image with these bytes has.
func idOf(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// upload puts pic(seed) into the chat as a page does, under the name <seed>.png.
func (e *env) upload(id, seed string) model.Image {
	e.t.Helper()
	img, err := e.m.UploadImage(id, seed+".png", "image/png", pic(seed))
	if err != nil {
		e.t.Fatalf("upload %s: %v", seed, err)
	}
	return img
}

// later moves the managers' clock on by d.
func (e *env) later(d time.Duration) { e.clock.Add(d.Milliseconds()) }

// holds says whether a fetch of the image from the chat is answered.
func (e *env) holds(id, image string) bool {
	_, _, err := e.m.Image(id, image)
	if err != nil && !errors.Is(err, ErrNoImage) {
		e.t.Helper()
		e.t.Fatalf("fetch of %s: %v", image, err)
	}
	return err == nil
}

// imageFiles is the names of the image files in the chat's store, sorted; nil with no folder.
func (e *env) imageFiles(id string) []string {
	e.t.Helper()
	ents, err := os.ReadDir(e.m.imagesDir(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		e.t.Fatal(err)
	}
	out := []string{}
	for _, en := range ents {
		if en.Name() != imageIndexFile {
			out = append(out, en.Name())
		}
	}
	sort.Strings(out)
	return out
}

// imageIndex is index.json of the chat's store; empty with no file.
func (e *env) imageIndex(id string) map[string]*imageEntry {
	e.t.Helper()
	raw, err := os.ReadFile(filepath.Join(e.m.imagesDir(id), imageIndexFile))
	if errors.Is(err, os.ErrNotExist) {
		return map[string]*imageEntry{}
	}
	if err != nil {
		e.t.Fatal(err)
	}
	var f imageIndex
	if err := json.Unmarshal(raw, &f); err != nil {
		e.t.Fatal(err)
	}
	return f.Images
}

// saveDraft saves d as the draft of a branch ("" = the current one) on the counter it has, and
// returns the ids that were left out.
func (e *env) saveDraft(id, branch string, d model.Draft) []string {
	e.t.Helper()
	_, _, missing, err := e.m.SaveDraft(id, branch, e.draftRev(id, branch), d)
	if err != nil {
		e.t.Fatal(err)
	}
	return missing
}

// sendPics sends text with the images on the chat's current branch.
func (e *env) sendPics(id, text string, imgs ...model.Image) error {
	_, err := e.m.SendMessage(id, nil, Message{Text: text, Images: imgs})
	return err
}

// picTurn runs one finished turn whose message holds the images: the reply "reply <i>", the
// mark's id "p<i>". a is the chat's process, nil when the Send starts it; it is returned.
func (e *env) picTurn(id string, a *fakeAgent, i int, text string, imgs ...model.Image) *fakeAgent {
	e.t.Helper()
	if err := e.sendPics(id, text, imgs...); err != nil {
		e.t.Fatal(err)
	}
	if a == nil {
		a = e.spawner(e.meta(id).Agent).last(e.t)
	}
	n := strconv.Itoa(i)
	a.emit(e.t, agent.Event{Kind: agent.EvText, Text: "reply " + n}, agent.Event{Kind: agent.EvTurnEnd, Point: "p" + n})
	return a
}

// idsOf is the ids of the images, in order.
func idsOf(imgs []model.Image) []string {
	out := []string{}
	for _, im := range imgs {
		out = append(out, im.ID)
	}
	return out
}

// ---- the store ------------------------------------------------------------

// An image's id comes from its bytes and its type is found from them; the same picture uploaded
// twice is one image; a chat's branches share the store.
func TestImageUpload(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.branched(model.Claude, "", exBranch)
	if got := e.imageFiles(id); got != nil {
		t.Fatalf("a chat without images has the folder: %v", got)
	}

	for typ, data := range map[string][]byte{
		"image/png":  pic("a"),
		"image/jpeg": []byte("\xff\xd8\xff\xe0 a jpeg"),
		"image/gif":  []byte("GIF89a a gif"),
		"image/webp": []byte("RIFF\x10\x00\x00\x00WEBPVP8 a webp"),
	} {
		img, err := e.m.UploadImage(id, " shot\x00 one\n.png ", typ+"; charset=binary", data)
		if err != nil {
			t.Fatalf("%s: %v", typ, err)
		}
		want := model.Image{ID: idOf(data), Name: "shot one.png", Type: typ, Size: int64(len(data))}
		if img != want {
			t.Fatalf("%s: uploaded %+v, want %+v", typ, img, want)
		}
		got, body, err := e.m.Image(id, img.ID)
		if err != nil || !bytes.Equal(body, data) || got.Type != typ || got.Size != int64(len(data)) {
			t.Fatalf("%s: fetched %+v %q %v", typ, got, body, err)
		}
		if st, err := os.Stat(e.m.imagePath(id, img.ID)); err != nil || st.Mode().Perm() != 0o600 {
			t.Fatalf("%s: the file: %v %v", typ, st, err)
		}
	}
	if n := len(e.imageFiles(id)); n != 4 {
		t.Fatalf("%d files for four images", n)
	}

	// The same bytes again, under another name: the same image, and nothing more in the store.
	again, err := e.m.UploadImage(id, "other.png", "image/png", pic("a"))
	if err != nil || again.ID != idOf(pic("a")) || again.Name != "other.png" {
		t.Fatalf("the second upload: %+v %v", again, err)
	}
	if n, m := len(e.imageFiles(id)), len(e.imageIndex(id)); n != 4 || m != 4 {
		t.Fatalf("after a repeated upload: %d files, %d entries", n, m)
	}

	// One store for the chat: nothing is kept under a branch, and a branch's draft names what
	// was uploaded to the chat.
	if _, err := os.Stat(filepath.Join(e.m.chatDir(branchChatID(id, exBranch)), "images")); !os.IsNotExist(err) {
		t.Fatalf("a branch has an image folder of its own: %v", err)
	}
	if missing := e.saveDraft(id, exBranch, model.Draft{Images: []model.Image{again}}); len(missing) != 0 {
		t.Fatalf("the branch's draft lacks %v", missing)
	}

	// A fetch checks the id's form before it looks anything up.
	for _, bad := range []string{"", "abc", strings.Repeat("g", 64), strings.ToUpper(again.ID), "../chat.json", again.ID + "0"} {
		if _, _, err := e.m.Image(id, bad); !errors.Is(err, ErrImageID) {
			t.Errorf("a fetch of %q: %v, want ErrImageID", bad, err)
		}
	}
	if _, _, err := e.m.Image(id, idOf(pic("never"))); !errors.Is(err, ErrNoImage) {
		t.Errorf("a fetch of an image the chat lacks: %v", err)
	}
	if _, _, err := e.m.Image("no-such-chat", again.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("a fetch from no chat: %v", err)
	}
}

// What an upload is refused for, and that a refused one leaves nothing.
func TestImageUploadRefused(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID

	big := append(pic("big"), make([]byte, model.ImageMaxBytes)...)
	for _, c := range []struct {
		what, stated string
		data         []byte
		want         error
	}{
		{"an SVG", "image/svg+xml", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`), ErrImageType},
		{"HTML that says it is a PNG", "image/png", []byte("<!doctype html><script>alert(1)</script>"), ErrImageType},
		{"a PNG that says it is a JPEG", "image/jpeg", pic("x"), ErrImageType},
		{"a PNG that says nothing", "", pic("x"), ErrImageType},
		{"a PNG that says it is HTML", "text/html", pic("x"), ErrImageType},
		{"no bytes", "image/png", nil, ErrImageType},
		{"a RIFF file that is no WebP", "image/webp", []byte("RIFF\x10\x00\x00\x00WAVEfmt "), ErrImageType},
		{"an image over the limit", "image/png", big, ErrImageTooLarge},
	} {
		if _, err := e.m.UploadImage(id, "f", c.stated, c.data); !errors.Is(err, c.want) {
			t.Errorf("%s: %v, want %v", c.what, err, c.want)
		}
	}
	if got := e.imageFiles(id); got != nil {
		t.Fatalf("the refused uploads left %v", got)
	}
	// An image of exactly the limit is taken.
	if _, err := e.m.UploadImage(id, "f", "image/png", big[:model.ImageMaxBytes]); err != nil {
		t.Fatalf("an image of the limit: %v", err)
	}

	// Who may upload is who may save the draft: not to a chat that is not there.
	if _, err := e.m.UploadImage("nope", "f", "image/png", pic("x")); !errors.Is(err, ErrNotFound) {
		t.Errorf("an upload to no chat: %v", err)
	}
	if err := e.m.ImageUploadable("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("ImageUploadable of no chat: %v", err)
	}
}

// At most 50 images of a chat were never sent. The cap is counted after the cleanup has run, an
// image that is there already is taken at the cap, and sent images do not count.
func TestImageCap(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	first := e.upload(id, "0")
	if err := e.sendPics(id, "see", first); err != nil { // sent: it does not count
		t.Fatal(err)
	}
	var unsent []model.Image
	for i := 1; i <= model.ImagesUnsentPerChat; i++ {
		unsent = append(unsent, e.upload(id, strconv.Itoa(i)))
	}
	_, err := e.m.UploadImage(id, "over.png", "image/png", pic("over"))
	if !errors.Is(err, ErrImageCap) || !strings.Contains(err.Error(), "50") {
		t.Fatalf("the upload past the cap: %v", err)
	}
	if e.holds(id, idOf(pic("over"))) || len(e.imageFiles(id)) != model.ImagesUnsentPerChat+1 {
		t.Fatalf("the refused upload left something: %d files", len(e.imageFiles(id)))
	}
	// At the cap an image that is there is taken again, and so is one that was sent.
	if again := e.upload(id, "7"); again.ID != unsent[6].ID {
		t.Fatalf("a repeated upload at the cap: %+v", again)
	}
	if again := e.upload(id, "0"); again.ID != first.ID {
		t.Fatalf("a repeated upload of a sent image at the cap: %+v", again)
	}

	// Ten of them are in a draft. After more than the hour the cleanup, which an upload runs
	// before it counts, takes the other forty: the upload is taken.
	e.saveDraft(id, "", model.Draft{Images: unsent[:10]})
	e.later(imageWait + time.Minute)
	if _, err := e.m.UploadImage(id, "over.png", "image/png", pic("over")); err != nil {
		t.Fatalf("the upload after the cleanup: %v", err)
	}
	if n := len(e.imageFiles(id)); n != 12 { // the sent one, the draft's ten, the new one
		t.Fatalf("%d images after the cleanup, want 12", n)
	}
	for _, im := range unsent[:10] {
		if !e.holds(id, im.ID) {
			t.Fatalf("an image of the draft was deleted")
		}
	}
	if !e.holds(id, first.ID) {
		t.Fatalf("the sent image was deleted")
	}
}

func TestCleanImageName(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]string{
		"shot.png":                     "shot.png",
		"  a\tb\r\nc\x00\x1b[31m.png ": "abc[31m.png",
		"":                             model.ImageWord,
		"\n\t ":                        model.ImageWord,
		"bad\xff\xfeutf":               "badutf",
		"../../etc/passwd":             "../../etc/passwd", // only ever shown
		strings.Repeat("é", 300):       strings.Repeat("é", imageNameMax),
	} {
		if got := cleanImageName(in); got != want {
			t.Errorf("cleanImageName(%q) = %q, want %q", in, got, want)
		}
	}
}

// ---- drafts ---------------------------------------------------------------

// A draft carries its images by id, name, type and size. Only the id and the name are taken from
// the save; a draft with images and no text is a draft; an image the chat does not hold is left
// out and named; a draft may hold more images than a message takes.
func TestDraftImages(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	a, b := e.upload(id, "a"), e.upload(id, "b")
	evs := e.listen()

	// Images alone, with what the page claims of them: the type and the size are the store's.
	claimed := []model.Image{
		{ID: a.ID, Name: " my\nshot.png ", Type: "text/html", Size: 1},
		{ID: b.ID, Name: "", Type: "image/gif", Size: 99999},
	}
	rev, _, missing, err := e.m.SaveDraft(id, "", 0, model.Draft{Images: claimed})
	if err != nil || rev != 1 || len(missing) != 0 {
		t.Fatalf("SaveDraft: rev %d missing %v err %v", rev, missing, err)
	}
	want := []model.Image{
		{ID: a.ID, Name: "myshot.png", Type: "image/png", Size: a.Size},
		{ID: b.ID, Name: model.ImageWord, Type: "image/png", Size: b.Size},
	}
	v := e.view(id)
	if v.Draft == nil || v.Draft.Text != "" || !reflect.DeepEqual(v.Draft.Images, want) || !v.HasDraft {
		t.Fatalf("the view's draft %+v, has a draft %v", v.Draft, v.HasDraft)
	}
	if got := e.meta(id).Drafts[model.MainBranch]; got == nil || !reflect.DeepEqual(got.Images, want) {
		t.Fatalf("chat.json's draft %+v", got)
	}
	got := evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(got), []string{"branch_state", "chat"}) {
		t.Fatalf("events of the save %v", got)
	}
	if st := stateIn(t, got[0]); st.Draft == nil || !reflect.DeepEqual(st.Draft.Images, want) {
		t.Fatalf("the state record's draft %+v", st.Draft)
	}
	if vs := chatViews(t, got, id); len(vs) != 1 || !vs[0].HasDraft {
		t.Fatalf("the chat event %+v", vs)
	}

	// The draft survives a restart, with its images.
	e.boot()
	if v := e.view(id); v.Draft == nil || !reflect.DeepEqual(v.Draft.Images, want) || !e.holds(id, a.ID) {
		t.Fatalf("after a restart: %+v", v.Draft)
	}

	// An image the chat does not hold, an id of the wrong form, and one named twice.
	gone, bad := idOf(pic("never uploaded")), "../../state.json"
	missing = e.saveDraft(id, "", model.Draft{Text: "t", Images: []model.Image{a, {ID: gone}, {ID: bad}, a, {ID: gone}}})
	if !reflect.DeepEqual(missing, []string{gone, bad}) {
		t.Fatalf("missing %v", missing)
	}
	if d := e.view(id).Draft; d == nil || d.Text != "t" || !reflect.DeepEqual(idsOf(d.Images), []string{a.ID}) {
		t.Fatalf("the draft saved without them: %+v", d)
	}
	// Named alone, the missing image leaves no draft.
	if missing = e.saveDraft(id, "", model.Draft{Images: []model.Image{{ID: gone}}}); !reflect.DeepEqual(missing, []string{gone}) {
		t.Fatalf("missing %v", missing)
	}
	if v := e.view(id); v.Draft != nil || v.HasDraft {
		t.Fatalf("a draft of a missing image alone: %+v", v.Draft)
	}

	// Over the limit of a message: nothing is dropped, the draft is saved as it is.
	many := []model.Image{a, b}
	for i := 0; i < model.ImagesPerMessage; i++ {
		many = append(many, e.upload(id, "m"+strconv.Itoa(i)))
	}
	if missing = e.saveDraft(id, "", model.Draft{Images: many}); len(missing) != 0 {
		t.Fatalf("missing %v", missing)
	}
	if d := e.view(id).Draft; d == nil || len(d.Images) != model.ImagesPerMessage+2 {
		t.Fatalf("the draft over the limit: %+v", d)
	}

	// A stale save answers as before, and changes nothing.
	if _, stored, _, err := e.m.SaveDraft(id, "", 0, model.Draft{Images: []model.Image{a}}); !errors.Is(err, ErrStaleDraft) || stored == nil || len(stored.Images) != len(many) {
		t.Fatalf("a stale save: %+v %v", stored, err)
	}

	// No text, no quotes, no images: no draft.
	e.saveDraft(id, "", model.Draft{})
	if v := e.view(id); v.Draft != nil || v.HasDraft {
		t.Fatalf("an empty draft is stored: %+v", v.Draft)
	}
}

// ---- a Send ---------------------------------------------------------------

// A message with images: the thread's item holds them, the agent gets each as an image block
// directly before the block of the user's text, they count as sent and the draft is gone.
func TestSendImages(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	bd, err := e.bds.Create("Plan", gOne, false)
	if err != nil {
		t.Fatal(err)
	}
	id := e.create(model.Claude, "", bd.ID).ID
	a, b := e.upload(id, "a"), e.upload(id, "b")
	e.saveDraft(id, "", model.Draft{Text: "look", Images: []model.Image{a, b}})

	// What the page says of the images' type and size is not looked at; a name is.
	named := []model.Image{{ID: b.ID, Name: "second\n.png", Type: "text/html", Size: 3}, {ID: a.ID, Name: "first.png"}, {ID: b.ID}}
	if _, err := e.m.SendMessage(id, nil, Message{Text: "look", Context: "<ui-context>ctx</ui-context>", Images: named}); err != nil {
		t.Fatal(err)
	}
	want := []model.Image{
		{ID: b.ID, Name: "second.png", Type: "image/png", Size: b.Size},
		{ID: a.ID, Name: "first.png", Type: "image/png", Size: a.Size},
	}
	items := e.items(id)
	if len(items) != 1 || items[0].Kind != "user" || items[0].Text != "look" || !reflect.DeepEqual(items[0].Images, want) {
		t.Fatalf("the thread %+v", items)
	}
	if disk := e.diskItems(id); len(disk) != 1 || !reflect.DeepEqual(disk[0].Images, want) {
		t.Fatalf("items.jsonl %+v", disk)
	}
	raw := e.file(id, "items.jsonl")
	if bytes.Contains(raw, pic("a")) || bytes.Contains(e.file(id, "chat.json"), pic("a")) {
		t.Fatal("the bytes of an image are in the transcript or in chat.json")
	}

	sent := e.claude.last(t).sent()
	if len(sent) != 1 || len(sent[0]) != 4 {
		t.Fatalf("the agent got %+v", sent)
	}
	blocks := sent[0]
	if blocks[0].Image != nil || blocks[0].Text != "<ui-context>ctx</ui-context>" {
		t.Fatalf("the first block %+v", blocks[0])
	}
	for i, im := range want {
		got := blocks[1+i].Image
		if got == nil || got.Name != im.Name || got.Type != im.Type || !bytes.Equal(got.Data, pic([]string{"b", "a"}[i])) || blocks[1+i].Text != "" {
			t.Fatalf("image block %d: %+v", i, blocks[1+i])
		}
	}
	if blocks[3].Image != nil || blocks[3].Text != "look" {
		t.Fatalf("the user's text block %+v", blocks[3])
	}

	idx := e.imageIndex(id)
	if !idx[a.ID].Sent || !idx[b.ID].Sent {
		t.Fatalf("the images are not recorded as sent: %+v %+v", idx[a.ID], idx[b.ID])
	}
	if v := e.view(id); v.Draft != nil || v.HasDraft {
		t.Fatalf("the draft after the Send: %+v", v.Draft)
	}
}

// A message of images alone: the tree and the chat's title name it "Image", which is the chat's
// name from then on, the agent gets the images before an empty text block, and no automatic name
// is asked for.
func TestSendImagesAlone(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	img := e.upload(id, "a")
	ag := e.picTurn(id, nil, 1, "", img)
	e.m.naming.Wait()
	if calls := e.namer.callList(); len(calls) != 0 {
		t.Fatalf("a name was asked for from %q", calls)
	}
	// The word is the chat's stored name, not the user's: a sidebar row with no thread shows it.
	if v := e.view(id); v.Name != model.ImageWord || v.UserNamed {
		t.Fatalf("the chat is named %q (by the user: %v)", v.Name, v.UserNamed)
	}
	sent := ag.sent()
	if len(sent) != 1 || len(sent[0]) != 2 || sent[0][0].Image == nil || sent[0][1].Image != nil || sent[0][1].Text != "" {
		t.Fatalf("the agent got %+v", sent)
	}

	tv, err := e.m.Tree(id)
	if err != nil {
		t.Fatal(err)
	}
	if its := tv.Branches[0].Items; len(its) != 2 || its[0].Kind != "user" || its[0].Text != model.ImageWord {
		t.Fatalf("the tree's items %+v", its)
	}
	if got := titleOf(e.meta(id), e.items(id)); got != model.ImageWord {
		t.Fatalf("the title %q", got)
	}
	// The fork's name and the title it keeps of its source are made of that word.
	fork := e.fork(id, 3)
	if fork.Name != model.ImageWord+" (fork)" || fork.ForkedFromTitle != model.ImageWord {
		t.Fatalf("the fork is called %q, of %q", fork.Name, fork.ForkedFromTitle)
	}

	// A later message with words changes neither: the title is the first message's. And a first
	// message with words is named as before.
	e.send(id, "now with words", "")
	e.m.naming.Wait()
	if calls := e.namer.callList(); len(calls) != 0 {
		t.Fatalf("a name was asked for from %q", calls)
	}
	other := e.create(model.Claude, gOne, "").ID
	if err := e.sendPics(other, "what is this?", e.upload(other, "a")); err != nil {
		t.Fatal(err)
	}
	e.m.naming.Wait()
	if calls := e.namer.callList(); !reflect.DeepEqual(calls, []string{"what is this?"}) {
		t.Fatalf("the namer was asked %q", calls)
	}
	// With quotes and images and no text the tree shows the quote, as before.
	if got := treeText(model.Item{Kind: "user", Images: []model.Image{img}, References: []model.Reference{{Quote: "q"}}}); got != "❝ q" {
		t.Fatalf("the tree's text of quotes and images %q", got)
	}
}

// noImagesCatalog is a Cursor catalog with one model that takes no images.
var noImagesCatalog = &model.Catalog{
	Models: []model.CatalogModel{
		{ID: "sees", Label: "Sees"},
		{ID: "text-only", Label: "Text Only", NoImages: true},
		{ID: "unlabeled-text", NoImages: true},
	},
	Default: model.ModelChoice{Model: "sees"},
}

// What a Send with images is refused for, and that a refused one leaves nothing: no item, no
// process, the draft and the images as they were.
func TestSendImagesRefused(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.storeCatalog(model.Cursor, noImagesCatalog)
	id := e.create(model.Cursor, gOne, "").ID
	a := e.upload(id, "a")
	draft := model.Draft{Text: "look", Images: []model.Image{a}}
	e.saveDraft(id, "", draft)
	rev := e.draftRev(id, "")
	evs := e.listen()

	untouched := func(what string) {
		t.Helper()
		if n := e.cursor.count(); n != 0 {
			t.Fatalf("%s: %d processes were started", what, n)
		}
		if items := e.items(id); len(items) != 0 {
			t.Fatalf("%s: the thread has %+v", what, items)
		}
		if v := e.view(id); v.Locked || v.Draft == nil || !reflect.DeepEqual(*v.Draft, draft) || e.draftRev(id, "") != rev {
			t.Fatalf("%s: the chat is %+v, its draft %+v", what, v, v.Draft)
		}
		if e.imageIndex(id)[a.ID].Sent {
			t.Fatalf("%s: the image counts as sent", what)
		}
		if got := evs.drain(t, e.br); len(got) != 0 {
			t.Fatalf("%s: events %v", what, got)
		}
	}

	// An id of the wrong form, before anything is looked up.
	for _, bad := range []string{"", "x", "../chat.json", strings.ToUpper(a.ID)} {
		if err := e.sendPics(id, "look", a, model.Image{ID: bad}); !errors.Is(err, ErrImageID) {
			t.Fatalf("an id %q: %v", bad, err)
		}
	}
	untouched("a bad id")

	// Images the chat does not hold: the refusal names them, and only them.
	g1, g2 := idOf(pic("gone 1")), idOf(pic("gone 2"))
	err := e.sendPics(id, "look", model.Image{ID: g1}, a, model.Image{ID: g2}, model.Image{ID: g1})
	var miss *MissingImages
	if !errors.As(err, &miss) || !errors.Is(err, ErrImageMissing) || !reflect.DeepEqual(miss.IDs, []string{g1, g2}) {
		t.Fatalf("missing images: %v", err)
	}
	untouched("missing images")

	// More images than a message takes, and more bytes.
	many := []model.Image{a}
	for i := 0; i < model.ImagesPerMessage; i++ {
		many = append(many, e.upload(id, "m"+strconv.Itoa(i)))
	}
	if err := e.sendPics(id, "look", many...); !errors.Is(err, ErrImageLimit) || !strings.Contains(err.Error(), "at most 10 images") {
		t.Fatalf("eleven images: %v", err)
	}
	untouched("eleven images")
	var heavy []model.Image
	for i := 0; i < 5; i++ { // 4.5 MB each: under the limit of one image, over that of a message together
		data := append(pic("heavy"+strconv.Itoa(i)), make([]byte, 9<<19)...)
		img, err := e.m.UploadImage(id, "heavy.png", "image/png", data)
		if err != nil {
			t.Fatal(err)
		}
		heavy = append(heavy, img)
	}
	if err := e.sendPics(id, "look", heavy...); !errors.Is(err, ErrImageLimit) || !strings.Contains(err.Error(), "20 MB") {
		t.Fatalf("22 MB of images: %v", err)
	}
	untouched("22 MB of images")

	// A model that takes no images: the sentence names it.
	for modelID, name := range map[string]string{"text-only": "Text Only", "unlabeled-text": "unlabeled-text"} {
		e.configure(id, ConfigReq{Model: modelID})
		evs.drain(t, e.br)
		if err := e.sendPics(id, "look", a); !errors.Is(err, ErrImageModel) || !strings.HasPrefix(err.Error(), name+" takes no images") {
			t.Fatalf("images for %s: %v", modelID, err)
		}
		untouched("images for " + modelID)
	}
	// The same model takes a message without images, and the rules look at the message alone.
	e.configure(id, ConfigReq{Model: "sees"})
	evs.drain(t, e.br)

	// Within every limit the message goes: ten images, four of them 4.5 MB.
	ten := append(append([]model.Image{}, heavy[:4]...), many[:6]...)
	if err := e.sendPics(id, "look", ten...); err != nil {
		t.Fatalf("ten images: %v", err)
	}
	if items := e.items(id); len(items) != 1 || len(items[0].Images) != 10 || e.cursor.count() != 1 {
		t.Fatalf("the thread after the Send: %+v", items)
	}
	if blocks := e.cursor.last(t).sent()[0]; len(blocks) != 11 || blocks[10].Text != "look" || blocks[9].Image == nil {
		t.Fatalf("the agent got %d blocks", len(blocks))
	}
}

// A Send that names a model for its target is checked against that model, and no branch is made
// for one that is refused.
func TestSendImagesTargetModel(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.storeCatalog(model.Cursor, noImagesCatalog)
	id := e.create(model.Cursor, gOne, "").ID
	e.turn(id, nil, 1) // on "sees": [user, text, end]
	a := e.upload(id, "a")
	spawned := e.cursor.count()

	// A new branch at the start of the chat, on the model that takes none.
	_, err := e.m.SendMessage(id, &Target{Branch: model.MainBranch, At: 0, New: true, Model: "text-only"}, Message{Text: "again", Images: []model.Image{a}})
	if !errors.Is(err, ErrImageModel) || !strings.Contains(err.Error(), "Text Only") {
		t.Fatalf("images for a branch on a model that takes none: %v", err)
	}
	if tr, ok := e.treeFile(id); ok && len(tr.Branches) != 0 {
		t.Fatalf("a branch was made: %+v", tr)
	}
	if ents, err := os.ReadDir(filepath.Join(e.m.chatDir(id), "branches")); err == nil && len(ents) != 0 {
		t.Fatalf("a branch folder was left: %v", ents)
	}
	if e.cursor.count() != spawned || e.imageIndex(id)[a.ID].Sent {
		t.Fatal("the refused Send started a process or sent the image")
	}
	// The same at a point that has a conversation before it: the model is asked before a session
	// is forked for the branch, so no process is started for a message that cannot go.
	_, err = e.m.SendMessage(id, &Target{Branch: model.MainBranch, At: 3, New: true, Model: "text-only"}, Message{Text: "again", Images: []model.Image{a}})
	if !errors.Is(err, ErrImageModel) {
		t.Fatalf("images for a branch after the first turn, on a model that takes none: %v", err)
	}
	if tr, ok := e.treeFile(id); (ok && len(tr.Branches) != 0) || e.cursor.count() != spawned || len(e.cursor.forkCalls()) != 0 {
		t.Fatalf("the refused Send made a branch (%+v), started a process or forked a session", tr)
	}

	// The same branch without images is made on that model. Its own next message is then
	// checked against its model, whatever main is on.
	bid, err := e.m.SendMessage(id, &Target{Branch: model.MainBranch, At: 0, New: true, Model: "text-only"}, Message{Text: "again"})
	if err != nil {
		t.Fatal(err)
	}
	ba := e.cursor.last(t)
	ba.emit(t, agent.Event{Kind: agent.EvSession, SessionID: "cur-b"}, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd, Point: "pb"})
	if _, err := e.m.SendMessage(id, &Target{Branch: bid, End: true}, Message{Text: "see", Images: []model.Image{a}}); !errors.Is(err, ErrImageModel) {
		t.Fatalf("images on the branch whose model takes none: %v", err)
	}
	// And the other way round: from the text-only branch, a new branch on a model that takes
	// images takes them. It copies nothing: the chat has one store.
	nb, err := e.m.SendMessage(id, &Target{Branch: bid, At: 0, New: true, Model: "sees"}, Message{Text: "see", Images: []model.Image{a}})
	if err != nil {
		t.Fatalf("images for a branch on a model that takes them: %v", err)
	}
	sid := branchChatID(id, nb)
	if items := e.diskItems(sid); len(items) != 1 || !reflect.DeepEqual(idsOf(items[0].Images), []string{a.ID}) {
		t.Fatalf("the branch's thread %+v", items)
	}
	if _, err := os.Stat(filepath.Join(e.m.chatDir(sid), "images")); !os.IsNotExist(err) {
		t.Fatalf("the new branch has an image folder of its own: %v", err)
	}
	if !reflect.DeepEqual(e.imageFiles(id), []string{a.ID}) || !e.imageIndex(id)[a.ID].Sent {
		t.Fatalf("the chat's store after the Send on a branch: %v", e.imageFiles(id))
	}
	if blocks := e.cursor.last(t).sent()[0]; len(blocks) != 2 || blocks[0].Image == nil || !bytes.Equal(blocks[0].Image.Data, pic("a")) {
		t.Fatalf("the branch's agent got %+v", blocks)
	}
}

// The agent's own refusal of a message leaves the message in the thread, and so its images sent.
func TestSendImagesAgentRefuses(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	ag := e.picTurn(id, nil, 1, "first", e.upload(id, "a"))
	b := e.upload(id, "b")
	ag.mu.Lock()
	ag.sendErr = errors.New("the agent says no")
	ag.mu.Unlock()
	if err := e.sendPics(id, "second", b); err == nil {
		t.Fatal("the refused Send returned no error")
	}
	items := e.items(id)
	var held bool
	for _, it := range items {
		held = held || it.Kind == "user" && reflect.DeepEqual(idsOf(it.Images), []string{b.ID})
	}
	if !held || !e.imageIndex(id)[b.ID].Sent {
		t.Fatalf("the refused message is not in the thread with its image, sent: %+v", items)
	}
	e.later(10 * imageWait)
	e.upload(id, "c") // runs the cleanup
	if !e.holds(id, b.ID) {
		t.Fatal("the image of a message in the thread was deleted")
	}
}

// ---- cleanup --------------------------------------------------------------

// The one rule: an image that was never sent goes when no draft of any branch names it and it
// was last used more than an hour ago. Never at the moment a draft stops naming it; a sent image
// never.
func TestImageCleanup(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.branched(model.Claude, "", "")
	sweep := func() { e.t.Helper(); e.upload(id, "sweep") } // an upload runs the cleanup first
	const short, long = 59 * time.Minute, 62 * time.Minute

	// An upload that never reached a draft: there within the hour, gone after it.
	orphan := e.upload(id, "orphan")
	e.later(short)
	sweep()
	if !e.holds(id, orphan.ID) {
		t.Fatal("an image was deleted within the hour of its upload")
	}
	e.later(long)
	sweep()
	if e.holds(id, orphan.ID) {
		t.Fatal("an image no draft names was kept past the hour")
	}
	if _, err := os.Stat(e.m.imagePath(id, orphan.ID)); !os.IsNotExist(err) {
		t.Fatalf("its file is still there: %v", err)
	}

	// An image a draft names stays, however old. Taken out of the draft it is not deleted at
	// that moment, nor within the hour of that save: the drop is a use. Then it goes.
	inDraft := e.upload(id, "in draft")
	e.saveDraft(id, "", model.Draft{Text: "t", Images: []model.Image{inDraft}})
	e.later(5 * long)
	sweep()
	if !e.holds(id, inDraft.ID) {
		t.Fatal("an image a draft names was deleted")
	}
	e.saveDraft(id, "", model.Draft{Text: "t"}) // runs the cleanup too: the image is two hours old
	if !e.holds(id, inDraft.ID) {
		t.Fatal("an image was deleted at the moment its draft stopped naming it")
	}
	e.later(short)
	sweep()
	if !e.holds(id, inDraft.ID) {
		t.Fatal("an image was deleted within the hour of the save that dropped it")
	}
	e.later(long)
	e.saveDraft(id, "", model.Draft{Text: "t2"}) // a draft save with no image runs no cleanup
	if !e.holds(id, inDraft.ID) {
		t.Fatal("a save of a draft without images ran the cleanup")
	}
	sweep()
	if e.holds(id, inDraft.ID) {
		t.Fatal("an image taken out of its draft was kept past the hour")
	}

	// The draft of another branch names it: it stays, whatever main's draft does.
	shared := e.upload(id, "shared")
	e.saveDraft(id, model.MainBranch, model.Draft{Images: []model.Image{shared}})
	e.saveDraft(id, exBranch, model.Draft{Images: []model.Image{shared}})
	e.saveDraft(id, model.MainBranch, model.Draft{})
	e.later(5 * long)
	sweep()
	if !e.holds(id, shared.ID) {
		t.Fatal("an image the draft of another branch names was deleted")
	}

	// Uploading it again and a draft save that names it count as use.
	again := e.upload(id, "again")
	e.later(short)
	e.upload(id, "again")
	e.later(short)
	sweep()
	if !e.holds(id, again.ID) {
		t.Fatal("a repeated upload did not count as use")
	}
	e.saveDraft(id, model.MainBranch, model.Draft{Images: []model.Image{again}})
	e.later(short)
	e.saveDraft(id, model.MainBranch, model.Draft{})
	e.later(short)
	sweep()
	if !e.holds(id, again.ID) {
		t.Fatal("the draft saves did not count as use")
	}

	// The image of a Send that was refused and not sent again: it goes by the same rule, counted
	// from the Send.
	refused := e.upload(id, "refused")
	e.later(short)
	e.m.Stop(id)
	if err := e.m.SetArchive(id, model.Archive{Archived: true}); err != nil {
		t.Fatal(err)
	}
	if err := e.sendPics(id, "look", refused); !errors.Is(err, ErrArchived) {
		t.Fatalf("a Send to an archived chat: %v", err)
	}
	if err := e.m.SetArchive(id, model.Archive{}); err != nil {
		t.Fatal(err)
	}
	e.later(short)
	sweep()
	if !e.holds(id, refused.ID) || e.imageIndex(id)[refused.ID].Sent {
		t.Fatal("the image of a refused Send was deleted within the hour of the Send, or counts as sent")
	}
	e.later(long)
	sweep()
	if e.holds(id, refused.ID) {
		t.Fatal("the image of a refused Send was kept past the hour")
	}

	// A message holds it, on a branch whose draft never named it (the other branch's draft still
	// names the shared one): it is sent, and stays for good, also over a restart.
	sent := e.upload(id, "sent")
	if _, err := e.m.SendMessage(id, &Target{Branch: model.MainBranch, End: true}, Message{Text: "see", Images: []model.Image{sent}}); err != nil {
		t.Fatal(err)
	}
	e.later(100 * long)
	sweep()
	e.boot()
	e.later(100 * long)
	sweep()
	if !e.holds(id, sent.ID) || !e.holds(id, shared.ID) {
		t.Fatalf("a sent image (held: %v), or one a draft names (held: %v), was deleted", e.holds(id, sent.ID), e.holds(id, shared.ID))
	}
	if got := e.imageFiles(id); len(got) != 3 { // sent, shared, sweep
		t.Fatalf("the store holds %v", got)
	}
}

// The hour is a production wait a test lowers; the last use is kept over a restart.
func TestImageWaitLowered(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	e.m.ImageWait = time.Second
	img := e.upload(id, "a")
	e.later(900 * time.Millisecond)
	e.upload(id, "b")
	if !e.holds(id, img.ID) {
		t.Fatal("deleted within the lowered wait")
	}
	e.boot() // the default again: an hour from the upload
	e.later(30 * time.Minute)
	e.upload(id, "c")
	if !e.holds(id, img.ID) {
		t.Fatal("deleted within the hour after a restart")
	}
	e.later(31 * time.Minute)
	e.upload(id, "d")
	if e.holds(id, img.ID) {
		t.Fatal("kept past the hour after a restart: the time of the last use was not kept")
	}
}

// The cleanup never takes an image a Send holds, between the check of the message and the moment
// it is in the thread, however old the image is and whatever the draft does meanwhile.
func TestImageHeldBySend(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	top := e.chatObj(id)
	img := e.upload(id, "a")
	held, err := e.m.takeImages(top, id, []model.Image{img}) // the Send has checked its message
	if err != nil {
		t.Fatal(err)
	}
	e.later(3 * imageWait)
	e.upload(id, "b")
	e.saveDraft(id, "", model.Draft{Text: "typed meanwhile"})
	if !e.holds(id, img.ID) {
		t.Fatal("the image of a Send under way was deleted")
	}
	blocks, err := e.m.imageBlocks(held)
	if err != nil || len(blocks) != 1 || !bytes.Equal(blocks[0].Image.Data, pic("a")) {
		t.Fatalf("the Send's image blocks: %+v %v", blocks, err)
	}
	e.m.releaseImages(held) // refused after all: from here the rule counts from the Send
	e.upload(id, "c")
	if e.holds(id, img.ID) {
		t.Fatal("the image of a Send that was refused three hours ago was kept")
	}
}

// A Send, a save of the emptied draft and an upload at the same time never lose the image of the
// message.
func TestSendSaveUploadTogether(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	rounds := 8
	if testset.Full() {
		rounds = 60
	}
	for round := 0; round < rounds; round++ {
		id := e.create(model.Claude, gOne, "").ID
		tag := strconv.Itoa(round)
		img := e.upload(id, "msg"+tag)
		e.saveDraft(id, "", model.Draft{Text: "look", Images: []model.Image{img}})
		rev := e.draftRev(id, "")
		e.later(2 * imageWait) // only the draft keeps the image now

		var wg sync.WaitGroup
		var sendErr error
		wg.Add(3)
		go func() {
			defer wg.Done()
			sendErr = e.sendPics(id, "look", img)
		}()
		go func() { // the composer saves its emptied draft while the Send may still run
			defer wg.Done()
			e.m.SaveDraft(id, "", rev, model.Draft{})
		}()
		go func() { // and an upload runs the cleanup
			defer wg.Done()
			e.m.UploadImage(id, "other.png", "image/png", pic("other"+tag))
			e.m.UploadImage(id, "more.png", "image/png", pic("more"+tag))
		}()
		wg.Wait()
		if sendErr != nil {
			t.Fatalf("round %d: the Send: %v", round, sendErr)
		}
		items := e.items(id)
		if len(items) != 1 || !reflect.DeepEqual(idsOf(items[0].Images), []string{img.ID}) {
			t.Fatalf("round %d: the thread %+v", round, items)
		}
		e.later(2 * imageWait)
		e.upload(id, "last"+tag)
		if _, data, err := e.m.Image(id, img.ID); err != nil || !bytes.Equal(data, pic("msg"+tag)) {
			t.Fatalf("round %d: the image of the message is gone: %v", round, err)
		}
		ag := e.claude.last(t)
		if blocks := ag.sent()[0]; blocks[0].Image == nil || !bytes.Equal(blocks[0].Image.Data, pic("msg"+tag)) {
			t.Fatalf("round %d: the agent got %+v", round, blocks)
		}
		ag.emit(t, agent.Event{Kind: agent.EvTurnEnd}) // the turn ends: the rounds stay under the cap on working chats
	}
}

// Deleting a chat removes all its images, and nothing is written there afterwards.
func TestDeleteChatRemovesImages(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	sent, draft := e.upload(id, "sent"), e.upload(id, "draft")
	e.picTurn(id, nil, 1, "see", sent)
	e.saveDraft(id, "", model.Draft{Images: []model.Image{draft}})
	dir := e.m.chatDir(id)
	top := e.chatObj(id)
	held, err := e.m.takeImages(top, id, []model.Image{draft}) // a Send that is still under way
	if err != nil {
		t.Fatal(err)
	}
	if err := e.m.Delete(id); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("the chat's folder after the delete: %v", err)
	}
	if _, err := e.m.UploadImage(id, "late.png", "image/png", pic("late")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an upload to the deleted chat: %v", err)
	}
	if _, _, err := e.m.Image(id, sent.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a fetch from the deleted chat: %v", err)
	}
	// What was under way when the chat went writes nothing back.
	e.m.markSent(held)
	e.m.releaseImages(held)
	if _, err := e.m.imageBlocks(held); err == nil {
		t.Fatal("the bytes of a deleted chat's image were read")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("the chat's folder was made again: %v", err)
	}
}

// An index that is lost is made again from the files, each as an image that was sent: nothing
// the store cannot account for is deleted.
func TestImageIndexLost(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	img := e.upload(id, "a")
	for _, damage := range []func(path string) error{
		os.Remove,
		func(path string) error { return os.WriteFile(path, []byte("{not json"), 0o600) },
	} {
		if err := damage(filepath.Join(e.m.imagesDir(id), imageIndexFile)); err != nil {
			t.Fatal(err)
		}
		e.boot()
		e.later(5 * imageWait)
		e.upload(id, "b")
		if _, data, err := e.m.Image(id, img.ID); err != nil || !bytes.Equal(data, pic("a")) {
			t.Fatalf("the image after its index was lost: %v", err)
		}
		if ent := e.imageIndex(id)[img.ID]; ent == nil || !ent.Sent || ent.Type != "image/png" || ent.Size != img.Size {
			t.Fatalf("its entry in the index made again: %+v", ent)
		}
	}
}

// ---- forks and branches ---------------------------------------------------

// A fork has its own images: those of the messages it copies, which count as sent in it, and
// those of the message that becomes its draft. Deleting the source, or the cleanup in it, takes
// nothing from the fork, and the other way round.
func TestForkImages(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	one, two, three := e.upload(id, "one"), e.upload(id, "two"), e.upload(id, "three")
	unsent := e.upload(id, "unsent")
	ag := e.picTurn(id, nil, 1, "first", one, two)
	e.picTurn(id, ag, 2, "second", three, one) // items 3..5; one is in both messages
	e.m.naming.Wait()

	// Fork and edit of the second message: its prefix is the first turn, its draft the message.
	msg := 3
	fork, err := e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: 3, Message: &msg})
	if err != nil {
		t.Fatal(err)
	}
	wantDraft := []model.Image{
		{ID: three.ID, Name: "three.png", Type: "image/png", Size: three.Size},
		{ID: one.ID, Name: "one.png", Type: "image/png", Size: one.Size},
	}
	if d := fork.Draft; d == nil || d.Text != "second" || !reflect.DeepEqual(d.Images, wantDraft) {
		t.Fatalf("the fork's draft %+v", d)
	}
	if got, want := e.imageFiles(fork.ID), sortedIDs(one, two, three); !reflect.DeepEqual(got, want) {
		t.Fatalf("the fork holds %v, want %v (not the image the source never sent)", got, want)
	}
	idx := e.imageIndex(fork.ID)
	if !idx[one.ID].Sent || !idx[two.ID].Sent || idx[three.ID].Sent {
		t.Fatalf("sent in the fork: one %v two %v three %v, want the copied messages' alone", idx[one.ID].Sent, idx[two.ID].Sent, idx[three.ID].Sent)
	}
	if items := e.items(fork.ID); len(items) != 3 || !reflect.DeepEqual(idsOf(items[0].Images), []string{one.ID, two.ID}) {
		t.Fatalf("the fork's thread %+v", items)
	}
	for _, im := range []model.Image{one, two, three} {
		if _, data, err := e.m.Image(fork.ID, im.ID); err != nil || !bytes.Equal(data, pic(strings.TrimSuffix(im.Name, ".png"))) {
			t.Fatalf("the fork's copy of %s: %v", im.Name, err)
		}
	}
	if e.holds(fork.ID, unsent.ID) {
		t.Fatal("the fork holds an image no message of it and not its draft names")
	}
	// The source is as it was.
	if src := e.imageIndex(id); len(src) != 4 || !src[three.ID].Sent || src[unsent.ID].Sent {
		t.Fatalf("the source's store after the fork: %+v", src)
	}

	// The cleanup in the fork: the draft's image goes once the draft drops it and the hour is
	// over; the copied messages' stay; the source keeps all of its own.
	e.saveDraft(fork.ID, "", model.Draft{Text: "second, edited"})
	e.later(2 * imageWait)
	e.upload(fork.ID, "sweep")
	if e.holds(fork.ID, three.ID) || !e.holds(fork.ID, one.ID) || !e.holds(fork.ID, two.ID) {
		t.Fatal("the cleanup in the fork: want the dropped draft image gone and the copied messages' kept")
	}
	if !e.holds(id, three.ID) {
		t.Fatal("the cleanup in the fork took an image from the source")
	}
	// The cleanup in the source takes its unsent image, and nothing from the fork.
	e.upload(id, "sweep")
	if e.holds(id, unsent.ID) || !e.holds(fork.ID, one.ID) {
		t.Fatal("the cleanup in the source: want its own unsent image gone and the fork's kept")
	}

	// A plain fork, then the source is deleted: the fork's images are there, with their bytes.
	whole := e.fork(id, 6)
	if got, want := e.imageFiles(whole.ID), sortedIDs(one, two, three); !reflect.DeepEqual(got, want) {
		t.Fatalf("the plain fork holds %v, want %v", got, want)
	}
	if whole.Draft != nil {
		t.Fatalf("a plain fork has the draft %+v", whole.Draft)
	}
	if err := e.m.Delete(id); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{fork.ID, whole.ID} {
		if _, data, err := e.m.Image(f, one.ID); err != nil || !bytes.Equal(data, pic("one")) {
			t.Fatalf("after the source was deleted, the fork %s lost an image: %v", f, err)
		}
	}
	// And the other way round: deleting a fork takes nothing from another chat.
	if err := e.m.Delete(fork.ID); err != nil {
		t.Fatal(err)
	}
	if _, data, err := e.m.Image(whole.ID, three.ID); err != nil || !bytes.Equal(data, pic("three")) {
		t.Fatalf("after a fork was deleted, the other lost an image: %v", err)
	}
	// The fork's first message sends its images to the fork's agent, from the fork's store.
	if err := e.sendPics(whole.ID, "go on", two); err != nil {
		t.Fatal(err)
	}
	if blocks := e.claude.lastFork(t).sent()[0]; len(blocks) != 2 || blocks[0].Image == nil || !bytes.Equal(blocks[0].Image.Data, pic("two")) {
		t.Fatalf("the fork's agent got %+v", blocks)
	}
}

// A fork that fails leaves nothing, its images included.
func TestForkImagesFailedFork(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	e.picTurn(id, nil, 1, "first", e.upload(id, "one"))
	before := e.chatDirs()
	e.claude.set(func(s *fakeSpawner) { s.forkErr = errors.New("no fork today") })
	if err := e.forkErr(id, 3); err == nil {
		t.Fatal("the fork did not fail")
	}
	if after := e.chatDirs(); !reflect.DeepEqual(after, before) {
		t.Fatalf("the failed fork left %v, was %v", after, before)
	}
}

func sortedIDs(imgs ...model.Image) []string {
	ids := idsOf(imgs)
	sort.Strings(ids)
	return ids
}
