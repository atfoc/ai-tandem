package standin

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"ai-whiteboard/internal/remote"
)

// level sets a request's level header to v, or takes it away for "".
func level(v string) func(*http.Request) {
	return func(r *http.Request) {
		r.Header.Del(levelHeader)
		if v != "" {
			r.Header.Set(levelHeader, v)
		}
	}
}

// tooOld reports whether an answer is the refusal of a client that is too old, whole.
func tooOld(t *testing.T, res *http.Response, body []byte) bool {
	t.Helper()
	m := object(t, body)
	return res.StatusCode == 400 && len(m) == 2 && m["code"] == "client_too_old" &&
		m["error"] == "This app is too old for this server: update AI Whiteboard on the machine that connects."
}

// TestSectionLevelCheck: after the secret, the Host and the client id, the stand-in checks the
// client's level as a server of level 5 does. On every route but GET /api/hello, the scripted
// ones and the unknown ones too, a request without the header, or with a value that is no
// integer of 5 or more, is refused as too old a client.
func TestSectionLevelCheck(t *testing.T) {
	t.Parallel()
	s := Start(t, Options{})
	c := plainClient(t, nil)
	s.Handle("GET /api/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"id":"`+r.PathValue("id")+`"}`)
	})
	served := map[string]int{"/api/state": 200, "/api/chats/c7": 200, "/api/other": 404}

	for path, status := range served {
		for _, v := range []string{"", "4", "0", "-5", "five", "5.0", "5 6", "4.9", "99999999999999999999"} {
			res, body := get(t, c, s.URL()+path, DefaultSecret, level(v))
			if !tooOld(t, res, body) {
				t.Errorf("%s with the level %q: %d %s; want 400 client_too_old", path, v, res.StatusCode, body)
			}
		}
		for _, v := range []string{"5", "6", "12"} {
			if res, body := get(t, c, s.URL()+path, DefaultSecret, level(v)); res.StatusCode != status {
				t.Errorf("%s with the level %q: %d %s; want %d", path, v, res.StatusCode, body, status)
			}
		}
		// the secret, the Host and the client id come first
		if res, _ := get(t, c, s.URL()+path, "wrong", level("")); res.StatusCode != 401 {
			t.Errorf("%s with a wrong secret and no level: %d, want 401", path, res.StatusCode)
		}
		res, _ := get(t, c, s.URL()+path, DefaultSecret, func(r *http.Request) { level("")(r); r.Host = "evil.example" })
		if res.StatusCode != 403 {
			t.Errorf("%s with another Host and no level: %d, want 403", path, res.StatusCode)
		}
		for id, code := range map[string]string{"client-1": "bad_client", DefaultInstanceID: "own_client"} {
			res, body := get(t, c, s.URL()+path, DefaultSecret, func(r *http.Request) {
				level("")(r)
				r.Header.Set(remote.ClientHeader, id)
			})
			if res.StatusCode != 400 || object(t, body)["code"] != code {
				t.Errorf("%s with the client id %q and no level: %d %s; want 400 %s", path, id, res.StatusCode, body, code)
			}
		}
	}

	// A stream that is refused is not opened.
	if res, body := get(t, c, s.URL()+"/api/events?client="+testClient, DefaultSecret, level("")); !tooOld(t, res, body) {
		t.Errorf("the stream with no level: %d %s; want 400 client_too_old", res.StatusCode, body)
	}
	if s.Streams() != 0 {
		t.Errorf("Streams() = %d: a refused stream was opened", s.Streams())
	}

	// Hello is open to a client of any level, but only its GET.
	for _, v := range []string{"", "4", "five", "5"} {
		res, body := get(t, c, s.URL()+"/api/hello", DefaultSecret, level(v))
		if res.StatusCode != 200 || object(t, body)["featureLevel"] != float64(DefaultFeatureLevel) {
			t.Errorf("hello with the level %q: %d %s; want the hello", v, res.StatusCode, body)
		}
	}
	req, _ := http.NewRequest(http.MethodPost, s.URL()+"/api/hello", nil)
	req.Header.Set(remote.SecretHeader, DefaultSecret)
	req.Header.Set(remote.ClientHeader, testClient)
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !tooOld(t, res, body) {
		t.Errorf("POST hello with no level: %d %s; want 400 client_too_old", res.StatusCode, body)
	}
}

// TestSectionLevelCheckOffAndSeen: a test can switch the check off, and then a request without
// the header is served as a server of before served it. Requests() shows the header of every
// request as it came, of a refused one too, whether the check is on or off.
func TestSectionLevelCheckOffAndSeen(t *testing.T) {
	t.Parallel()
	s := Start(t, Options{})
	c := plainClient(t, nil)
	state := func(v string) int {
		res, _ := get(t, c, s.URL()+"/api/state", DefaultSecret, level(v))
		return res.StatusCode
	}
	if got := state(""); got != 400 {
		t.Fatalf("the state with no level: %d, want 400", got)
	}
	s.SetLevelCheck(false)
	if a, b, c := state(""), state("4"), state("five"); a != 200 || b != 200 || c != 200 {
		t.Errorf("with the check off: %d, %d and %d; want 200 for each", a, b, c)
	}
	s.SetLevelCheck(true)
	if a, b := state(""), state("5"); a != 400 || b != 200 {
		t.Errorf("with the check on again: %d without a level and %d with 5; want 400 and 200", a, b)
	}

	var got []string
	for _, q := range s.Requests() {
		if q.Method != "GET" || q.Path != "/api/state" || q.Secret != DefaultSecret || q.Client != testClient {
			t.Errorf("request %+v", q)
		}
		got = append(got, q.Level)
	}
	if want := []string{"", "", "4", "five", "", "5"}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("the levels of the requests %q; want %q", got, want)
	}
}

// TestSectionDefaultSnapshot: the default snapshot has the parts of a snapshot of level 5 and
// no other, an empty tree as empty lists and an empty object, never null, and no library. The
// stream's snapshot event has the same parts inline.
func TestSectionDefaultSnapshot(t *testing.T) {
	t.Parallel()
	raw, err := json.Marshal(DefaultSnapshot())
	if err != nil {
		t.Fatal(err)
	}
	var parts map[string]json.RawMessage
	if err := json.Unmarshal(raw, &parts); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"library": "null", "groups": "[]", "defaults": `{"groups":{}}`,
		"boards": "[]", "chats": "[]", "states": "[]",
	}
	for k, v := range want {
		if string(parts[k]) != v {
			t.Errorf("%s = %s; want %s", k, parts[k], v)
		}
	}
	for _, k := range []string{"agents", "catalogs", "home", "defaultCwd"} {
		if v, has := parts[k]; !has || string(v) == "null" {
			t.Errorf("%s = %s; want what a new chat is offered", k, v)
		}
	}
	if len(parts) != len(want)+4 {
		t.Errorf("%d parts: %s", len(parts), raw)
	}

	s := Start(t, Options{})
	e := openStream(t, plainClient(t, nil), s)
	if ev, ok := e.next(t); !ok || ev["type"] != "hello" {
		t.Fatalf("the first event %v, %v", ev, ok)
	}
	snap, ok := e.next(t)
	if !ok || snap["type"] != "snapshot" || len(snap) != len(parts)+1 {
		t.Fatalf("the second event %v, %v; want the snapshot with its %d parts", snap, ok, len(parts))
	}
	for _, k := range []string{"groups", "boards", "chats", "states"} {
		if l, ok := snap[k].([]any); !ok || len(l) != 0 {
			t.Errorf("the snapshot event's %s = %v; want an empty array", k, snap[k])
		}
	}
}
