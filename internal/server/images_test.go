package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
)

// The image routes, as the page calls them: every answer is checked by its status, its headers
// and its JSON keys.

// png is a small file that starts as a PNG does and differs by seed.
func png(seed string) []byte { return append([]byte("\x89PNG\r\n\x1a\n"), seed...) }

func imageIDOf(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// upload posts an image to the chat as the client named, with the type stated, and returns the
// status and the answer.
func (e *env) upload(client, chat, name, stated string, body io.Reader) (int, string) {
	e.t.Helper()
	req, _ := http.NewRequest("POST", e.url+"/api/chats/"+chat+"/images?name="+url.QueryEscape(name), body)
	if client != "" {
		req.Header.Set(ClientHeader, client)
	}
	if stated != "" {
		req.Header.Set("Content-Type", stated)
	}
	// As a browser does not, the test waits for the server's go-ahead before it sends the body:
	// an upload that is refused unread is then answered, and not cut while its body is written.
	req.Header.Set("Expect", "100-continue")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// uploaded uploads png(seed) under the name <seed>.png and returns the image.
func (e *env) uploaded(chat, seed string) model.Image {
	e.t.Helper()
	status, out := e.upload(clientID, chat, seed+".png", "image/png", bytes.NewReader(png(seed)))
	if status != 200 {
		e.t.Fatalf("upload of %s: %d %s", seed, status, out)
	}
	return decode[model.Image](e.t, out)
}

// imagesOf is the names of the files in the chat's image folder other than the index; nil with no
// folder.
func (e *env) imagesOf(chat string) []string {
	e.t.Helper()
	ents, err := os.ReadDir(filepath.Join(e.st.P.ChatDir(chat), "images"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		e.t.Fatal(err)
	}
	out := []string{}
	for _, en := range ents {
		if en.Name() != "index.json" {
			out = append(out, en.Name())
		}
	}
	return out
}

func imagesJSON(imgs ...model.Image) string {
	b, _ := json.Marshal(imgs)
	return string(b)
}

func TestImageUploadAndFetch(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	chat := e.chat(`{"agent":"claude","group":"__ungrouped__"}`).ID
	data := png("a screenshot")

	status, out := e.upload(clientID, chat, " my shot\n.png ", "image/png", bytes.NewReader(data))
	if status != 200 {
		t.Fatalf("the upload: %d %s", status, out)
	}
	sameJSON(t, "the upload's answer", decode[any](t, out),
		`{"id":"`+imageIDOf(data)+`","name":"my shot.png","type":"image/png","size":`+strconv.Itoa(len(data))+`}`)
	img := decode[model.Image](t, out)

	// The fetch: the bytes, with the stored type, not to be guessed at, for the app's own origin
	// alone, and cacheable for good.
	path := "/api/chats/" + chat + "/images/" + img.ID
	resp, body := e.getClient(path, nil)
	if resp.StatusCode != 200 || body != string(data) {
		t.Fatalf("the fetch: %d %q", resp.StatusCode, body)
	}
	for h, want := range map[string]string{
		"Content-Type":                 "image/png",
		"Content-Length":               strconv.Itoa(len(data)),
		"X-Content-Type-Options":       "nosniff",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Cache-Control":                "private, max-age=31536000, immutable",
		"Content-Security-Policy":      "default-src 'none'; sandbox",
	} {
		if got := resp.Header.Get(h); got != want {
			t.Errorf("the fetch's %s is %q, want %q", h, got, want)
		}
	}
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Error("the fetch allows another origin")
	}
	// The page's own fetch, and the address typed by the user, are served; a page of another
	// site, or of another port of this machine, is not, whatever it knows of the address.
	own := "http://" + strings.TrimPrefix(e.url, "http://")
	for _, c := range []struct {
		what string
		hdr  map[string]string
		want int
	}{
		{"the app's own page", map[string]string{"Sec-Fetch-Site": "same-origin"}, 200},
		{"the address typed", map[string]string{"Sec-Fetch-Site": "none"}, 200},
		{"the app's own origin named", map[string]string{"Origin": own}, 200},
		{"another site", map[string]string{"Sec-Fetch-Site": "cross-site"}, 403},
		{"another port of this machine", map[string]string{"Sec-Fetch-Site": "same-site"}, 403},
		{"another origin named", map[string]string{"Origin": "http://evil.example"}, 403},
		{"another port named", map[string]string{"Origin": "http://127.0.0.1:1"}, 403},
		{"no origin named", map[string]string{"Origin": "null"}, 403},
	} {
		resp, body := e.getClient(path, c.hdr)
		if resp.StatusCode != c.want {
			t.Errorf("a fetch from %s: %d, want %d", c.what, resp.StatusCode, c.want)
		}
		if c.want == 403 && (strings.Contains(body, "PNG") || decode[refusal](t, body).Code != "image_origin") {
			t.Errorf("a fetch from %s was answered %q", c.what, body)
		}
	}

	// The id is checked for its form before anything is looked up; an image the chat does not
	// hold, and a chat that is not there, are 404.
	for _, bad := range []string{"x", strings.Repeat("g", 64), strings.ToUpper(img.ID), img.ID + "0", "index.json", "..%2Fchat.json"} {
		if r := decode[refusal](t, e.expect(400, "GET", "/api/chats/"+chat+"/images/"+bad, "")); r.Code != "image_id" {
			t.Errorf("a fetch of %q: %+v", bad, r)
		}
	}
	e.expect(404, "GET", "/api/chats/"+chat+"/images/"+imageIDOf(png("never")), "")
	e.expect(404, "GET", "/api/chats/nope/images/"+img.ID, "")

	// The same bytes again: the same image, one file.
	if again := e.uploaded(chat, "a screenshot"); again.ID != img.ID || len(e.imagesOf(chat)) != 1 {
		t.Fatalf("the second upload: %+v, %v", again, e.imagesOf(chat))
	}
}

// eofAfter gives n bytes of a PNG and then fails: an upload that is cut.
type eofAfter struct{ left int }

func (r *eofAfter) Read(p []byte) (int, error) {
	if r.left <= 0 {
		return 0, errors.New("the connection was lost")
	}
	n := min(len(p), r.left)
	copy(p, bytes.Repeat([]byte("\x89PNG\r\n\x1a\n"), n/8+1)[:n])
	r.left -= n
	return n, nil
}

// noLength hides the length of a body, so it is sent in chunks with no Content-Length.
type noLength struct{ io.Reader }

func TestImageUploadRefusals(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	chat := e.chat(`{"agent":"claude","group":"__ungrouped__"}`).ID
	big := append(png("big"), make([]byte, model.ImageMaxBytes)...)

	for _, c := range []struct {
		what, stated string
		body         io.Reader
		status       int
		code         string
	}{
		{"an SVG", "image/svg+xml", strings.NewReader(`<svg xmlns="http://www.w3.org/2000/svg"/>`), 415, "image_type"},
		{"HTML uploaded as a PNG", "image/png", strings.NewReader("<!doctype html><script>alert(1)</script>"), 415, "image_type"},
		{"a PNG uploaded as a JPEG", "image/jpeg", bytes.NewReader(png("x")), 415, "image_type"},
		{"a PNG uploaded as nothing", "", bytes.NewReader(png("x")), 415, "image_type"},
		{"no bytes", "image/png", nil, 415, "image_type"},
		{"an image over the limit, by its length", "image/png", bytes.NewReader(big), 413, "image_too_large"},
		{"an image over the limit, sent without a length", "image/png", noLength{bytes.NewReader(big)}, 413, "image_too_large"},
	} {
		status, out := e.upload(clientID, chat, "f.png", c.stated, c.body)
		if r := decode[refusal](t, out); status != c.status || r.Code != c.code || r.Error == "" {
			t.Errorf("%s: %d %s, want %d %s", c.what, status, out, c.status, c.code)
		}
	}
	// Who may upload is who may save the draft: a known client, to a chat that is there.
	for _, client := range []string{"", "nobody"} {
		if status, out := e.upload(client, chat, "f.png", "image/png", bytes.NewReader(png("x"))); status != 409 || decode[refusal](t, out).Error != "unknown_client" {
			t.Errorf("an upload of the client %q: %d %s", client, status, out)
		}
	}
	if status, out := e.upload(clientID, "nope", "f.png", "image/png", bytes.NewReader(png("x"))); status != 404 {
		t.Errorf("an upload to no chat: %d %s", status, out)
	}
	if got := e.imagesOf(chat); got != nil {
		t.Fatalf("the refused uploads left %v", got)
	}

	// An upload that is cut leaves no image: the server gets less than the request said.
	req, _ := http.NewRequest("POST", e.url+"/api/chats/"+chat+"/images?name=cut.png", &eofAfter{left: 64 << 10})
	req.Header.Set(ClientHeader, clientID)
	req.Header.Set("Content-Type", "image/png")
	req.ContentLength = 1 << 20
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
		if resp.StatusCode == 200 {
			t.Fatal("a cut upload was answered 200")
		}
	}
	e.uploaded(chat, "after the cut")
	if got := e.imagesOf(chat); len(got) != 1 || got[0] != imageIDOf(png("after the cut")) {
		t.Fatalf("after a cut upload the store holds %v", got)
	}

	// The cap of images that were never sent.
	for i := 1; i < model.ImagesUnsentPerChat; i++ {
		e.uploaded(chat, "n"+strconv.Itoa(i))
	}
	status, out := e.upload(clientID, chat, "f.png", "image/png", bytes.NewReader(png("one too many")))
	if r := decode[refusal](t, out); status != 409 || r.Code != "image_cap" || !strings.Contains(r.Error, "50 images") {
		t.Fatalf("the upload past the cap: %d %s", status, out)
	}
	if n := len(e.imagesOf(chat)); n != model.ImagesUnsentPerChat {
		t.Fatalf("%d images after the refused upload", n)
	}
}

// counted counts the bytes that were read from it.
type counted struct {
	io.Reader
	n atomic.Int64
}

func (c *counted) Read(p []byte) (int, error) {
	n, err := c.Reader.Read(p)
	c.n.Add(int64(n))
	return n, err
}

// zeros gives zero bytes without end.
type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// An upload to a chat of this server is cut at the size limit before it is read, on the listener
// of the server's own page: one that says it is larger is refused with none of its bytes asked
// for, and one that does not say is read no further than the limit, however long it is. Nor is a
// byte asked for of an upload to a chat that takes none.
func TestImageUploadIsCutBeforeItIsRead(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	chat := e.chat(`{"agent":"claude","group":"__ungrouped__"}`).ID
	at := e.url + "/api/chats/" + chat + "/images"
	hdr := map[string]string{ClientHeader: clientID}
	c := patient(t)

	big := append(png("big"), make([]byte, model.ImageMaxBytes)...)
	status, out, read := uploadAsked(t, c, at, hdr, big)
	if status != 413 || decode[refusal](t, out).Code != "image_too_large" || read {
		t.Fatalf("an upload over the limit by its length: %d %s, read %v", status, out, read)
	}
	if status, out, read = uploadAsked(t, c, e.url+"/api/chats/nope/images", hdr, png("x")); status != 404 || read {
		t.Fatalf("an upload to no chat: %d %s, read %v", status, out, read)
	}
	// Within the limit the same client's upload is asked for, and read.
	if status, out, read = uploadAsked(t, c, at, hdr, png("small")); status != 200 || !read {
		t.Fatalf("an upload within the limit: %d %s, read %v", status, out, read)
	}

	// Without a length: eight times the limit is on offer, and the server takes the limit and
	// what was on its way by then, not the upload.
	body := &counted{Reader: io.LimitReader(io.MultiReader(bytes.NewReader(png("endless")), zeros{}), 8*model.ImageMaxBytes)}
	req, _ := http.NewRequest("POST", at+"?name=endless.png", noLength{body})
	req.Header.Set(ClientHeader, clientID)
	req.Header.Set("Content-Type", "image/png")
	resp, err := http.DefaultClient.Do(req)
	if err == nil { // (a client may see its connection closed before it reads the answer)
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 413 || decode[refusal](t, string(raw)).Code != "image_too_large" {
			t.Fatalf("an upload over the limit without a length: %d %s", resp.StatusCode, raw)
		}
	}
	if n := body.n.Load(); n > 4*model.ImageMaxBytes {
		t.Fatalf("%d bytes of an upload without a length were taken, the limit is %d", n, model.ImageMaxBytes)
	}
	if got := e.imagesOf(chat); len(got) != 1 || got[0] != imageIDOf(png("small")) {
		t.Fatalf("after the refused uploads the store holds %v", got)
	}
}

// imageEnv is an env whose Claude chats are scripted processes that keep the blocks they are
// sent.
func imageEnv(t *testing.T) (*env, func() [][]agent.ContentBlock) {
	t.Helper()
	f := agenttest.New(model.Claude)
	var mu sync.Mutex
	var got [][]agent.ContentBlock
	f.Script(func(turn *agenttest.Turn) {
		mu.Lock()
		got = append(got, turn.Raw)
		mu.Unlock()
		turn.Say("seen")
	})
	e := newEnv(t, func(s *Server) { s.App.Chats.Spawners[model.Claude] = f })
	t.Cleanup(func() {
		for _, v := range e.s.App.Chats.Views() {
			e.s.App.Chats.Stop(v.ID)
		}
	})
	return e, func() [][]agent.ContentBlock {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(got)
	}
}

// idle waits until the chat's turn is over.
func (e *env) idle(chat string) {
	e.t.Helper()
	for deadline := time.Now().Add(waitLimit); e.s.App.Chats.Busy(chat) || e.get("/api/chats/" + chat)["status"] != "ready"; time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			e.t.Fatalf("the turn of %s did not end", chat)
		}
	}
}

