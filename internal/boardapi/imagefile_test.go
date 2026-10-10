package boardapi

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// kindToken makes a chat of kind on the env's board (with a fake spawner for the kind) and
// returns its token.
func (e *env) kindToken(kind model.AgentKind) string {
	e.t.Helper()
	if e.relay.Chats.Spawners[kind] == nil {
		e.relay.Chats.Spawners[kind] = &fakeSpawner{}
	}
	v, err := e.relay.Chats.Create(kind, "", e.board.ID)
	if err != nil {
		e.t.Fatal(err)
	}
	return e.chatToken(v.ID)
}

// pathOf returns the file path the text of a Cursor result names, after the "Image file: " mark.
func pathOf(t *testing.T, text string) string {
	t.Helper()
	const mark = " Image file: "
	const tail = " (PNG). Open it with your file tools."
	i := strings.Index(text, mark)
	if i < 0 || !strings.HasSuffix(text, tail) {
		t.Fatalf("text %q has no image file sentence", text)
	}
	return text[i+len(mark) : len(text)-len(tail)]
}

// For a Cursor chat, tools/call get_image over HTTP returns one text part: the page's text and
// the path of a file that holds the image's bytes; there is no image part.
func TestGetImageCursorGetsAFile(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.relay.ImageDir = filepath.Join(t.TempDir(), "imgs")
	data := pngB64(3000)
	res, _ := e.imageCall(e.kindToken(model.Cursor), "get_image", `{"scope":"all"}`, imageReply("image/png", data), "")
	got := parts(t, res)
	if _, has := res["isError"]; has || len(got) != 1 || got[0]["type"] != "text" {
		t.Fatalf("isError %v content %v", res["isError"], got)
	}
	text := got[0]["text"].(string)
	if !strings.HasPrefix(text, "bounds x=0 y=0 w=10 h=10 (board coordinates), 1 elements Image file: ") {
		t.Fatalf("text %q", text)
	}
	path := pathOf(t, text)
	if !filepath.IsAbs(path) || filepath.Dir(path) != e.relay.ImageDir || filepath.Ext(path) != ".png" {
		t.Fatalf("path %q", path)
	}
	want, _ := base64.StdEncoding.DecodeString(data)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(b, want) || !bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatalf("file has %d bytes, want %d of a PNG", len(b), len(want))
	}
}

// Claude and pi chats still get the text part and the image part, and no file is written.
func TestGetImageClaudeAndPiKeepTheImagePart(t *testing.T) {
	t.Parallel()
	for _, kind := range []model.AgentKind{model.Claude, model.Pi} {
		t.Run(string(kind), func(t *testing.T) {
			e := newEnv(t)
			e.relay.ImageDir = filepath.Join(t.TempDir(), "imgs")
			data := pngB64(100)
			res, _ := e.imageCall(e.kindToken(kind), "get_image", `{}`, imageReply("image/png", data), "")
			got := parts(t, res)
			if len(got) != 2 || got[1]["type"] != "image" || got[1]["data"] != data || strings.Contains(got[0]["text"].(string), "Image file") {
				t.Fatalf("content %v", got)
			}
			if _, err := os.Stat(e.relay.ImageDir); !os.IsNotExist(err) {
				t.Fatalf("image dir exists: %v", err)
			}
		})
	}
}

// Errors and text-only results of a Cursor chat are untouched, and write no file.
func TestGetImageCursorErrorAndTextUntouched(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name    string
		reply   any
		errText string
		text    string
		isErr   bool
	}{
		{"error", nil, "EMPTY: nothing to draw", "EMPTY: nothing to draw", true},
		{"string", "just text", "", "just text", false},
		{"object without image", map[string]any{"text": "only text"}, "", "only text", false},
		{"bad image", imageReply("image/gif", pngB64(4)), "", "get_image: the page sent an image of an unsupported type", true},
	} {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t)
			e.relay.ImageDir = filepath.Join(t.TempDir(), "imgs")
			res, _ := e.imageCall(e.kindToken(model.Cursor), "get_image", `{}`, c.reply, c.errText)
			got := parts(t, res)
			if len(got) != 1 || got[0]["text"] != c.text {
				t.Fatalf("content %v, want %q", got, c.text)
			}
			if isErr, _ := res["isError"].(bool); isErr != c.isErr {
				t.Fatalf("isError %v", res["isError"])
			}
			if _, err := os.Stat(e.relay.ImageDir); !os.IsNotExist(err) {
				t.Fatalf("image dir exists: %v", err)
			}
		})
	}
}

