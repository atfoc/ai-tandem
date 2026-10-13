package server

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
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
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
	"ai-whiteboard/internal/testset"
)

// uploadAt is upload for a chat that is named by the path at: a chat of a section.
func (e *env) uploadAt(client, at, name, stated string, body io.Reader) (int, string) {
	e.t.Helper()
	req, _ := http.NewRequest("POST", e.url+at+"/images?name="+url.QueryEscape(name), body)
	if client != "" {
		req.Header.Set(ClientHeader, client)
	}
	if stated != "" {
		req.Header.Set("Content-Type", stated)
	}
	req.Header.Set("Expect", "100-continue") // as upload: an upload refused unread is answered
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// The images of a chat of a section. The store is that server's: this one passes the upload,
// the fetch, the draft save and the Send on, and keeps nothing. Two rigs: the pair (two real
// stacks, boardpair_test.go) shows that each call reaches the other server and is answered as
// it answers, and the far (a stand-in for the other server, section_rig_test.go) shows what is
// passed on, what is checked here first, and what is made of an answer no server should give.

// imageHeaders are the headers every image is served with, whichever server holds it.
var imageHeaders = map[string]string{
	"X-Content-Type-Options":       "nosniff",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Cache-Control":                "private, max-age=31536000, immutable",
	"Content-Security-Policy":      "default-src 'none'; sandbox",
	"Content-Disposition":          "inline",
}

// servedAsImage fails unless resp is an image of the type typ with the bytes data, under the
// headers of imageHeaders and no header that lets another site read it.
func servedAsImage(t *testing.T, what string, resp *http.Response, body, typ string, data []byte) {
	t.Helper()
	if resp.StatusCode != http.StatusOK || body != string(data) {
		t.Fatalf("%s: %d with %d bytes, want 200 with the %d of the image", what, resp.StatusCode, len(body), len(data))
	}
	want := map[string]string{"Content-Type": typ, "Content-Length": strconv.Itoa(len(data))}
	for h, v := range imageHeaders {
		want[h] = v
	}
	for h, v := range want {
		if got := resp.Header.Get(h); got != v {
			t.Errorf("%s: %s is %q, want %q", what, h, got, v)
		}
	}
	for _, h := range []string{"Access-Control-Allow-Origin", "Set-Cookie", "Location", "X-There"} {
		if got := resp.Header.Get(h); got != "" {
			t.Errorf("%s: the answer has %s: %q", what, h, got)
		}
	}
}

// patient is a client that waits a minute for a server's go-ahead before it sends the body of a
// request that asks for one (Expect: 100-continue). A server gives the go-ahead when it starts
// to read the body, so a body this client was never asked for is one the server did not read.
func patient(t *testing.T) *http.Client {
	tr := &http.Transport{ExpectContinueTimeout: time.Minute, TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, ForceAttemptHTTP2: true}
	t.Cleanup(tr.CloseIdleConnections)
	return &http.Client{Transport: tr}
}

// marked says whether anything was read from it.
type marked struct {
	io.Reader
	read atomic.Bool
}

func (m *marked) Read(p []byte) (int, error) {
	m.read.Store(true)
	return m.Reader.Read(p)
}

// uploadAsked posts data as an upload of a PNG with c, with the headers hdr, and says whether the
// server asked for the bytes before it answered.
func uploadAsked(t *testing.T, c *http.Client, at string, hdr map[string]string, data []byte) (status int, out string, read bool) {
	t.Helper()
	body := &marked{Reader: bytes.NewReader(data)}
	req, _ := http.NewRequest("POST", at, body)
	req.ContentLength = int64(len(data)) // known, so that nothing is read to find it out
	req.Header.Set("Content-Type", "image/png")
	req.Header.Set("Expect", "100-continue")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", at, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b), body.read.Load()
}

// Everything of a chat's images holds for a chat of a section, between two real stacks: A is
// the user's own server, B the server the chat is on. The upload, the fetch, the draft save
// and the Send reach B, each is answered as B answers it, and A keeps nothing.
func TestImagesOfAChatOnAnotherServer(t *testing.T) {
	t.Parallel()
	// B's Claude chats are scripted processes that keep the blocks they are sent.
	fake := agenttest.New(model.Claude)
	var mu sync.Mutex
	var got [][]agent.ContentBlock
	fake.Script(func(turn *agenttest.Turn) {
		mu.Lock()
		got = append(got, turn.Raw)
		mu.Unlock()
		turn.Say("seen")
	})
	pr := newPairWith(t, remotes.Limits{}, nil, []func(*Server){func(s *Server) { s.App.Chats.Spawners[model.Claude] = fake }})
	a, b := pr.a, pr.b
	t.Cleanup(func() {
		for _, v := range b.s.App.Chats.Views() {
			b.s.App.Chats.Stop(v.ID)
		}
	})
	p := a.page("P")   // this app's page
	own := b.page("O") // the page of the server the chat is on
	cv := decode[model.ChatView](t, string(do(t, p, "POST", pr.on("/chats"), obj{"agent": "claude", "group": model.Ungrouped})))
	// The chat is named by at on A, in B's section, and by there on B itself.
	id, at, there := cv.ID, pr.on("/chats/"+cv.ID), "/api/chats/"+cv.ID
	if _, err := b.a.Chats.View(id); err != nil || cv.Locked {
		t.Fatalf("the new chat: %+v, on B %v", cv, err)
	}
	upload := func(seed string) model.Image {
		t.Helper()
		status, out := a.uploadAt(p.ID, at, seed+".png", "image/png", bytes.NewReader(png(seed)))
		if status != 200 {
			t.Fatalf("the upload of %s: %d %s", seed, status, out)
		}
		return decode[model.Image](t, out)
	}

	// The upload: B answers, with the name it cleaned and the type it found, and B holds the
	// image. A has no folder for the chat.
	data := png("a screenshot")
	status, out := a.uploadAt(p.ID, at, " my shot\n.png ", "image/png", bytes.NewReader(data))
	if status != 200 {
		t.Fatalf("the upload: %d %s", status, out)
	}
	sameJSON(t, "the upload's answer", decode[any](t, out),
		`{"id":"`+imageIDOf(data)+`","name":"my shot.png","type":"image/png","size":`+strconv.Itoa(len(data))+`}`)
	shot := decode[model.Image](t, out)
	if held := b.imagesOf(id); !slices.Equal(held, []string{shot.ID}) {
		t.Fatalf("B holds %v", held)
	}
	// A large image goes through both servers and comes back whole: in the full set one of
	// exactly the size limit, which takes four seconds on the pair's link of 20 Mbit/s, and else
	// one of 256 KB. One byte more than the limit is refused by A, and B is sent nothing of it.
	size := 256 << 10
	if testset.Full() {
		size = model.ImageMaxBytes
	}
	full := append(png("full"), make([]byte, size-len(png("full")))...)
	if status, out = a.uploadAt(p.ID, at, "full.png", "image/png", bytes.NewReader(full)); status != 200 || decode[model.Image](t, out).Size != int64(size) {
		t.Fatalf("the upload of a large image: %d %s", status, out)
	}
	over := append(png("over"), make([]byte, model.ImageMaxBytes)...)[:model.ImageMaxBytes+1]
	if status, out = a.uploadAt(p.ID, at, "over.png", "image/png", bytes.NewReader(over)); status != 413 || decode[refusal](t, out).Code != "image_too_large" {
		t.Fatalf("the upload of an image over the size limit: %d %s", status, out)
	}
	if held := b.imagesOf(id); len(held) != 2 {
		t.Fatalf("B holds %v after the refused upload", held)
	}

	// The fetch: the bytes, under the headers of an image of A itself.
	resp, body := a.getClient(at+"/images/"+shot.ID, nil)
	servedAsImage(t, "the fetch", resp, body, "image/png", data)
	resp, body = a.getClient(at+"/images/"+imageIDOf(full), nil)
	servedAsImage(t, "the fetch of the large image", resp, body, "image/png", full)
	// It is B's answer for an image the chat does not hold, and for the page of another site.
	gone := imageIDOf(png("never uploaded"))
	if resp, body = a.getClient(at+"/images/"+gone, nil); resp.StatusCode != 404 || decode[refusal](t, body).Error != chats.ErrNoImage.Error() {
		t.Fatalf("the fetch of an image the chat does not hold: %d %s", resp.StatusCode, body)
	}
	if resp, body = a.getClient(at+"/images/"+shot.ID, map[string]string{"Sec-Fetch-Site": "cross-site"}); resp.StatusCode != 403 || decode[refusal](t, body).Code != "image_origin" {
		t.Fatalf("the fetch by another site: %d %s", resp.StatusCode, body)
	}

	// B's refusal of an upload reaches the page as B's own page gets it: the status, the code
	// and the sentence.
	svg := `<svg xmlns="http://www.w3.org/2000/svg"/>`
	status, out = a.uploadAt(p.ID, at, "f.svg", "image/svg+xml", strings.NewReader(svg))
	thereStatus, thereOut := b.upload(own.ID, id, "f.svg", "image/svg+xml", strings.NewReader(svg))
	if status != 415 || status != thereStatus || !reflect.DeepEqual(decode[obj](t, out), decode[obj](t, thereOut)) || decode[refusal](t, out).Code != "image_type" {
		t.Fatalf("an SVG through A: %d %s, on B itself: %d %s", status, out, thereStatus, thereOut)
	}

	// The draft is B's, with its images: what B does not hold is left out and named, and so is
	// an id of the wrong form, which A never sends to B.
	one, two := upload("one"), upload("two")
	saved := string(do(t, p, "PUT", at+"/draft?rev=0", `{"text":"","images":`+imagesJSON(one, model.Image{ID: gone, Name: "gone.png"}, model.Image{ID: "bad id"})+`}`))
	sameJSON(t, "a draft save that names images the chat lacks", decode[any](t, saved), `{"ok":true,"rev":1,"missing":["`+gone+`","bad id"]}`)
	wantDraft := `{"text":"","images":[{"id":"` + one.ID + `","name":"one.png","type":"image/png","size":` + strconv.FormatInt(one.Size, 10) + `}]}`
	sameJSON(t, "the draft on B", b.get(there)["draft"], wantDraft)
	var last int64
	if st := draftSeen(t, p, pr.entry, id, 1, &last); st.Draft == nil || len(st.Draft.Images) != 1 || st.Draft.Images[0].ID != one.ID {
		t.Fatalf("A's page was told the draft %+v", st.Draft)
	}
	if v := decode[obj](t, string(do(t, p, "GET", at, nil))); v["hasDraft"] != true || !reflect.DeepEqual(v["draft"], decode[any](t, wantDraft)) {
		t.Fatalf("the chat as A's page reads it: %v", v)
	}
	saved = string(do(t, p, "PUT", at+"/draft?rev=1", `{"text":"look","images":`+imagesJSON(one, two)+`}`))
	sameJSON(t, "a draft save whose images are all there", decode[any](t, saved), `{"ok":true,"rev":2}`)
	if st, stale := p.Do("PUT", at+"/draft?rev=1", `{"text":"late","images":[]}`); st != 409 || decode[obj](t, string(stale))["code"] != "stale" {
		t.Fatalf("a save on the counter before: %d %s", st, stale)
	}

	// The refusals of a Send are B's, each with its code, and nothing is left of the message.
	msg := func(imgs string) string { return `{"text":"look","context":"","images":` + imgs + `}` }
	refused := func(what string, want int, code, body string) obj {
		t.Helper()
		st, out := p.Do("POST", at+"/messages", body)
		r := decode[obj](t, string(out))
		if st != want || r["code"] != code || r["error"] == "" {
			t.Fatalf("%s: %d %s, want %d %s", what, st, out, want, code)
		}
		return r
	}
	if r := refused("images the chat lacks", 409, "image_missing", msg(imagesJSON(one, model.Image{ID: gone}))); !reflect.DeepEqual(r["images"], []any{gone}) || len(r) != 3 {
		t.Fatalf("images the chat lacks: %v", r)
	}
	eleven := []model.Image{one, two} // B counts the images of a message before it looks one up
	for i := 0; i < 9; i++ {
		eleven = append(eleven, model.Image{ID: imageIDOf(png("m" + strconv.Itoa(i)))})
	}
	refused("eleven images", 400, "image_limit", msg(imagesJSON(eleven...)))
	refused("an id of the wrong form", 400, "image_id", msg(`[{"id":"nope"}]`))
	mu.Lock()
	n := len(got)
	mu.Unlock()
	if items := b.get(there + "/items")["items"].([]any); len(items) != 0 || n != 0 {
		t.Fatalf("the refused messages left %v on B, and its agent got %d", items, n)
	}

	// The Send: B's agent gets the images directly before the text, B's thread holds them, and
	// the draft is cleared there.
	sentOn(t, "a message with images", string(do(t, p, "POST", at+"/messages", msg(imagesJSON(two, one)))), "main")
	b.idle(id)
	mu.Lock()
	blocks := slices.Clone(got)
	mu.Unlock()
	if len(blocks) != 1 || len(blocks[0]) != 3 {
		t.Fatalf("B's agent got %+v", blocks)
	}
	if im := blocks[0][0].Image; im == nil || im.Name != "two.png" || im.Type != "image/png" || !bytes.Equal(im.Data, png("two")) {
		t.Fatalf("the first block %+v", blocks[0][0])
	}
	if im := blocks[0][1].Image; im == nil || !bytes.Equal(im.Data, png("one")) {
		t.Fatalf("the second block %+v", blocks[0][1])
	}
	if blocks[0][2].Image != nil || blocks[0][2].Text != "look" {
		t.Fatalf("the text block %+v", blocks[0][2])
	}
	want := imagesJSON(model.Image{ID: two.ID, Name: "two.png", Type: "image/png", Size: two.Size}, model.Image{ID: one.ID, Name: "one.png", Type: "image/png", Size: one.Size})
	// The thread as A's page reads it, through A.
	items := decode[obj](t, string(do(t, p, "GET", at+"/items", nil)))["items"].([]any)
	sameJSON(t, "the message's images", items[0].(obj)["images"], want)
	if v := b.get(there); v["draft"] != nil || v["hasDraft"] == true {
		t.Fatalf("the draft on B after the message: %v", v["draft"])
	}
	// An image that was sent is still fetched.
	resp, body = a.getClient(at+"/images/"+two.ID, nil)
	servedAsImage(t, "the fetch of a sent image", resp, body, "image/png", png("two"))

	// A kept nothing of all this: no folder of the chat.
	if _, err := os.Stat(a.st.P.ChatDir(id)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("A has a folder for the chat: %v", err)
	}
}

// What the image calls of a chat of a section pass on to the chat's server, and what is checked
// here before anything is sent.
func TestImageCallsOfASectionArePassedOn(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(farChatA)}})
	p := f.page("P")
	// The chat is named by at here, in the entry's section, and by there on its server.
	at, there := f.on("/chats/"+farChatA), "/api/chats/"+farChatA
	uploads, fetches := imagePatterns[0], imagePatterns[1]
	data := png("a")
	img := model.Image{ID: imageIDOf(data), Name: "a b.png", Type: "image/png", Size: int64(len(data))}

	// The upload goes on as it came: the bytes, the type it states and its name.
	status, out := f.uploadAt(p.ID, at, "a b.png", "image/png", bytes.NewReader(data))
	if status != 200 || decode[model.Image](t, out) != img {
		t.Fatalf("the upload: %d %s", status, out)
	}
	if c := f.last(uploads); c.Path != there+"/images" || c.Query != "name=a+b.png" || c.Body != string(data) || c.Type != "image/png" {
		t.Fatalf("the upload that was passed on: %+v", c)
	}
	// What the upload states is that server's to judge, an upload that states nothing too.
	if status, out = f.uploadAt(p.ID, at, "", "text/html", strings.NewReader("<p>")); status != 200 {
		t.Fatalf("an upload that states another type: %d %s", status, out)
	}
	if c := f.last(uploads); c.Query != "" || c.Body != "<p>" || c.Type != "text/html" {
		t.Fatalf("the upload that states another type was passed on as %+v", c)
	}
	if status, out = f.uploadAt(p.ID, at, "n", "", nil); status != 200 || f.last(uploads).Type != "" || f.last(uploads).Body != "" {
		t.Fatalf("an upload of nothing: %d %s, passed on as %+v", status, out, f.last(uploads))
	}
	// That server's refusals are the page's, each with its status, its code and its sentence.
	for _, r := range []struct {
		status int
		code   string
	}{{413, "image_too_large"}, {415, "image_type"}, {409, "image_cap"}, {409, ""}, {404, ""}} {
		answer := obj{"error": "that server's sentence"}
		if r.code != "" {
			answer["code"] = r.code
		}
		f.answer(uploads, r.status, answer)
		if status, out = f.uploadAt(p.ID, at, "a.png", "image/png", bytes.NewReader(data)); status != r.status || !reflect.DeepEqual(decode[obj](t, out), answer) {
			t.Errorf("an upload that server answers with %d %q: %d %s", r.status, r.code, status, out)
		}
	}
	f.handle(uploads, nil)

	// The upload is cut at the size limit before it is read, and nothing of it is sent: by its
	// length, which is refused unread, and without one. An upload that is cut on its way is not
	// sent either.
	big := append(png("big"), make([]byte, model.ImageMaxBytes)...)
	c := patient(t)
	hdr := map[string]string{ClientHeader: p.ID}
	f.untouched("an upload that is not whole or too large", func() {
		status, out, read := uploadAsked(t, c, f.url+at+"/images", hdr, big)
		if status != 413 || decode[refusal](t, out).Code != "image_too_large" || read {
			t.Errorf("an upload over the limit by its length: %d %s, read %v", status, out, read)
		}
		if status, out := f.uploadAt(p.ID, at, "f.png", "image/png", noLength{bytes.NewReader(big)}); status != 413 || decode[refusal](t, out).Code != "image_too_large" {
			t.Errorf("an upload over the limit without a length: %d %s", status, out)
		}
		req, _ := http.NewRequest("POST", f.url+at+"/images?name=cut.png", &eofAfter{left: 64 << 10})
		req.Header.Set(ClientHeader, p.ID)
		req.Header.Set("Content-Type", "image/png")
		req.ContentLength = 1 << 20
		if resp, err := http.DefaultClient.Do(req); err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				t.Error("a cut upload was answered 200")
			}
		}
	})
	// The same client's upload within the limit is asked for, and read.
	if status, out, read := uploadAsked(t, c, f.url+at+"/images", hdr, data); status != 200 || !read {
		t.Fatalf("an upload within the limit: %d %s, read %v", status, out, read)
	}

	// The fetch: the id is checked for its form before anything is sent, and the image goes to
	// the app's own pages only.
	resp, body := f.getClient(at+"/images/"+img.ID, nil)
	servedAsImage(t, "the fetch", resp, body, "image/png", data)
	if c := f.last(fetches); c.Path != there+"/images/"+img.ID || c.Query != "" || c.Method != "GET" {
		t.Fatalf("the fetch that was passed on: %+v", c)
	}
	f.untouched("a fetch that is refused here", func() {
		for _, bad := range []string{"nope", strings.Repeat("A", 64), strings.Repeat("a", 63), strings.Repeat("a", 65), "..%2F..%2Fstate", url.PathEscape(img.ID + "?x=1")} {
			if resp, body := f.getClient(at+"/images/"+bad, nil); resp.StatusCode != 400 || decode[refusal](t, body).Code != "image_id" || decode[refusal](t, body).Error != chats.ErrImageID.Error() {
				t.Errorf("the fetch of the id %q: %d %s", bad, resp.StatusCode, body)
			}
		}
		for _, hdr := range []map[string]string{{"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}, {"Origin": "http://evil.example"}} {
			if resp, body := f.getClient(at+"/images/"+img.ID, hdr); resp.StatusCode != 403 || decode[refusal](t, body).Code != "image_origin" {
				t.Errorf("the fetch with %v: %d %s", hdr, resp.StatusCode, body)
			}
		}
	})

	// The draft save: an id of another form is never passed on. It is left out of what is sent
	// and named in "missing", with what that server says it does not hold, in the order named.
	gone := imageIDOf(png("gone"))
	good := model.Image{ID: img.ID, Name: "a.png"}
	f.answer(draftRoute, 200, obj{"ok": true, "rev": 7, "missing": []string{gone}})
	draft := `{"text":"typing","images":` + imagesJSON(model.Image{ID: "bad id"}, good, model.Image{ID: "../x"}, model.Image{ID: gone}, model.Image{ID: "bad id"}) + `}`
	sameJSON(t, "a draft save with ids of another form", f.good(p, "PUT", at+"/draft?rev=6", draft), `{"ok":true,"rev":7,"missing":["bad id","../x","`+gone+`"]}`)
	passed := f.last(draftRoute)
	sameJSON(t, "the draft that was passed on", decode[any](t, passed.Body), `{"text":"typing","images":`+imagesJSON(good, model.Image{ID: gone})+`}`)
	if passed.Query != "rev=6" || strings.Contains(passed.Body, "bad id") || strings.Contains(passed.Body, "../x") {
		t.Fatalf("the draft save that was passed on: %+v", passed)
	}
	// A refusal of that server is the page's as it came: "stale" with its draft.
	stale := obj{"error": "stale", "code": "stale", "rev": 9.0, "draft": obj{"text": "there"}}
	f.answer(draftRoute, 409, stale)
	if status, out := f.call(p, "PUT", at+"/draft?rev=6", draft); status != 409 || !reflect.DeepEqual(decode[obj](t, out), stale) {
		t.Fatalf("a stale save with ids of another form: %d %s", status, out)
	}
	f.handle(draftRoute, nil)
	// Whatever the key is spelled like, what is passed on under it is the checked list alone.
	f.good(p, "PUT", at+"/draft?rev=0", `{"IMAGES":`+imagesJSON(model.Image{ID: "bad id"})+`,"text":"typing","Images":`+imagesJSON(good)+`}`)
	sameJSON(t, "a draft whose images are spelled twice", decode[any](t, f.last(draftRoute).Body), `{"text":"typing","images":`+imagesJSON(good)+`}`)
	// A draft whose ids are all of the form goes on with them, and one that names no image
	// goes on as it came, byte for byte.
	f.good(p, "PUT", at+"/draft?rev=1", `{"text":"typing","images":`+imagesJSON(img)+`}`)
	sameJSON(t, "a draft with images", decode[any](t, f.last(draftRoute).Body), `{"text":"typing","images":`+imagesJSON(img)+`}`)
	if asIs := `{ "text": "typed",  "later": [1, 2] }`; f.good(p, "PUT", at+"/draft?rev=2", asIs)["ok"] != true || f.last(draftRoute).Body != asIs {
		t.Errorf("a draft without images was passed on as %q", f.last(draftRoute).Body)
	}
	f.untouched("a draft whose images cannot be read", func() {
		for _, body := range []string{`{"text":"x","images":"all of them"}`, `{"text":"x","images":[1]}`} {
			if status, out := f.call(p, "PUT", at+"/draft?rev=3", body); status != 400 || decode[refusal](t, out).Error == "" {
				t.Errorf("the draft %s: %d %s", body, status, out)
			}
		}
	})

	// The Send: an id of another form refuses the message here, as a chat of this server
	// refuses it, and nothing is sent. With ids of the form it goes on with its images.
	const messages = "POST /api/chats/{id}/messages"
	f.untouched("a message with an id of another form", func() {
		for _, imgs := range []string{`[{"id":"nope"}]`, imagesJSON(good, model.Image{ID: strings.Repeat("g", 64)}), `[{"name":"no id"}]`, `[null]`} {
			for _, key := range []string{"images", "Images"} {
				body := `{"text":"look","context":"","` + key + `":` + imgs + `}`
				if text := f.refuses(p, http.StatusBadRequest, "image_id", "POST", at+"/messages", body); text != chats.ErrImageID.Error() {
					t.Errorf("the message %s: %q", body, text)
				}
			}
		}
		// Images that are no list, and an id of another form under a spelling of the key that
		// server would not take: the same refusal.
		for _, body := range []string{`{"text":"look","images":{"id":"x"}}`, `{"text":"look","Images":[{"id":"../x"}],"images":` + imagesJSON(good) + `}`} {
			if text := f.refuses(p, http.StatusBadRequest, "image_id", "POST", at+"/messages", body); text != chats.ErrImageID.Error() {
				t.Errorf("the message %s: %q", body, text)
			}
		}
	})
	f.good(p, "POST", at+"/messages?branch=main", `{"text":"look","context":"","images":`+imagesJSON(img, good)+`,"target":null}`)
	sent := f.last(messages)
	sameJSON(t, "the message that was passed on", decode[any](t, sent.Body), `{"text":"look","context":"","images":`+imagesJSON(img, good)+`,"target":null}`)
	if sent.Query != "branch=main" {
		t.Fatalf("the message that was passed on: %+v", sent)
	}
	if asIs := `{ "text": "words",  "context": "" }`; f.good(p, "POST", at+"/messages", asIs)["ok"] != true || f.last(messages).Body != asIs {
		t.Errorf("a message without images was passed on as %q", f.last(messages).Body)
	}
	// That server's refusal of a message is the page's as it came, with the images it names.
	missing := obj{"error": "the chat no longer holds one of the message's images: add it again", "code": "image_missing", "images": []any{gone}}
	f.answer(messages, 409, missing)
	if status, out := f.call(p, "POST", at+"/messages", `{"text":"look","images":`+imagesJSON(model.Image{ID: gone})+`}`); status != 409 || !reflect.DeepEqual(decode[obj](t, out), missing) {
		t.Fatalf("a message that server refuses: %d %s", status, out)
	}

	if _, err := os.Stat(f.env.st.P.ChatDir(farChatA)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a folder was made here for the section's chat: %v", err)
	}
}