// A draft with images and a message with images, through the routes.
func TestDraftAndMessageWithImages(t *testing.T) {
	t.Parallel()
	e, sent := imageEnv(t)
	chat := e.chat(`{"agent":"claude","group":"__ungrouped__"}`).ID
	at := "/api/chats/" + chat
	a, b := e.uploaded(chat, "a"), e.uploaded(chat, "b")
	gone := imageIDOf(png("never uploaded"))

	// The draft: images alone are a draft; what is not held is left out and named.
	out := e.expect(200, "PUT", at+"/draft?rev=0", `{"text":"","images":`+imagesJSON(a, model.Image{ID: gone, Name: "gone.png"}, model.Image{ID: "bad id"})+`}`)
	sameJSON(t, "a draft save that names images the chat lacks", decode[any](t, out), `{"ok":true,"rev":1,"missing":["`+gone+`","bad id"]}`)
	v := e.get(at)
	sameJSON(t, "the draft in the view", v["draft"], `{"text":"","images":[{"id":"`+a.ID+`","name":"a.png","type":"image/png","size":`+strconv.FormatInt(a.Size, 10)+`}]}`)
	if v["hasDraft"] != true {
		t.Fatalf("a draft of images alone is not counted as a draft: %v", v)
	}
	out = e.expect(200, "PUT", at+"/draft?rev=1", `{"text":"look","images":`+imagesJSON(a, b)+`}`)
	sameJSON(t, "a draft save whose images are all there", decode[any](t, out), `{"ok":true,"rev":2}`)
	stale := decode[obj](t, e.expect(409, "PUT", at+"/draft?rev=1", `{"text":"late","images":[]}`))
	if stale["code"] != "stale" || stale["rev"] != float64(2) || len(stale) != 4 {
		t.Fatalf("the stale answer: %v", stale)
	}

	// The refusals of a message, each with its code, and nothing left behind.
	eleven := []model.Image{a, b}
	for i := 0; i < 9; i++ {
		eleven = append(eleven, e.uploaded(chat, "m"+strconv.Itoa(i)))
	}
	msg := func(imgs string) string { return `{"text":"look","context":"","images":` + imgs + `}` }
	if r := decode[obj](t, e.expect(400, "POST", at+"/messages", msg(`[{"id":"nope"}]`))); r["code"] != "image_id" || len(r) != 2 {
		t.Fatalf("an id of the wrong form: %v", r)
	}
	missing := decode[obj](t, e.expect(409, "POST", at+"/messages", msg(imagesJSON(a, model.Image{ID: gone}))))
	if missing["code"] != "image_missing" || !reflect.DeepEqual(missing["images"], []any{gone}) || missing["error"] == "" || len(missing) != 3 {
		t.Fatalf("images the chat lacks: %v", missing)
	}
	if r := decode[obj](t, e.expect(400, "POST", at+"/messages", msg(imagesJSON(eleven...)))); r["code"] != "image_limit" || len(r) != 2 {
		t.Fatalf("eleven images: %v", r)
	}
	if items := e.get(at + "/items")["items"].([]any); len(items) != 0 || len(sent()) != 0 {
		t.Fatalf("the refused messages left %v, and the agent got %d", items, len(sent()))
	}
	if v := e.get(at); v["locked"] != false || field(v, "draft", "text") != "look" || v["draftRev"] != float64(2) {
		t.Fatalf("the chat after the refused messages: %v", v)
	}

	// The message: its item holds the images, the agent gets them directly before the text.
	sentOn(t, "a message with images", e.expect(200, "POST", at+"/messages", msg(imagesJSON(b, a))), "main")
	e.idle(chat)
	items := e.get(at + "/items")["items"].([]any)
	sameJSON(t, "the message's images", items[0].(obj)["images"], imagesJSON(
		model.Image{ID: b.ID, Name: "b.png", Type: "image/png", Size: b.Size}, model.Image{ID: a.ID, Name: "a.png", Type: "image/png", Size: a.Size}))
	blocks := sent()
	if len(blocks) != 1 || len(blocks[0]) != 3 {
		t.Fatalf("the agent got %+v", blocks)
	}
	if im := blocks[0][0].Image; im == nil || im.Name != "b.png" || im.Type != "image/png" || !bytes.Equal(im.Data, png("b")) {
		t.Fatalf("the first block %+v", blocks[0][0])
	}
	if im := blocks[0][1].Image; im == nil || !bytes.Equal(im.Data, png("a")) {
		t.Fatalf("the second block %+v", blocks[0][1])
	}
	if blocks[0][2].Image != nil || blocks[0][2].Text != "look" {
		t.Fatalf("the text block %+v", blocks[0][2])
	}
	if v := e.get(at); v["draft"] != nil || v["hasDraft"] == true {
		t.Fatalf("the draft after the message: %v", v["draft"])
	}

	// A message of images alone: the tree names it by the one word.
	sentOn(t, "a message of images alone", e.expect(200, "POST", at+"/messages", `{"text":"","context":"","images":`+imagesJSON(b)+`}`), "main")
	e.idle(chat)
	tree := e.get(at + "/tree")["branches"].([]any)[0].(obj)["items"].([]any)
	var words []string
	for _, it := range tree {
		if it.(obj)["kind"] == "user" {
			words = append(words, it.(obj)["text"].(string))
		}
	}
	if !reflect.DeepEqual(words, []string{"look", model.ImageWord}) {
		t.Fatalf("the tree names the messages %q", words)
	}
	if last := sent()[1]; len(last) != 2 || last[0].Image == nil || last[1].Text != "" {
		t.Fatalf("the agent got %+v for the message of images alone", last)
	}
}