// The directory is 0700 and the files 0600; a file older than the age goes at the next write,
// a newer one and a file that is not ours stay.
func TestImageFilesModeAndSweep(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	dir := filepath.Join(t.TempDir(), "imgs")
	e.relay.ImageDir, e.relay.ImageMaxAge = dir, time.Minute
	tok := e.kindToken(model.Cursor)
	call := func() string {
		res, _ := e.imageCall(tok, "get_image", `{}`, imageReply("image/png", pngB64(20)), "")
		return pathOf(t, parts(t, res)[0]["text"].(string))
	}
	oldP, newP := call(), call()
	other := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(other, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-2 * time.Minute)
	for _, p := range []string{oldP, other} {
		if err := os.Chtimes(p, past, past); err != nil {
			t.Fatal(err)
		}
	}
	third := call()
	for p, want := range map[string]bool{oldP: false, newP: true, third: true, other: true} {
		if _, err := os.Stat(p); (err == nil) != want {
			t.Fatalf("%s exists %v, want %v (%v)", filepath.Base(p), err == nil, want, err)
		}
	}
	if runtime.GOOS == "windows" {
		return
	}
	if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("dir %v %v", fi, err)
	}
	if fi, err := os.Stat(third); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("file %v %v", fi, err)
	}
}

// An existing directory with looser rights is made 0700.
func TestImageDirTightened(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no unix modes")
	}
	t.Parallel()
	e := newEnv(t)
	dir := filepath.Join(t.TempDir(), "imgs")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.Chmod(dir, 0o755)
	e.relay.ImageDir = dir
	e.imageCall(e.kindToken(model.Cursor), "get_image", `{}`, imageReply("image/png", pngB64(5)), "")
	if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("dir %v %v", fi, err)
	}
}

// A directory that cannot be written is an error text, not a silent drop or an image part.
func TestImageWriteFailureIsAnError(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	e.relay.ImageDir = filepath.Join(blocker, "imgs") // below a file
	res, _ := e.imageCall(e.kindToken(model.Cursor), "get_image", `{}`, imageReply("image/png", pngB64(5)), "")
	got := parts(t, res)
	if isErr, _ := res["isError"].(bool); !isErr || len(got) != 1 || !strings.HasPrefix(got[0]["text"].(string), "get_image: could not save the image") {
		t.Fatalf("isError %v content %v", res["isError"], got)
	}
}

