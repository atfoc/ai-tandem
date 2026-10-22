//go:build !windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/server"
)

// The cleanup of the images of chats, in real server processes: an image that was never sent and
// that no draft names goes by itself once the wait is over, with no upload and no draft save
// after it, and also when the server was killed and started again in between.

// imageServer is one server process of an instance, started with `serve`.
type imageServer struct {
	in     *instance
	cmd    *exec.Cmd
	exited chan struct{}
	out    bytes.Buffer
}

func (s *imageServer) start(t *testing.T) {
	t.Helper()
	cmd := s.in.command(context.Background(), "serve", "-cwd", t.TempDir(), "-cursor-cost", "/nonexistent/cursor-cost")
	cmd.Stdout, cmd.Stderr = &s.out, &s.out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	s.cmd, s.exited = cmd, make(chan struct{})
	go func(done chan struct{}) { cmd.Wait(); close(done) }(s.exited)
	for deadline := time.Now().Add(60 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if run, ok := s.in.running(); ok && run.hello.Pid == cmd.Process.Pid {
			if st, ok := run.statusOf(); ok && st.Client.Listening {
				return
			}
		}
		select {
		case <-s.exited:
			t.Fatalf("the server exited while it started:\n%s", s.out.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("the server did not answer within 60 s:\n%s", s.out.String())
		}
	}
}

// kill ends the server the way a crash does and waits until the process is gone.
func (s *imageServer) kill(t *testing.T) {
	t.Helper()
	s.cmd.Process.Kill()
	select {
	case <-s.exited:
	case <-time.After(30 * time.Second):
		t.Fatal("the server did not exit within 30 s of SIGKILL")
	}
}

// testPNG is a small file that starts as a PNG does and differs by seed.
func testPNG(seed string) []byte { return append([]byte("\x89PNG\r\n\x1a\n"), seed...) }

// uploadImage uploads testPNG(seed) to the chat as a client does and returns the image's id.
func uploadImage(t *testing.T, in *instance, client, chat, seed string) string {
	t.Helper()
	req, _ := http.NewRequest("POST", in.base()+"/api/chats/"+chat+"/images?name="+url.QueryEscape(seed+".png"), bytes.NewReader(testPNG(seed)))
	req.Header.Set("Content-Type", "image/png")
	req.Header.Set(server.SecretHeader, in.secret)
	req.Header.Set(server.ClientHeader, client)
	req.Header.Set(server.LevelHeader, testLevel)
	tr := pinned(in.fpr)
	defer tr.CloseIdleConnections()
	resp, err := (&http.Client{Transport: tr, Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var img struct{ ID string }
	if err := json.NewDecoder(resp.Body).Decode(&img); err != nil || resp.StatusCode != http.StatusOK || img.ID == "" {
		t.Fatalf("the upload of %s: status %d, %v", seed, resp.StatusCode, err)
	}
	return img.ID
}

// imageStatus is the status of a fetch of the image, which is no use of it.
func imageStatus(t *testing.T, in *instance, chat, image string) int {
	t.Helper()
	status, _, err := in.request(context.Background(), testClient, "GET", "/api/chats/"+chat+"/images/"+image, nil)
	if err != nil {
		t.Fatal(err)
	}
	return status
}

func TestImagesCleanedByThemselves(t *testing.T) {
	serverTest(t, "TestCleanImagesByItself, TestCleanImagesAfterRestart, TestCleanImagesRuns (internal/chats)")
	if realWaits() {
		t.Skip("the hour an unused image is kept is not waited out")
	}
	imagesWait := hourly.of(chats.DefaultImageWait) // the hour, as these servers have it
	in := newInstance(t)
	in.setenv(hourly.env(t, "images"))
	srv := &imageServer{in: in}
	srv.start(t)
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("the server's output:\n%s", srv.out.String())
		}
	})

	const client = testClient
	in.activate(t, client)
	var chat struct{ ID string }
	in.must(t, client, "POST", "/api/chats", map[string]any{"group": "__ungrouped__"}, &chat)
	file := func(image string) string { return filepath.Join(in.dir, "chats", chat.ID, "images", image) }
	// goes waits until a fetch of the image is answered 404 and its file is gone, and returns
	// how long that took. Nothing is uploaded and no draft is saved meanwhile.
	goes := func(what, image string, from time.Time) time.Duration {
		t.Helper()
		for deadline := time.Now().Add(60 * time.Second); ; time.Sleep(50 * time.Millisecond) {
			if imageStatus(t, in, chat.ID, image) == http.StatusNotFound {
				if _, err := os.Stat(file(image)); !os.IsNotExist(err) {
					t.Fatalf("%s: its fetch is answered 404 and its file is there: %v", what, err)
				}
				return time.Since(from)
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s was not deleted within 60 s, with a wait of %s", what, imagesWait)
			}
		}
	}

	// An image no draft names, and one a draft names.
	uploaded := time.Now()
	orphan := uploadImage(t, in, client, chat.ID, "orphan")
	drafted := uploadImage(t, in, client, chat.ID, "drafted")
	in.must(t, client, "PUT", "/api/chats/"+chat.ID+"/draft?rev=0", map[string]any{"text": "look", "images": []map[string]any{{"id": drafted, "name": "drafted.png"}}}, nil)
	if st := imageStatus(t, in, chat.ID, orphan); st != http.StatusOK && time.Since(uploaded) < imagesWait {
		t.Fatalf("the image was gone within the wait: status %d", st)
	}
	if took := goes("the image no draft names", orphan, uploaded); took < imagesWait {
		t.Fatalf("the image went %s after its upload, before the wait of %s was over", took, imagesWait)
	}
	if st := imageStatus(t, in, chat.ID, drafted); st != http.StatusOK {
		t.Fatalf("the image the draft names after the cleanup: status %d", st)
	}

	// Across a restart: an image is uploaded and the server is killed at once, so the image is
	// there when the next server starts, which then takes it by itself. An attempt counts only
	// when the file was seen after the kill: on a machine so slow that the first server took the
	// image before it died, another image is tried.
	for attempt := 1; ; attempt++ {
		uploaded = time.Now()
		left := uploadImage(t, in, client, chat.ID, fmt.Sprintf("left behind %d", attempt))
		srv.kill(t)
		_, err := os.Stat(file(left))
		srv = &imageServer{in: in}
		srv.start(t)
		if err != nil {
			if attempt == 5 {
				t.Fatalf("five times the image was gone before the server was killed: %v", err)
			}
			in.activate(t, client)
			continue
		}
		if took := goes("the image a killed server left", left, uploaded); took < imagesWait {
			t.Fatalf("the image went %s after its upload, before the wait of %s was over", took, imagesWait)
		}
		break
	}
	// The draft outlived the restart, and so did its image: the new server knew the draft before
	// its cleanup looked.
	if st := imageStatus(t, in, chat.ID, drafted); st != http.StatusOK {
		t.Fatalf("the image the draft names after a restart and its cleanup: status %d", st)
	}
	if _, err := os.Stat(file(drafted)); err != nil {
		t.Fatalf("the file of the image the draft names: %v", err)
	}
}
