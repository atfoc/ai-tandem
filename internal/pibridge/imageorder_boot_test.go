package pibridge

// The order of an attached image and the text in the request the real pi makes for a `prompt`
// with `images`.
//
// No model is called: pi is given one provider, an endpoint of this test on 127.0.0.1 that
// speaks the OpenAI chat API, keeps the request and answers one word. The process gets a HOME
// and an agent folder of its own and an environment built here from nothing but PATH, so it has
// no key of any real provider, and the prompt is written only after pi has said that its model
// is the endpoint's.
//
// Two legs, each its own pi process:
//
//   - without the app's handler (the extension loaded with no bridge, as in standalone use) the
//     request has the text first and the images after it: pi's own order, the one
//     AgentSession.prompt builds;
//   - as an app chat (the bridge variables set) the request has the images first, in the order
//     of the `images` list, and the text after them: the extension's `context` handler
//     (extension/image-order.ts).

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// modelStub is the endpoint pi is given as its one provider. It keeps the body of every chat
// request and answers each with one word, as a stream.
type modelStub struct {
	server   *httptest.Server
	requests chan []byte
}

func newModelStub(t *testing.T) *modelStub {
	t.Helper()
	s := &modelStub{requests: make(chan []byte, 16)}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !strings.HasSuffix(r.URL.Path, "/chat/completions") {
			http.NotFound(w, r)
			return
		}
		select {
		case s.requests <- body:
		default:
		}
		w.Header().Set("content-type", "text/event-stream")
		chunk := func(delta map[string]any, finish any) {
			b, _ := json.Marshal(map[string]any{"id": "stub-1", "object": "chat.completion.chunk", "created": 1, "model": "vision",
				"choices": []map[string]any{{"index": 0, "delta": delta, "finish_reason": finish}}})
			fmt.Fprintf(w, "data: %s\n\n", b)
		}
		chunk(map[string]any{"role": "assistant", "content": "seen"}, nil)
		chunk(map[string]any{}, "stop")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(s.server.Close)
	return s
}