// An image from another server is never handed on as it came. Of its answer the bytes alone are
// taken: the type is found from them, the four types are allowed, and the headers are this
// server's own. HTML or SVG is refused whatever type that server claims for it, so that no
// server of the list can have this one serve a page of its making from the app's origin.
func TestImageAnswerOfAnotherServerIsNeverHandedOn(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(farChatA)}})
	path := f.on("/chats/" + farChatA + "/images/" + strings.Repeat("a", 64))
	const (
		html = `<!doctype html><html><script>alert(document.domain)</script></html>`
		svg  = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"/>`
	)
	jpeg, gif := append([]byte("\xff\xd8\xff\xe0"), "a jpeg"...), []byte("GIF89a a gif")
	webp := []byte("RIFF\x10\x00\x00\x00WEBPVP8 a webp")
	// hostile are headers a server of the list might send with its answer.
	hostile := map[string]string{
		"Set-Cookie": "session=theirs", "Access-Control-Allow-Origin": "*", "Content-Disposition": `attachment; filename="x.html"`,
		"Content-Security-Policy": "default-src *", "Cache-Control": "no-store", "X-There": "1", "Location": "https://evil.example/",
		"Cross-Origin-Resource-Policy": "cross-origin", "X-Content-Type-Options": "",
	}
	for _, c := range []struct {
		what, claims string
		status       int // 0 = 200
		body         []byte
		typ          string // what it is served as; "" = refused
	}{
		{"HTML that claims to be a PNG", "image/png", 0, []byte(html), ""},
		{"HTML as HTML", "text/html; charset=utf-8", 0, []byte(html), ""},
		{"HTML that claims no type", "", 0, []byte(html), ""},
		{"an SVG as an SVG", "image/svg+xml", 0, []byte(svg), ""},
		{"an SVG that claims to be a PNG", "image/png", 0, []byte(svg), ""},
		{"an SVG that claims to be a GIF", "image/gif", 0, []byte(svg), ""},
		{"an SVG after a line of space, as a PNG", "image/png", 0, []byte("\n " + svg), ""},
		{"JSON", "application/json", 0, []byte(`{"ok":true}`), ""},
		{"no bytes, as a PNG", "image/png", 0, nil, ""},
		{"a PNG over the size limit", "image/png", 0, append(png("big"), make([]byte, model.ImageMaxBytes)...), ""},
		{"a PNG in an answer that is no 200", "image/png", http.StatusPartialContent, png("part"), ""},
		{"a PNG in a redirect", "image/png", http.StatusFound, png("moved"), ""},
		// What is an image is served as what its bytes are, whatever that server claims.
		{"a PNG", "image/png", 0, png("p"), "image/png"},
		{"a PNG that claims to be HTML", "text/html", 0, png("<script>alert(1)</script>"), "image/png"},
		{"a PNG that claims to be an SVG", "image/svg+xml", 0, png(svg), "image/png"},
		{"a JPEG that claims to be a PNG", "image/png", 0, jpeg, "image/jpeg"},
		{"a GIF that claims no type", "", 0, gif, "image/gif"},
		{"a WebP as a stream of bytes", "application/octet-stream", 0, webp, "image/webp"},
	} {
		f.handle(imagePatterns[1], func(w http.ResponseWriter, r *http.Request) {
			for h, v := range hostile {
				w.Header().Set(h, v)
			}
			w.Header()["Content-Type"] = nil // none is guessed where none is claimed
			if c.claims != "" {
				w.Header().Set("Content-Type", c.claims)
			}
			if c.status != 0 {
				w.WriteHeader(c.status)
			}
			w.Write(c.body)
		})
		before := len(f.sent(imagePatterns[1]))
		resp, body := f.getClient(path, nil)
		if got := len(f.sent(imagePatterns[1])) - before; got != 1 {
			t.Fatalf("%s: that server was asked %d times", c.what, got)
		}
		if c.typ != "" {
			servedAsImage(t, c.what, resp, body, c.typ, c.body)
			continue
		}
		r := decode[obj](t, body)
		if resp.StatusCode != http.StatusBadGateway || r["code"] != "bad_answer" || r["error"] != "Studio gave an answer that cannot be read." || len(r) != 2 {
			t.Errorf("%s: %d %s, want 502 bad_answer", c.what, resp.StatusCode, body)
		}
		if got := resp.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("%s: the refusal is served as %q", c.what, got)
		}
		for h := range hostile {
			if got := resp.Header.Get(h); got != "" {
				t.Errorf("%s: the refusal has %s: %q", c.what, h, got)
			}
		}
	}

	// A refusal of that server is not handed on as it came either: its status, its code and its
	// sentence are written here, and nothing else of its answer.
	for _, c := range []struct {
		what, claims, body string
		status             int
		want               string
	}{
		{"its own refusal", "application/json", `{"error":"no such image","more":"<script>alert(1)</script>"}`, 404, `{"error":"no such image"}`},
		{"a refusal with a code", "application/json", `{"error":"an image is served to the app's own pages only","code":"image_origin","html":"<b>"}`, 403, `{"error":"an image is served to the app's own pages only","code":"image_origin"}`},
		{"a page of HTML for a refusal", "text/html", html, 500, `{"error":"Studio answered with status 500."}`},
		{"an image for a refusal", "image/png", string(png("no")), 404, `{"error":"Studio answered with status 404."}`},
	} {
		f.handle(imagePatterns[1], func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", c.claims)
			w.Header().Set("Set-Cookie", "session=theirs")
			w.WriteHeader(c.status)
			io.WriteString(w, c.body)
		})
		resp, body := f.getClient(path, nil)
		if resp.StatusCode != c.status || resp.Header.Get("Content-Type") != "application/json" || resp.Header.Get("Set-Cookie") != "" {
			t.Errorf("%s: %d as %q: %s", c.what, resp.StatusCode, resp.Header.Get("Content-Type"), body)
		}
		sameJSON(t, c.what, decode[any](t, body), c.want)
	}

	// That the chat is gone there is that server's word, with its code: the page reads it.
	f.answer(imagePatterns[1], 404, obj{"error": chats.ErrNotFound.Error(), "code": "not_found", "more": "<b>"})
	resp, body := f.getClient(path, nil)
	if resp.StatusCode != 404 {
		t.Fatalf("the fetch from a server that has no such chat: %d %s", resp.StatusCode, body)
	}
	sameJSON(t, "the fetch from a server that has no such chat", decode[any](t, body), `{"error":"`+chats.ErrNotFound.Error()+`","code":"not_found"}`)
}