// A model that takes no images refuses a message with them, in a sentence that names the model:
// the chat's own, or the one the Send names for its target.
func TestMessageWithImagesForAModelWithout(t *testing.T) {
	t.Parallel()
	e, sp := flowEnv(t)
	cat := &model.Catalog{Models: []model.CatalogModel{{ID: "sees", Label: "Sees"}, {ID: "blind", Label: "Blind One", NoImages: true}},
		Default: model.ModelChoice{Model: "sees"}}
	if err := e.st.Update(func(s *model.State) error { s.SetCatalog(model.Claude, cat); return nil }); err != nil {
		t.Fatal(err)
	}
	chat := e.chat(`{"agent":"claude","group":"__ungrouped__"}`).ID
	at := "/api/chats/" + chat
	img := e.uploaded(chat, "a")
	with := `"images":` + imagesJSON(img)

	e.expect(200, "PATCH", at, `{"model":"blind"}`)
	r := decode[obj](t, e.expect(400, "POST", at+"/messages", `{"text":"see","context":"",`+with+`}`))
	if r["code"] != "image_model" || !strings.HasPrefix(r["error"].(string), "Blind One takes no images") || len(r) != 2 {
		t.Fatalf("images for a model that takes none: %v", r)
	}
	if items := e.get(at + "/items")["items"].([]any); len(items) != 0 {
		t.Fatalf("the refused message left %v", items)
	}
	// Without the images the same model takes the message.
	e.expect(200, "POST", at+"/messages", `{"text":"words only","context":""}`)
	reply(t, sp.last(t), "ok", "p1")

	// A new branch on a model that takes images takes them; one on the model that takes none
	// does not, whatever the model of the branch it starts from.
	target := func(m string) string { return `"target":{"branch":"main","at":0,"new":true,"model":"` + m + `"}` }
	r = decode[obj](t, e.expect(400, "POST", at+"/messages", `{"text":"see","context":"",`+with+`,`+target("blind")+`}`))
	if r["code"] != "image_model" || !strings.Contains(r["error"].(string), "Blind One") {
		t.Fatalf("images for a target on a model that takes none: %v", r)
	}
	if n := len(e.get(at + "/tree")["branches"].([]any)); n != 1 {
		t.Fatalf("the refused message left %d branches", n)
	}
	out := decode[obj](t, e.expect(200, "POST", at+"/messages", `{"text":"see","context":"",`+with+`,`+target("sees")+`}`))
	if out["ok"] != true || out["branch"] == "main" {
		t.Fatalf("images for a target on a model that takes them: %v", out)
	}
}