// onePixelPNG is a real PNG of one pixel of the given grey: pi decodes what it is sent.
func onePixelPNG(t *testing.T, grey uint8) []byte {
	t.Helper()
	img := image.NewGray(image.Rect(0, 0, 1, 1))
	img.SetGray(0, 0, color.Gray{Y: grey})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// startStubModelPi starts the real pi in RPC mode with the materialized extension and the stub
// as its only provider and model. Nothing of this process's environment reaches it but PATH.
func startStubModelPi(t *testing.T, pi, index string, stub *modelStub, extraEnv ...string) *piBootRun {
	t.Helper()
	homeDir, agentDir, workDir := t.TempDir(), t.TempDir(), t.TempDir()
	models, err := json.Marshal(map[string]any{"providers": map[string]any{"stub": map[string]any{
		"baseUrl": stub.server.URL + "/v1", "api": "openai-completions", "apiKey": "no-key",
		"models": []map[string]any{{"id": "vision", "input": []string{"text", "image"}}},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(agentDir, "models.json"), models, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(pi, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
		"--no-themes", "--no-context-files", "--model", "stub/vision", "-e", index)
	cmd.Dir = workDir
	cmd.Env = append([]string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + homeDir,
		"TMPDIR=" + t.TempDir(),
		"PI_CODING_AGENT_DIR=" + agentDir,
		"PI_OFFLINE=1",
		"PI_SKIP_VERSION_CHECK=1",
	}, extraEnv...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, stderr := &bootBuffer{}, &bootBuffer{}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if err := cmd.Start(); err != nil {
		t.Skipf("pi failed to start (%v)", err)
	}
	run := &piBootRun{cmd: cmd, stdin: stdin, stdout: stdout, stderr: stderr, done: make(chan error, 1)}
	go func() { run.done <- cmd.Wait() }()
	t.Cleanup(run.stop)
	return run
}

// response waits for pi's response to the command with the given id and returns it.
func (r *piBootRun) response(t *testing.T, id string, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, line := range strings.Split(r.stdout.String(), "\n") {
			var m map[string]any
			if json.Unmarshal([]byte(line), &m) == nil && m["type"] == "response" && m["id"] == id {
				return m
			}
		}
		select {
		case werr := <-r.done:
			t.Fatalf("pi exited before it answered %s (%v)\nstdout:\n%s\nstderr:\n%s", id, werr, r.stdout.String(), r.stderr.String())
		case <-time.After(50 * time.Millisecond):
		}
	}
	t.Fatalf("pi did not answer %s within %s\nstdout:\n%s\nstderr:\n%s", id, timeout, r.stdout.String(), r.stderr.String())
	return nil
}

// userParts sends a prompt with two images to a pi whose model is the stub and returns the
// parts of the user message in the request pi made for it: "image" or "text" for each, the
// images' data in their order, and the text.
func userParts(t *testing.T, run *piBootRun, stub *modelStub, message string, pngs [][]byte) (kinds []string, images []string, text string) {
	t.Helper()
	if _, err := io.WriteString(run.stdin, `{"id":"state-1","type":"get_state"}`+"\n"); err != nil {
		t.Fatal(err)
	}
	// The prompt is written only to a pi whose model is the stub: nothing else is ever asked.
	state := run.response(t, "state-1", 90*time.Second)
	data, _ := state["data"].(map[string]any)
	model, _ := data["model"].(map[string]any)
	if model["provider"] != "stub" || model["id"] != "vision" {
		t.Skipf("pi did not take the stub as its model (%v): no prompt is sent\nstderr:\n%s", data["model"], run.stderr.String())
	}
	var list []map[string]any
	for _, b := range pngs {
		list = append(list, map[string]any{"type": "image", "mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(b)})
	}
	prompt, err := json.Marshal(map[string]any{"id": "prompt-1", "type": "prompt", "message": message, "images": list})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.stdin.Write(append(prompt, '\n')); err != nil {
		t.Fatal(err)
	}
	if resp := run.response(t, "prompt-1", 60*time.Second); resp["success"] != true {
		t.Fatalf("pi refused the prompt: %v\nstderr:\n%s", resp, run.stderr.String())
	}
	var body []byte
	select {
	case body = <-stub.requests:
	case <-time.After(60 * time.Second):
		t.Fatalf("pi made no request for the prompt\nstdout:\n%s\nstderr:\n%s", run.stdout.String(), run.stderr.String())
	}
	var req struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatalf("the request is not JSON: %v\n%s", err, body)
	}
	var parts []struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		ImageURL struct {
			URL string `json:"url"`
		} `json:"image_url"`
	}
	found := false
	for _, m := range req.Messages {
		if m.Role != "user" {
			continue
		}
		if found {
			t.Fatalf("the request has two user messages:\n%s", body)
		}
		found = true
		if err := json.Unmarshal(m.Content, &parts); err != nil {
			t.Fatalf("the user message has no list of parts: %v\n%s", err, m.Content)
		}
	}
	if !found {
		t.Fatalf("the request has no user message:\n%s", body)
	}
	for _, p := range parts {
		switch p.Type {
		case "text":
			kinds, text = append(kinds, "text"), text+p.Text
		case "image_url":
			kinds, images = append(kinds, "image"), append(images, p.ImageURL.URL)
		default:
			t.Fatalf("a part of type %q in the user message: %s", p.Type, body)
		}
	}
	return kinds, images, text
}

func TestRealPiImageBeforeText(t *testing.T) {
	pi, probePath := bootProbeSetup(t)
	index := filepath.Join(filepath.Dir(probePath), "index.ts")
	const message = "<ui-context>x</ui-context>\n\nwhat is on these?"
	first, second := onePixelPNG(t, 10), onePixelPNG(t, 200)
	// The images reach the model in the order of the list. pi may encode an image again, so
	// the two are told apart only where it handed them on as they came.
	inOrder := func(t *testing.T, images []string) {
		t.Helper()
		if len(images) != 2 {
			t.Fatalf("%d images in the request, want 2", len(images))
		}
		a := "data:image/png;base64," + base64.StdEncoding.EncodeToString(first)
		b := "data:image/png;base64," + base64.StdEncoding.EncodeToString(second)
		if (images[0] == a || images[0] == b) && (images[1] == a || images[1] == b) && (images[0] != a || images[1] != b) {
			t.Errorf("the images changed places")
		}
	}

	t.Run("pi alone puts the text first", func(t *testing.T) {
		t.Parallel()
		stub := newModelStub(t)
		run := startStubModelPi(t, pi, index, stub)
		kinds, images, text := userParts(t, run, stub, message, [][]byte{first, second})
		if got := strings.Join(kinds, " "); got != "text image image" {
			t.Errorf("pi's own order of the user message is %q, want the text and then the images: if pi changed it, the extension's handler may no longer be needed", got)
		}
		if text != message {
			t.Errorf("text %q", text)
		}
		inOrder(t, images)
	})

	t.Run("an app chat gets the images first", func(t *testing.T) {
		t.Parallel()
		stub := newModelStub(t)
		// The bridge is a socket nobody listens on: the extension uses it for the permission
		// gate and the control channel, and this turn calls no tool.
		run := startStubModelPi(t, pi, index, stub,
			"AIWB_BRIDGE_SOCKET="+filepath.Join(t.TempDir(), "missing.sock"), "AIWB_BRIDGE_RUN=run-order-1")
		kinds, images, text := userParts(t, run, stub, message, [][]byte{first, second})
		if got := strings.Join(kinds, " "); got != "image image text" {
			t.Errorf("the user message of an app chat is %q, want the images and then the text", got)
		}
		if text != message {
			t.Errorf("text %q", text)
		}
		inOrder(t, images)
	})
}