// An upload and an image fetch between servers get a limit of their own, the 60 seconds of a
// board's scene, and not the one of the other calls: an image is megabytes on a slow line.
func TestImageCallsHaveTheirOwnLimit(t *testing.T) {
	t.Parallel()
	if remotes.DefaultLimits.Image != 60*time.Second || remotes.DefaultLimits.Image != remotes.DefaultLimits.Scene || remotes.DefaultLimits.Call != 15*time.Second {
		t.Fatalf("the limits in production: %+v", remotes.DefaultLimits)
	}
	data := png("slow")
	t.Run("longer than a call", func(t *testing.T) {
		t.Parallel()
		// Every other call has 100 ms here. The image calls are answered after four times that.
		const call = 100 * time.Millisecond
		f := newFar(t, farOpt{chats: []model.ChatView{viewThere(farChatA)}, limits: remotes.Limits{Call: call, Start: call, Image: time.Minute}})
		p := f.page("P")
		at := f.on("/chats/" + farChatA)
		f.handle(imagePatterns[0], func(w http.ResponseWriter, r *http.Request) {
			io.Copy(io.Discard, r.Body)
			time.Sleep(4 * call)
			writeJSON(w, model.Image{ID: imageIDOf(data), Name: "slow.png", Type: "image/png", Size: int64(len(data))})
		})
		f.handle(imagePatterns[1], func(w http.ResponseWriter, r *http.Request) {
			time.Sleep(4 * call)
			w.Write(data)
		})
		if status, out := f.uploadAt(p.ID, at, "slow.png", "image/png", bytes.NewReader(data)); status != 200 {
			t.Fatalf("an upload that takes longer than a call: %d %s", status, out)
		}
		resp, body := f.getClient(at+"/images/"+imageIDOf(data), nil)
		servedAsImage(t, "a fetch that takes longer than a call", resp, body, "image/png", data)
		// The other calls kept their limit.
		f.hang("GET /api/chats/{id}/tree")
		f.refuses(p, http.StatusGatewayTimeout, "no_answer", "GET", at+"/tree", "")
	})
	t.Run("ended by the limit", func(t *testing.T) {
		t.Parallel()
		f := newFar(t, farOpt{chats: []model.ChatView{viewThere(farChatA)}, limits: remotes.Limits{Image: 300 * time.Millisecond}})
		p := f.page("P")
		at := f.on("/chats/" + farChatA)
		f.hang(imagePatterns[0])
		f.hang(imagePatterns[1])
		status, out := f.uploadAt(p.ID, at, "slow.png", "image/png", bytes.NewReader(data))
		if r := decode[refusal](t, out); status != http.StatusGatewayTimeout || r.Code != "no_answer" || r.Error != "Studio did not answer." {
			t.Fatalf("an upload that gets no answer: %d %s", status, out)
		}
		resp, body := f.getClient(at+"/images/"+imageIDOf(data), nil)
		if r := decode[refusal](t, body); resp.StatusCode != http.StatusGatewayTimeout || r.Code != "no_answer" {
			t.Fatalf("a fetch that gets no answer: %d %s", resp.StatusCode, body)
		}
		// A call that is no image call has the limit it had: it outlives the image limit.
		f.handle("GET /api/chats/{id}/tree", func(w http.ResponseWriter, r *http.Request) {
			time.Sleep(600 * time.Millisecond)
			ok(w)
		})
		f.good(p, "GET", at+"/tree", "")
	})
}