// Fork and edit: the fork's draft carries the message's images, and the fork has its own copies.
func TestForkAndEditCarriesImages(t *testing.T) {
	t.Parallel()
	e, sp := flowEnv(t)
	chat := e.chat(`{"agent":"claude","group":"__ungrouped__"}`).ID
	at := "/api/chats/" + chat
	a, b := e.uploaded(chat, "a"), e.uploaded(chat, "b")
	e.expect(200, "POST", at+"/messages", `{"text":"first","context":"","images":`+imagesJSON(a)+`}`)
	reply(t, sp.last(t), "one", "p1")
	e.expect(200, "POST", at+"/messages", `{"text":"second","context":"","images":`+imagesJSON(b, a)+`}`)
	reply(t, sp.last(t), "two", "p2")

	fork := decode[obj](t, e.expect(200, "POST", at+"/fork", `{"branch":"main","at":3,"message":3}`))
	forkID := fork["id"].(string)
	sameJSON(t, "the fork's draft", fork["draft"], `{"text":"second","images":`+imagesJSON(
		model.Image{ID: b.ID, Name: "b.png", Type: "image/png", Size: b.Size}, model.Image{ID: a.ID, Name: "a.png", Type: "image/png", Size: a.Size})+`}`)
	for _, im := range []model.Image{a, b} {
		resp, body := e.getClient("/api/chats/"+forkID+"/images/"+im.ID, nil)
		if resp.StatusCode != 200 || body != string(png(strings.TrimSuffix(im.Name, ".png"))) {
			t.Fatalf("the fork's copy of %s: %d", im.Name, resp.StatusCode)
		}
	}
	// The source is deleted: the fork keeps its images, and can send its draft.
	e.expect(200, "DELETE", at, "")
	e.expect(404, "GET", at+"/images/"+a.ID, "")
	if resp, body := e.getClient("/api/chats/"+forkID+"/images/"+a.ID, nil); resp.StatusCode != 200 || body != string(png("a")) {
		t.Fatalf("the fork's image after its source was deleted: %d", resp.StatusCode)
	}
	e.expect(200, "POST", "/api/chats/"+forkID+"/messages", `{"text":"second, edited","context":"","images":`+imagesJSON(b, a)+`}`)
	// Deleting a chat removes its images.
	e.expect(200, "DELETE", "/api/chats/"+forkID, "")
	if _, err := os.Stat(e.st.P.ChatDir(forkID)); !os.IsNotExist(err) {
		t.Fatalf("the deleted chat's folder: %v", err)
	}
}
