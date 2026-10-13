package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers/linksim"
)

// imageCall makes a call of the page on A whose body, when there is one, is the bytes of an
// upload stated as a PNG, and returns the answer with its body.
func (rp *remotePair) imageCall(t *testing.T, method, path string, body []byte) (*http.Response, []byte) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, _ := http.NewRequest(method, rp.a.in.url+strings.TrimPrefix(path, "/"), rd)
	req.Header.Set("X-AIWB-Client", pairPage)
	if body != nil {
		req.Header.Set("Content-Type", "image/png")
	}
	// Longer than the production limit of an image call, which a run with the real waits sits out.
	resp, err := (&http.Client{Timeout: 2 * remotes.DefaultLimits.Image}).Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp, raw
}

// The images of a chat of a section, between two server processes: an upload through A is an
// image of B's store, B's refusal is the page's, the fetch through A gives the bytes under A's
// own headers, a draft saved through A holds the image on B, and an upload B does not answer is
// ended by the limit of an image call, which is not the limit of the other calls. No file of A
// holds the image, its name or the draft.
func TestRemoteChatImages(t *testing.T) {
	serverTest(t, "TestImageCallsOfASectionArePassedOn, TestImageCallsHaveTheirOwnLimit, TestImageRoutesOfAnAPIClient (internal/server)", "TestImageCalls (internal/remotes)")
	rp := connectedPair(t, linksim.Good, fast.env(t, "imagecall"))
	chat := rp.newChat(t, rp.group(t, "Work"))
	at := rp.on("/chats/" + chat) // the chat through A
	there := "/api/chats/" + chat // and on B
	png := func(seed string) []byte { return append([]byte("\x89PNG\r\n\x1a\n"), seed...) }
	data := png("a screenshot")
	sum := sha256.Sum256(data)
	id := hex.EncodeToString(sum[:])

	resp, raw := rp.imageCall(t, "POST", at+"/images?name=shot.png", data)
	var img model.Image
	if resp.StatusCode != http.StatusOK || json.Unmarshal(raw, &img) != nil || img != (model.Image{ID: id, Name: "shot.png", Type: "image/png", Size: int64(len(data))}) {
		t.Fatalf("the upload through A: %d %s", resp.StatusCode, raw)
	}
	// It is B's: B's own API client fetches it, from B.
	if status, own := rp.b.api(t, pairDirect, "GET", there+"/images/"+id, nil, nil); status != http.StatusOK || own != string(data) {
		t.Fatalf("the image at B: %d with %d bytes", status, len(own))
	}
	resp, raw = rp.imageCall(t, "GET", at+"/images/"+id, nil)
	if resp.StatusCode != http.StatusOK || !bytes.Equal(raw, data) || resp.Header.Get("Content-Type") != "image/png" ||
		resp.Header.Get("X-Content-Type-Options") != "nosniff" || resp.Header.Get("Cross-Origin-Resource-Policy") != "same-origin" {
		t.Fatalf("the fetch through A: %d with %d bytes and %v", resp.StatusCode, len(raw), resp.Header)
	}
	// B's refusal of an upload is the page's.
	var said struct{ Error, Code string }
	resp, raw = rp.imageCall(t, "POST", at+"/images?name=x.png", []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`))
	if json.Unmarshal(raw, &said); resp.StatusCode != http.StatusUnsupportedMediaType || said.Code != "image_type" {
		t.Fatalf("an SVG uploaded as a PNG through A: %d %s", resp.StatusCode, raw)
	}
	// The draft with the image is B's.
	rp.ok(t, "PUT", at+"/draft?rev=0", map[string]any{"text": "look", "images": []model.Image{{ID: id, Name: "shot.png"}}})
	if own, _ := rp.ownView(t, chat); own.Draft == nil || own.Draft.Text != "look" || len(own.Draft.Images) != 1 || own.Draft.Images[0] != img {
		t.Fatalf("the draft at B: %+v", own.Draft)
	}
	// The route of this computer's chats knows no such chat: the image is reached in the section.
	if resp, raw := rp.imageCall(t, "GET", there+"/images/"+id, nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("the fetch on the route of this computer's chats: %d %s", resp.StatusCode, raw)
	}
	if held := holders(folderFiles(t, rp.a.home), []string{chat, id, "a screenshot", "shot.png"}); len(held) != 0 {
		t.Fatalf("files of A's data folder that hold something of the chat on %s: %v", pairName, held)
	}

	// Nothing travels to B, while B's pings still reach A: the entry stays connected and the
	// upload waits for its answer until the limit of an image call ends it. That limit is a
	// minute, on this test's clock a tenth of it: longer than the 15 s of the other calls on the
	// real clock, and shorter on this one.
	limit := fast.of(remotes.DefaultLimits.Image)
	rp.link.Stall(false, true)
	start := time.Now()
	resp, raw = rp.imageCall(t, "POST", at+"/images?name=late.png", png("late"))
	took := time.Since(start)
	rp.link.Stall(false, false)
	if json.Unmarshal(raw, &said); resp.StatusCode != http.StatusGatewayTimeout || said.Code != "no_answer" {
		t.Fatalf("an upload B does not answer: %d %s", resp.StatusCode, raw)
	}
	if took < limit-time.Second || took > limit+8*time.Second {
		t.Fatalf("the upload was ended after %v, want the %v of an image call", took, limit)
	}
	// The link is as it was: the next upload is B's again.
	if resp, raw = rp.imageCall(t, "POST", at+"/images?name=next.png", png("next")); resp.StatusCode != http.StatusOK {
		t.Fatalf("an upload after the stall: %d %s", resp.StatusCode, raw)
	}
}