// Every image call has an answer for a chat whose server is not connected, and for one whose
// server is too old: nothing is sent, the upload's bytes are not read, and the page is told
// which of the two it is. The entry's state decides before anything of the call is looked at.
func TestImageCallsForAServerThatIsAway(t *testing.T) {
	t.Parallel()
	data := png("a")
	img := model.Image{ID: imageIDOf(data), Name: "a.png"}
	for _, c := range []struct {
		name, text string
		away       func(f *far)
	}{
		{"not connected", "Studio is not connected.", func(f *far) { f.down() }},
		{"too old", "Studio is too old: update the server on that machine.", func(f *far) {
			f.st.SetFeatureLevel(standin.Level(servers.MinFeatureLevel - 1))
			f.st.DropStreams()
			f.wait("the entry is too old", func() bool {
				v, _ := f.m.View(f.entry)
				return v.State == servers.StateTooOld
			})
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			f := newFar(t, farOpt{chats: []model.ChatView{viewThere(farChatA)}})
			p := f.page("P")
			client := patient(t)
			c.away(f)
			f.untouched("a server that is away", func() {
				at := f.on("/chats/" + farChatA)
				status, out, read := uploadAsked(t, client, f.url+at+"/images?name=a.png", map[string]string{ClientHeader: p.ID}, data)
				if r := decode[refusal](t, out); status != http.StatusServiceUnavailable || r.Code != "server_unreachable" || r.Error != c.text || read {
					t.Errorf("the upload: %d %s, read %v", status, out, read)
				}
				// The fetch, of an image and of an id that has not the form of one.
				for _, image := range []string{img.ID, "nope"} {
					resp, body := f.getClient(at+"/images/"+image, nil)
					if r := decode[refusal](t, body); resp.StatusCode != http.StatusServiceUnavailable || r.Code != "server_unreachable" || r.Error != c.text {
						t.Errorf("the fetch of the image %s: %d %s", image, resp.StatusCode, body)
					}
				}
				// The draft save and the Send are answered as they are without images, and as
				// they are with an id that has not the form of one.
				for _, imgs := range []string{imagesJSON(img), `[{"id":"nope"}]`} {
					body := `{"text":"look","images":` + imgs + `}`
					for _, call := range [][2]string{{"PUT", at + "/draft?rev=0"}, {"POST", at + "/messages"}} {
						if text := f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", call[0], call[1], body); text != c.text {
							t.Errorf("%s %s with %s: %q", call[0], call[1], imgs, text)
						}
					}
				}
			})
		})
	}
}