// With no directory set the files go to the OS temp dir, in a folder of the user, and not into
// the app's data folder.
func TestImageDefaultDirIsInTempNotDataFolder(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	t.Setenv("TEMP", tmp)
	e := newEnv(t)
	res, _ := e.imageCall(e.kindToken(model.Cursor), "get_image", `{}`, imageReply("image/png", pngB64(5)), "")
	path := pathOf(t, parts(t, res)[0]["text"].(string))
	root := e.relay.Chats.Store.P.Root
	if strings.HasPrefix(path, root) || strings.HasPrefix(filepath.Dir(path), root) {
		t.Fatalf("path %q is under the data folder %q", path, root)
	}
	if !strings.HasPrefix(filepath.Base(filepath.Dir(path)), "aiwb-images-") || !strings.HasPrefix(path, tmp) {
		t.Fatalf("path %q is not in aiwb-images-* under %q", path, tmp)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}

// onePage connects a stand-in page to the env's server that answers every rpc with reply(params).
func (e *env) onePage(reply func(params map[string]any) any) {
	e.t.Helper()
	srv := httptest.NewServer(e.mux)
	e.t.Cleanup(srv.Close)
	page := bridgetest.Connect(e.t, srv.URL, "P1")
	page.Welcome()
	page.OnRPC(func(params map[string]any) (any, string) { return reply(params), "" })
	e.relay.Bridge.Acted("P1")
}

// resultKind tells what a Cursor-style and an image-part-style result look like: file is the path
// the text names, or "" when the result holds an image part.
func resultKind(t *testing.T, res ToolResult) (file string, hasImage bool) {
	t.Helper()
	if res.IsErr {
		t.Errorf("error result %q", res.Text)
		return "", false
	}
	if res.Image != nil {
		return "", true
	}
	_, after, ok := strings.Cut(res.Text, " Image file: ")
	if !ok {
		t.Errorf("no image part and no file in %q", res.Text)
		return "", false
	}
	i := strings.LastIndex(after, " (")
	return after[:i], false
}

// A Cursor subagent of a Claude chat gets a file; a Claude subagent of a Cursor chat gets the image part. The
// kind is the subagent's own, not the parent chat's.
func TestGetImageSubagentKind(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.relay.ImageDir = filepath.Join(t.TempDir(), "imgs")
	cursor := &fakeSpawner{}
	e.relay.Chats.Spawners[model.Cursor] = cursor
	e.onePage(func(map[string]any) any { return imageReply("image/png", pngB64(30)) })
	spawn := func(chatID string, kind model.AgentKind, sp *fakeSpawner) string {
		t.Helper()
		n := sp.count()
		if _, err := e.relay.Chats.SpawnSubagent(chatID, chats.SpawnSubRequest{Prompt: "look at the board", Kind: kind}); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "the subagent process", func() bool { return sp.count() > n })
		return sp.last(t).opts.MCP.Token
	}
	// under the Claude chat
	file, img := resultKind(t, e.relay.dispatch(spawn(e.chat, model.Cursor, cursor), "get_image", nil))
	if img || filepath.Dir(file) != e.relay.ImageDir {
		t.Errorf("Cursor subagent of a Claude chat: image part %v, file %q", img, file)
	}
	if _, err := os.Stat(file); err != nil {
		t.Error(err)
	}
	if _, img := resultKind(t, e.relay.dispatch(spawn(e.chat, model.Claude, e.claude), "get_image", nil)); !img {
		t.Error("Claude subagent of a Claude chat got no image part")
	}
	// under a Cursor chat
	v, err := e.relay.Chats.Create(model.Cursor, "", e.board.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, img := resultKind(t, e.relay.dispatch(spawn(v.ID, model.Claude, e.claude), "get_image", nil)); !img {
		t.Error("Claude subagent of a Cursor chat got no image part")
	}
	file, img = resultKind(t, e.relay.dispatch(spawn(v.ID, model.Cursor, cursor), "get_image", nil))
	if img || file == "" {
		t.Errorf("Cursor subagent of a Cursor chat: image part %v, file %q", img, file)
	}
}

// A branch's token is the branch's own: a branch of a Cursor chat gets a file, a branch of a Claude chat the image part.
func TestGetImageBranchKind(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		kind model.AgentKind
		file bool
	}{{model.Cursor, true}, {model.Claude, false}} {
		t.Run(string(c.kind), func(t *testing.T) {
			e := newEnv(t)
			e.relay.ImageDir = filepath.Join(t.TempDir(), "imgs")
			e.relay.Chats.Spawners[model.Cursor] = &fakeSpawner{}
			v, err := e.relay.Chats.Create(c.kind, "", e.board.ID)
			if err != nil {
				t.Fatal(err)
			}
			e.chat = v.ID
			addBranch(t, e)
			e.onePage(func(map[string]any) any { return imageReply("image/png", pngB64(30)) })
			file, img := resultKind(t, e.relay.dispatch(testBranchToken, "get_image", nil))
			if (file != "") != c.file || img == c.file {
				t.Errorf("branch of a %s chat: file %q, image part %v", c.kind, file, img)
			}
		})
	}
}

// Several Cursor chats ask at once while old files are being swept: every call gets its own file with its own
// bytes, the old files go, and (under -race) the sweep and the writes share nothing unsafe.
func TestGetImageCursorConcurrent(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	dir := filepath.Join(t.TempDir(), "imgs")
	e.relay.ImageDir, e.relay.ImageMaxAge = dir, time.Minute
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Hour)
	var stale []string
	for i := range 40 {
		p := filepath.Join(dir, fmt.Sprintf("img-stale%02d.png", i))
		if err := os.WriteFile(p, []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
		os.Chtimes(p, past, past)
		stale = append(stale, p)
	}
	const n = 8
	tokens := map[string]string{} // chat id -> token
	data := map[string]string{}   // chat id -> its picture
	for i := range n {
		tok := e.kindToken(model.Cursor)
		caller, _ := e.relay.Chats.ResolveToken(tok)
		tokens[caller.Meta.ID] = tok
		data[caller.Meta.ID] = pngB64(100 + i)
	}
	e.onePage(func(params map[string]any) any { return imageReply("image/png", data[params["chat"].(string)]) })
	type got struct{ chat, file string }
	out := make(chan got, 3*n)
	var wg sync.WaitGroup
	for chat, tok := range tokens {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 3 {
				file, img := resultKind(t, e.relay.dispatch(tok, "get_image", nil))
				if img {
					t.Errorf("chat %s got an image part", chat)
					return
				}
				if file == "" { // resultKind has reported it
					return
				}
				out <- got{chat, file}
			}
		}()
	}
	wg.Wait()
	close(out)
	seen := map[string]bool{}
	for g := range out {
		if seen[g.file] {
			t.Errorf("file %s given twice", g.file)
		}
		seen[g.file] = true
		want, _ := base64.StdEncoding.DecodeString(data[g.chat])
		if b, err := os.ReadFile(g.file); err != nil || !bytes.Equal(b, want) {
			t.Errorf("file of chat %s: %v, %d bytes, want %d", g.chat, err, len(b), len(want))
		}
	}
	if len(seen) != 3*n {
		t.Errorf("%d files, want %d", len(seen), 3*n)
	}
	for _, p := range stale {
		if _, err := os.Stat(p); err == nil {
			t.Errorf("stale file %s is still there", filepath.Base(p))
		}
	}
}

