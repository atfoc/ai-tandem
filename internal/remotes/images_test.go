package remotes

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
)

// TestImageCalls: the two image calls of a chat of a section. The upload goes to the chat's
// server as it came, bytes and stated type, and is answered as that server answers. Of a
// fetch's answer the bytes alone are taken, under the type they are, and the image id is
// checked before anything is sent. A server that is not connected is asked nothing.
func TestImageCalls(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotOf(fullTree())})
	ctx := context.Background()
	up, get := rg.script("POST /api/chats/{id}/images"), rg.script("GET /api/chats/{id}/images/{image}")
	id := strings.Repeat("ab", 32)
	png := []byte("\x89PNG\r\n\x1a\n\x00\xff not text")

	// The upload: what the server gets, and that its answer is handed on with its status.
	var mu sync.Mutex
	var stated []string
	answer := func(status int, body string) {
		up.set(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			stated = append(stated, r.Header.Get("Content-Type"))
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
		})
	}
	as := func(i int) string {
		mu.Lock()
		defer mu.Unlock()
		return stated[i]
	}
	const image = `{"id":"an id","name":"a b.png","type":"image/png","size":20}`
	answer(http.StatusOK, image)
	if e := rg.r.Ready(rg.entry); e != nil {
		t.Fatalf("an upload to a chat whose server is connected: %v", e)
	}
	if rep := rg.r.UploadImage(ctx, rg.entry, chatA, "a b.png", "image/png", png); rep.Status != http.StatusOK || string(rep.Body) != image {
		t.Fatalf("the upload: %d %s", rep.Status, rep.Body)
	}
	if g := up.last(t); g.Method != "POST" || g.URI != "/api/chats/"+chatA+"/images?name=a+b.png" || g.Body != string(png) || as(0) != "image/png" {
		t.Fatalf("the upload the server got: %+v as %q", g, as(0))
	}
	if rep := rg.r.UploadImage(ctx, rg.entry, chatA, "", "", nil); rep.Status != http.StatusOK {
		t.Fatalf("an upload of nothing: %d %s", rep.Status, rep.Body)
	}
	if g := up.last(t); g.URI != "/api/chats/"+chatA+"/images" || g.Body != "" || as(1) != "" {
		t.Fatalf("the upload of nothing the server got: %+v as %q", g, as(1))
	}
	for _, refusal := range []struct {
		status int
		body   string
	}{
		{http.StatusUnsupportedMediaType, `{"error":"the image is of a type a chat does not take","code":"image_type"}`},
		{http.StatusNotFound, `{"error":"no such chat","code":"not_found"}`},
	} {
		answer(refusal.status, refusal.body)
		if rep := rg.r.UploadImage(ctx, rg.entry, chatA, "x", "image/png", png); rep.Status != refusal.status || string(rep.Body) != refusal.body {
			t.Fatalf("an upload that server refuses: %d %s", rep.Status, rep.Body)
		}
	}
	n := up.count()
	for _, entry := range []string{"s_000000000000", servers.LocalID} {
		wantReply(t, "an upload to no entry", rg.r.UploadImage(ctx, entry, chatA, "x", "image/png", png), http.StatusNotFound, map[string]any{"code": "no_server"})
		if e := rg.r.Ready(entry); e == nil || e.Status != http.StatusNotFound || e.Code != "no_server" {
			t.Fatalf("whether no entry takes an upload: %v", e)
		}
		if _, e := rg.r.Image(ctx, entry, chatA, id); e == nil || e.Status != http.StatusNotFound || e.Code != "no_server" {
			t.Errorf("the fetch of an image of no entry: %v", e)
		}
	}
	if up.count() != n {
		t.Fatal("an upload to no entry reached a server")
	}

	// The fetch: the id is checked before anything is sent.
	for _, bad := range []string{"", "nope", strings.ToUpper(id), id + "0", "../../state"} {
		if _, e := rg.r.Image(ctx, rg.entry, chatA, bad); e == nil || e.Status != http.StatusBadRequest || e.Code != "image_id" || !errors.Is(e, ErrImageID) {
			t.Errorf("the fetch of the id %q: %v", bad, e)
		}
	}
	if n := len(get.calls()); n != 0 {
		t.Fatalf("the server was asked %d times for ids of another form", n)
	}
	serve := func(status int, claims string, body []byte) {
		get.set(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", claims)
			w.WriteHeader(status)
			_, _ = w.Write(body)
		})
	}
	// The type is what the bytes are, whatever the answer claims.
	serve(http.StatusOK, "text/html", png)
	pic, e := rg.r.Image(ctx, rg.entry, chatA, id)
	if e != nil || pic.Type != "image/png" || string(pic.Data) != string(png) {
		t.Fatalf("a PNG that claims to be HTML: %+v, %v", pic.Type, e)
	}
	if g := get.last(t); g.Method != "GET" || g.URI != "/api/chats/"+chatA+"/images/"+id {
		t.Fatalf("the fetch the server got: %+v", g)
	}
	for typ, body := range map[string]string{
		"image/png": "\x89PNG\r\n\x1a\nrest", "image/jpeg": "\xff\xd8\xffrest", "image/gif": "GIF89arest", "image/webp": "RIFF\x00\x00\x00\x00WEBPrest",
	} {
		serve(http.StatusOK, "application/octet-stream", []byte(body))
		if pic, e := rg.r.Image(ctx, rg.entry, chatA, id); e != nil || pic.Type != typ {
			t.Errorf("the type of %q: %q, %v", body, pic.Type, e)
		}
	}
	if len(model.ImageTypes) != 4 {
		t.Errorf("a chat takes %v: the relay tells four types", model.ImageTypes)
	}
	for what, body := range map[string][]byte{
		"HTML":                 []byte("<!doctype html><script>alert(1)</script>"),
		"an SVG":               []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`),
		"nothing":              nil,
		"a PNG over the limit": append(png, make([]byte, model.ImageMaxBytes)...),
	} {
		serve(http.StatusOK, "image/png", body)
		if pic, e := rg.r.Image(ctx, rg.entry, chatA, id); e == nil || e.Status != http.StatusBadGateway || e.Code != "bad_answer" || pic.Data != nil || pic.Type != "" {
			t.Errorf("%s that claims to be a PNG: %q with %d bytes, %v", what, pic.Type, len(pic.Data), e)
		}
	}
	serve(http.StatusPartialContent, "image/png", png)
	if _, e := rg.r.Image(ctx, rg.entry, chatA, id); e == nil || e.Code != "bad_answer" {
		t.Errorf("a PNG in an answer that is no 200: %v", e)
	}
	// A refusal is this server's own error with that server's status, code and sentence.
	serve(http.StatusNotFound, "application/json", []byte(`{"error":"no such image","more":"<b>"}`))
	if _, e := rg.r.Image(ctx, rg.entry, chatA, id); e == nil || e.Status != http.StatusNotFound || e.Text != "no such image" || string(e.Reply().Body) != `{"error":"no such image"}` {
		t.Errorf("that server's refusal: %v", e)
	}
	serve(http.StatusNotFound, "application/json", []byte(`{"error":"no such chat","code":"not_found"}`))
	if _, e := rg.r.Image(ctx, rg.entry, chatB, id); e == nil || e.Status != http.StatusNotFound || e.Code != "not_found" {
		t.Errorf("the fetch of an image of a chat that is gone there: %v", e)
	}
	// The secret is the entry's matter.
	serve(http.StatusUnauthorized, "application/json", []byte(`{"error":"unauthorized"}`))
	if _, e := rg.r.Image(ctx, rg.entry, chatA, id); e == nil || e.Status != http.StatusServiceUnavailable || e.Code != "server_unreachable" {
		t.Errorf("a fetch that is answered 401: %v", e)
	}
	noSecret(t, "the log", strings.Join(rg.logs.all(), "\n"))

	// Not connected: nothing is sent.
	rg.away()
	asked := len(up.calls()) + len(get.calls())
	if e := rg.r.Ready(rg.entry); e == nil || e.Status != http.StatusServiceUnavailable || e.Code != "server_unreachable" || !errors.Is(e, ErrUnreachable) {
		t.Errorf("whether a chat whose server is away takes an upload: %v", e)
	}
	if rep := rg.r.UploadImage(ctx, rg.entry, chatA, "x", "image/png", png); rep.Status != http.StatusServiceUnavailable {
		t.Errorf("an upload to a server that is away: %d %s", rep.Status, rep.Body)
	}
	if _, e := rg.r.Image(ctx, rg.entry, chatA, id); e == nil || !errors.Is(e, ErrUnreachable) {
		t.Errorf("a fetch from a server that is away: %v", e)
	}
	if got := len(up.calls()) + len(get.calls()); got != asked {
		t.Errorf("the server that is away was asked %d times", got-asked)
	}
}

// TestImageOfAServerThatIsTooOld: an image call for a server that is too old says so.
func TestImageOfAServerThatIsTooOld(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{hold: true, level: standin.Level(servers.MinFeatureLevel - 1)})
	rg.m.Start()
	rg.state(servers.StateTooOld)
	if e := rg.r.Ready(rg.entry); e == nil || e.Status != http.StatusServiceUnavailable || e.Text != "Studio is too old: update the server on that machine." {
		t.Errorf("whether a server that is too old takes an upload: %v", e)
	}
}