// send makes a call of the API client id on the remote listener with a body of the type stated,
// and returns the answer.
func (l *listener) send(c *http.Client, id, secret, method, path, stated string, body io.Reader) (*http.Response, string) {
	l.t.Helper()
	req, err := http.NewRequest(method, l.base+path, body)
	if err != nil {
		l.t.Fatal(err)
	}
	for k, v := range map[string]string{ClientHeader: id, SecretHeader: secret, servers.LevelHeader: testLevel, "Content-Type": stated} {
		if v != "" {
			req.Header.Set(k, v)
		}
	}
	resp, err := c.Do(req)
	if err != nil {
		l.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp, string(out)
}

// The image routes are an API client's too: the server a person reaches a chat of this one
// from uploads to the chat, fetches from it, and names images in a draft save and in a Send. No
// call checks whose chat it is (D13), and the upload is cut at the size limit before it is read
// on this listener as on the other.
func TestImageRoutesOfAnAPIClient(t *testing.T) {
	t.Parallel()
	fake := agenttest.New(model.Claude)
	var mu sync.Mutex
	var got [][]agent.ContentBlock
	fake.Script(func(turn *agenttest.Turn) {
		mu.Lock()
		got = append(got, turn.Raw)
		mu.Unlock()
		turn.Say("seen")
	})
	e, l := remoteEnv(t, func(s *Server) { s.App.Chats.Spawners[model.Claude] = fake })
	t.Cleanup(func() {
		for _, v := range e.s.App.Chats.Views() {
			e.s.App.Chats.Stop(v.ID)
		}
	})
	for _, p := range imagePatterns {
		if !slices.Contains(RemoteRoutes, p) {
			t.Fatalf("the table of the remote listener lacks %q", p)
		}
	}
	// The chat is the owner's: made on this server's own page, by no API client.
	chat := e.chat(`{"agent":"claude","group":"__ungrouped__"}`).ID
	at := "/api/chats/" + chat
	c := l.http
	x, _ := l.api(apiX)

	// X uploads to it, and Y, another client, fetches what X uploaded.
	data := png("from x")
	resp, out := l.send(c, apiX, testSecret, "POST", at+"/images?name=x.png", "image/png", bytes.NewReader(data))
	if resp.StatusCode != 200 {
		t.Fatalf("X's upload: %d %s", resp.StatusCode, out)
	}
	sameJSON(t, "the upload's answer", decode[any](t, out), `{"id":"`+imageIDOf(data)+`","name":"x.png","type":"image/png","size":`+strconv.Itoa(len(data))+`}`)
	img := decode[model.Image](t, out)
	resp, out = l.send(c, apiY, testSecret, "GET", at+"/images/"+img.ID, "", nil)
	servedAsImage(t, "Y's fetch", resp, out, "image/png", data)
	if resp, out = l.send(c, apiY, testSecret, "POST", at+"/images?name=y.png", "image/png", bytes.NewReader(png("from y"))); resp.StatusCode != 200 {
		t.Fatalf("Y's upload: %d %s", resp.StatusCode, out)
	}
	other := decode[model.Image](t, out)
	if held := e.imagesOf(chat); len(held) != 2 {
		t.Fatalf("the chat holds %v", held)
	}

	// The refusals are those of the page's upload, and the size limit cuts the upload before it
	// is read: one that says it is larger is not asked for, and one that does not say is read no
	// further than the limit.
	big := append(png("big"), make([]byte, model.ImageMaxBytes)...)
	hdr := map[string]string{ClientHeader: apiX, SecretHeader: testSecret, servers.LevelHeader: testLevel}
	status, out, read := uploadAsked(t, patient(t), l.base+at+"/images", hdr, big)
	if status != 413 || decode[refusal](t, out).Code != "image_too_large" || read {
		t.Fatalf("an upload over the limit by its length: %d %s, read %v", status, out, read)
	}
	if resp, out = l.send(c, apiX, testSecret, "POST", at+"/images", "image/png", noLength{bytes.NewReader(big)}); resp.StatusCode != 413 || decode[refusal](t, out).Code != "image_too_large" {
		t.Fatalf("an upload over the limit without a length: %d %s", resp.StatusCode, out)
	}
	if resp, out = l.send(c, apiX, testSecret, "POST", at+"/images", "image/svg+xml", strings.NewReader(`<svg xmlns="http://www.w3.org/2000/svg"/>`)); resp.StatusCode != 415 || decode[refusal](t, out).Code != "image_type" {
		t.Fatalf("an SVG: %d %s", resp.StatusCode, out)
	}
	if resp, out = l.send(c, apiX, testSecret, "POST", "/api/chats/"+chat2+"/images", "image/png", bytes.NewReader(data)); resp.StatusCode != 404 {
		t.Fatalf("an upload to no chat: %d %s", resp.StatusCode, out)
	}
	if resp, out = l.send(c, apiX, testSecret, "GET", at+"/images/nope", "", nil); resp.StatusCode != 400 || decode[refusal](t, out).Code != "image_id" {
		t.Fatalf("the fetch of an id of another form: %d %s", resp.StatusCode, out)
	}
	if resp, out = l.send(c, apiX, testSecret, "GET", at+"/images/"+imageIDOf(png("never")), "", nil); resp.StatusCode != 404 || decode[refusal](t, out).Error != chats.ErrNoImage.Error() {
		t.Fatalf("the fetch of an image the chat does not hold: %d %s", resp.StatusCode, out)
	}
	// Without the secret a caller learns nothing, of these routes as of any.
	for _, call := range [][2]string{{"POST", at + "/images"}, {"GET", at + "/images/" + img.ID}} {
		if resp, out = l.send(c, apiX, "", call[0], call[1], "image/png", bytes.NewReader(data)); resp.StatusCode != 401 || strings.Contains(out, "PNG") {
			t.Fatalf("%s %s without the secret: %d %s", call[0], call[1], resp.StatusCode, out)
		}
	}
	if held := e.imagesOf(chat); len(held) != 2 {
		t.Fatalf("the chat holds %v after the refused uploads", held)
	}

	// The draft of the owner's chat with X's and Y's images, saved by X, and the Send by Y.
	saved := string(do(t, x, "PUT", at+"/draft?rev=0", `{"text":"look","images":`+imagesJSON(img, other, model.Image{ID: "bad id"})+`}`))
	sameJSON(t, "the draft save", decode[any](t, saved), `{"ok":true,"rev":1,"missing":["bad id"]}`)
	if v := e.get(at); len(v["draft"].(obj)["images"].([]any)) != 2 {
		t.Fatalf("the draft: %v", v["draft"])
	}
	if resp, out = l.send(c, apiY, testSecret, "POST", at+"/messages", "application/json", strings.NewReader(`{"text":"look","context":"","images":`+imagesJSON(other, img)+`}`)); resp.StatusCode != 200 {
		t.Fatalf("Y's message: %d %s", resp.StatusCode, out)
	}
	e.idle(chat)
	mu.Lock()
	blocks := slices.Clone(got)
	mu.Unlock()
	if len(blocks) != 1 || len(blocks[0]) != 3 || blocks[0][0].Image == nil || !bytes.Equal(blocks[0][0].Image.Data, png("from y")) ||
		blocks[0][1].Image == nil || !bytes.Equal(blocks[0][1].Image.Data, data) || blocks[0][2].Text != "look" {
		t.Fatalf("the agent got %+v", blocks)
	}
	var items []json.RawMessage
	json.Unmarshal(decode[map[string]json.RawMessage](t, string(do(t, x, "GET", at+"/items", nil)))["items"], &items)
	if len(items) == 0 || !strings.Contains(string(items[0]), other.ID) || !strings.Contains(string(items[0]), img.ID) {
		t.Fatalf("the thread: %s", items)
	}
}

// What 3.5, 3.7, 3.8 and 3.9 say of images holds for a chat of a section, through the user's
// own server A: a message of images alone names the chat by the one word, fork and edit
// gives the fork its own images on B with the message as its draft, deleting the source takes
// nothing from the fork, B refuses images for a model that takes none, and deleting a chat
// removes its images on B. A keeps nothing of any of it.
func TestForkModelAndDeleteOfAChatWithImagesOnAnotherServer(t *testing.T) {
	t.Parallel()
	sp := &flowSpawner{} // B's Claude chats are driven here: each turn ends at a point a fork can start at
	pr := newPairWith(t, remotes.Limits{}, nil, []func(*Server){func(s *Server) { s.App.Chats.Spawners[model.Claude] = sp }})
	a, b := pr.a, pr.b
	t.Cleanup(func() {
		for _, v := range b.s.App.Chats.Views() {
			b.s.App.Chats.Stop(v.ID)
		}
	})
	p := a.page("P")
	cv := decode[model.ChatView](t, string(do(t, p, "POST", pr.on("/chats"), obj{"agent": "claude", "group": model.Ungrouped})))
	id, at := cv.ID, pr.on("/chats/"+cv.ID)
	status, out := a.uploadAt(p.ID, at, "one.png", "image/png", bytes.NewReader(png("one")))
	if status != 200 {
		t.Fatalf("the upload: %d %s", status, out)
	}
	one := decode[model.Image](t, out)

	// A message of images alone: B names the chat by the one word, and A's page reads that name
	// and that word in the tree.
	sentOn(t, "a message of images alone", string(do(t, p, "POST", at+"/messages", `{"text":"","context":"","images":`+imagesJSON(one)+`}`)), "main")
	reply(t, sp.last(t), "one", "p1")
	b.idle(id)
	if v := decode[obj](t, string(do(t, p, "GET", at, nil))); v["name"] != model.ImageWord {
		t.Fatalf("the chat as A's page reads it is named %q", v["name"])
	}
	tree := decode[obj](t, string(do(t, p, "GET", at+"/tree", nil)))["branches"].([]any)[0].(obj)["items"].([]any)
	if first := tree[0].(obj); first["kind"] != "user" || first["text"] != model.ImageWord {
		t.Fatalf("the tree names the message %v", first)
	}

	// A second message, with words and two images, and fork and edit of it: the fork is a chat on
	// B, its draft is the message with its images, and B holds the fork's own copies: the copied
	// message's image as one that was sent, the draft's as one that was not.
	status, out = a.uploadAt(p.ID, at, "two.png", "image/png", bytes.NewReader(png("two")))
	if status != 200 {
		t.Fatalf("the second upload: %d %s", status, out)
	}
	two := decode[model.Image](t, out)
	sentOn(t, "a message with words and images", string(do(t, p, "POST", at+"/messages", `{"text":"second","context":"","images":`+imagesJSON(two, one)+`}`)), "main")
	reply(t, sp.last(t), "two", "p2")
	b.idle(id)
	items := decode[obj](t, string(do(t, p, "GET", at+"/items", nil)))["items"].([]any)
	second := -1
	for i, it := range items {
		if it.(obj)["kind"] == "user" && it.(obj)["text"] == "second" {
			second = i
		}
	}
	if second < 1 {
		t.Fatalf("the thread as A's page reads it: %v", items)
	}
	fork := decode[obj](t, string(do(t, p, "POST", at+"/fork", obj{"branch": "main", "at": second, "message": second})))
	forkID, _ := fork["id"].(string)
	if _, err := b.a.Chats.View(forkID); forkID == "" || forkID == id || err != nil {
		t.Fatalf("the fork: %v, on B %v", fork, err)
	}
	held := `[{"id":"` + two.ID + `","name":"two.png","type":"image/png","size":` + strconv.FormatInt(two.Size, 10) + `},` +
		`{"id":"` + one.ID + `","name":"one.png","type":"image/png","size":` + strconv.FormatInt(one.Size, 10) + `}]`
	sameJSON(t, "the fork's draft", fork["draft"], `{"text":"second","images":`+held+`}`)
	sameJSON(t, "the fork's draft on B", b.get("/api/chats/" + forkID)["draft"], `{"text":"second","images":`+held+`}`)
	if got := b.imagesOf(forkID); len(got) != 2 || !slices.Contains(got, one.ID) || !slices.Contains(got, two.ID) {
		t.Fatalf("B holds %v for the fork", got)
	}
	// The fork is named by forkAt on A, in B's section, and by forkThere on B itself.
	forkAt, forkThere := pr.on("/chats/"+forkID), "/api/chats/"+forkID
	resp, body := a.getClient(forkAt+"/images/"+two.ID, nil)
	servedAsImage(t, "the fetch of the fork's image", resp, body, "image/png", png("two"))

	// The source is deleted through A: its images go with it on B, and the fork keeps its own.
	do(t, p, "DELETE", at, nil)
	if _, err := os.Stat(b.st.P.ChatDir(id)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("B still has the folder of the deleted chat: %v", err)
	}
	resp, body = a.getClient(forkAt+"/images/"+one.ID, nil)
	servedAsImage(t, "the fork's image after its source was deleted", resp, body, "image/png", png("one"))

	// B's catalog marks a model as taking no images: on it B refuses the fork's message with its
	// images, in a sentence that names the model, and takes the same message without them.
	cat := &model.Catalog{Models: []model.CatalogModel{{ID: "sees", Label: "Sees"}, {ID: "blind", Label: "Blind One", NoImages: true}},
		Default: model.ModelChoice{Model: "sees"}}
	if err := b.st.Update(func(s *model.State) error { s.SetCatalog(model.Claude, cat); return nil }); err != nil {
		t.Fatal(err)
	}
	do(t, p, "PATCH", forkAt, `{"model":"blind"}`)
	st, raw := p.Do("POST", forkAt+"/messages", `{"text":"see","context":"","images":`+imagesJSON(one)+`}`)
	if r := decode[obj](t, string(raw)); st != 400 || r["code"] != "image_model" || !strings.HasPrefix(r["error"].(string), "Blind One takes no images") {
		t.Fatalf("images for a model that takes none, through A: %d %s", st, raw)
	}
	if after := b.get(forkThere + "/items")["items"].([]any); len(after) != second {
		t.Fatalf("the refused message left %v on B", after)
	}
	sameJSON(t, "the fork's draft on B after the refused message", b.get(forkThere)["draft"], `{"text":"second","images":`+held+`}`)
	sentOn(t, "the message without images", string(do(t, p, "POST", forkAt+"/messages", `{"text":"words only","context":""}`)), "main")
	reply(t, sp.last(t), "three", "p3")
	b.idle(forkID)

	// Deleting the fork removes its images on B. A never had a folder for either chat.
	do(t, p, "DELETE", forkAt, nil)
	if _, err := os.Stat(b.st.P.ChatDir(forkID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("B still has the folder of the deleted fork: %v", err)
	}
	for _, chat := range []string{id, forkID} {
		if _, err := os.Stat(a.st.P.ChatDir(chat)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("A has a folder for the chat %s: %v", chat, err)
		}
	}
}