// A picture directory that is a symlink is refused, and nothing is written through the link.
func TestImageDirSymlinkRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no symlinks to rely on")
	}
	t.Parallel()
	e := newEnv(t)
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "imgs")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	e.relay.ImageDir = link
	res, _ := e.imageCall(e.kindToken(model.Cursor), "get_image", `{}`, imageReply("image/png", pngB64(5)), "")
	got := parts(t, res)
	if isErr, _ := res["isError"].(bool); !isErr || len(got) != 1 || !strings.Contains(got[0]["text"].(string), "could not save the image") || !strings.Contains(got[0]["text"].(string), "is not a directory") {
		t.Fatalf("isError %v content %v", res["isError"], got)
	}
	if es, _ := os.ReadDir(target); len(es) != 0 {
		t.Errorf("%d entries were written through the link", len(es))
	}
}

// A directory that belongs to someone else cannot be tightened to 0700, so it is refused rather than written to.
// This test only reaches the refusal where "/" is not ours: it cannot tell the chmod apart from the plain
// permission error of writing into "/" (a directory owned by another user that we may write to needs root to make).
// TestImageDirTightened (earlier in this file) pins the chmod itself.
func TestImageDirForeignOwnerRefused(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs unix and a user that is not root")
	}
	var st syscall.Stat_t
	if err := syscall.Stat("/", &st); err != nil || int(st.Uid) == os.Getuid() {
		t.Skip("the root directory is ours")
	}
	t.Parallel()
	e := newEnv(t)
	e.relay.ImageDir = "/"
	res, _ := e.imageCall(e.kindToken(model.Cursor), "get_image", `{}`, imageReply("image/png", pngB64(5)), "")
	got := parts(t, res)
	if isErr, _ := res["isError"].(bool); !isErr || len(got) != 1 || !strings.Contains(got[0]["text"].(string), "could not save the image") {
		t.Fatalf("isError %v content %v", res["isError"], got)
	}
	if es, _ := filepath.Glob("/img-*"); len(es) != 0 {
		t.Errorf("files written into /: %v", es)
	}
}

// A JPEG or WebP picture is written with its own extension and named as such; an unsupported one never gets here.
func TestGetImageCursorOtherTypes(t *testing.T) {
	t.Parallel()
	for _, c := range []struct{ mime, ext, label string }{{"image/jpeg", ".jpg", "(JPEG)"}, {"image/webp", ".webp", "(WEBP)"}} {
		t.Run(c.mime, func(t *testing.T) {
			e := newEnv(t)
			e.relay.ImageDir = filepath.Join(t.TempDir(), "imgs")
			data := base64.StdEncoding.EncodeToString([]byte("not really a " + c.mime))
			res, _ := e.imageCall(e.kindToken(model.Cursor), "get_image", `{}`, imageReply(c.mime, data), "")
			got := parts(t, res)
			if _, has := res["isError"]; has || len(got) != 1 {
				t.Fatalf("isError %v content %v", res["isError"], got)
			}
			text := got[0]["text"].(string)
			if !strings.HasSuffix(text, " "+c.label+". Open it with your file tools.") {
				t.Fatalf("text %q lacks %s", text, c.label)
			}
			_, after, _ := strings.Cut(text, " Image file: ")
			path := after[:strings.LastIndex(after, " (")]
			if filepath.Ext(path) != c.ext {
				t.Errorf("path %q, want %s", path, c.ext)
			}
			if b, err := os.ReadFile(path); err != nil || string(b) != "not really a "+c.mime {
				t.Errorf("file %q: %v %q", path, err, b)
			}
		})
	}
}
