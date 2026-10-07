// Package bridgetest is a stand-in for the page in Go tests: a client that holds an event
// stream of a server open and makes calls with its client id, as a browser page does. With
// Options it stands in for an API client on the remote listener as well.
//
// It speaks HTTP only and imports nothing from this project, so the tests of the bridge, of the
// server and of the board relay can all use it. The server under test must serve
// GET /api/events (editorbridge.Bridge.ServeSSE); OnRPC also needs POST /api/rpc-reply.
package bridgetest

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// ClientHeader carries the page's id on each of its calls.
const ClientHeader = "X-AIWB-Client"

// Wait is how long Next, Expect and ExpectEnded wait before they fail the test.
const Wait = 5 * time.Second

var httpClient = &http.Client{Transport: &http.Transport{}}

// Page is one stand-in page: an open event stream and the id it states.
type Page struct {
	ID string

	t      testing.TB
	base   string
	http   *http.Client
	header map[string]string
	events chan string   // the data of each event, in order
	ended  chan struct{} // closed when the stream ended, by either side
	cancel context.CancelFunc

	mu    sync.Mutex
	onRPC func(params map[string]any) (result any, errText string)
	rpcs  sync.WaitGroup
}

// Connect opens GET <baseURL>/api/events?client=<id> and returns once the server has accepted
// the stream. The events, hello and snapshot first, wait to be read with Next or Expect. The
// stream is closed when the test ends.
func Connect(t testing.TB, baseURL, id string) *Page {
	t.Helper()
	return ConnectWith(t, baseURL, id, Options{})
}

// Options says how a stand-in client reaches its server. The zero value is a page on loopback.
type Options struct {
	HTTP   *http.Client      // nil = the package's plain client
	Header map[string]string // sent with the stream's request and with every call, the client id too
}

// ConnectWith is Connect for a client that reaches its server as o says. An API client gives the
// HTTP client that trusts the listener's certificate, and the secret and its id as headers.
func ConnectWith(t testing.TB, baseURL, id string, o Options) *Page {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	p := &Page{
		ID: id, t: t, base: strings.TrimSuffix(baseURL, "/"), http: o.HTTP, header: o.Header,
		events: make(chan string, 4096), ended: make(chan struct{}), cancel: cancel,
	}
	if p.http == nil {
		p.http = httpClient
	}
	req, err := http.NewRequestWithContext(ctx, "GET", p.base+"/api/events?client="+url.QueryEscape(id), nil)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	for k, v := range p.header {
		req.Header.Set(k, v)
	}
	resp, err := p.http.Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		cancel()
		t.Fatalf("events stream of %s: status %d", id, resp.StatusCode)
	}
	go p.read(resp.Body)
	t.Cleanup(func() {
		p.Close()
		p.rpcs.Wait()
	})
	return p
}

// read queues the stream's events until it ends. An rpc event goes to the function given to
// OnRPC, if there is one, and is then not queued.
func (p *Page) read(body io.ReadCloser) {
	defer close(p.ended)
	defer body.Close()
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64<<10), 64<<20)
	for sc.Scan() {
		data, ok := strings.CutPrefix(sc.Text(), "data: ")
		if !ok {
			continue
		}
		if strings.Contains(data, `"rpc"`) && p.answer(data) {
			continue
		}
		p.events <- data
	}
}

// answer runs the OnRPC function for an rpc event and posts its reply. It reports false when
// data is no rpc event or no function is set.
func (p *Page) answer(data string) bool {
	var ev struct {
		Type   string         `json:"type"`
		ID     string         `json:"id"`
		Params map[string]any `json:"params"`
	}
	if json.Unmarshal([]byte(data), &ev) != nil || ev.Type != "rpc" {
		return false
	}
	p.mu.Lock()
	fn := p.onRPC
	p.mu.Unlock()
	if fn == nil {
		return false
	}
	p.rpcs.Add(1)
	go func() {
		defer p.rpcs.Done()
		result, errText := fn(ev.Params)
		reply := map[string]any{"id": ev.ID}
		if errText != "" {
			reply["error"] = errText
		} else {
			reply["result"] = result
		}
		p.do("POST", "/api/rpc-reply", reply) // a late reply may be refused
	}()
	return true
}

// OnRPC makes the page answer the rpc events that arrive from now on: fn gets the event's
// "params" and returns the result, or the text of an error. The answer goes to
// POST /api/rpc-reply. Each event is answered on a goroutine of its own, and is no longer
// returned by Next. A nil fn stops that.
func (p *Page) OnRPC(fn func(params map[string]any) (result any, errText string)) {
	p.mu.Lock()
	p.onRPC = fn
	p.mu.Unlock()
}

// NextRaw returns the next event as the server sent it. It fails the test when none arrives
// within Wait.
func (p *Page) NextRaw() string {
	p.t.Helper()
	select {
	case data := <-p.events:
		return data
	case <-time.After(Wait):
		p.t.Fatalf("page %s: no event", p.ID)
		return ""
	}
}

// Next returns the next event. It fails the test when none arrives within Wait.
func (p *Page) Next() map[string]any {
	p.t.Helper()
	data := p.NextRaw()
	var ev map[string]any
	if err := json.Unmarshal([]byte(data), &ev); err != nil {
		p.t.Fatalf("page %s: bad event %q: %v", p.ID, data, err)
	}
	return ev
}

// Expect returns the next event, which must be of this type.
func (p *Page) Expect(typ string) map[string]any {
	p.t.Helper()
	ev := p.Next()
	if ev["type"] != typ {
		p.t.Fatalf("page %s: got event %v, want type %q", p.ID, ev, typ)
	}
	return ev
}

// Welcome reads the two events a stream starts with, hello and snapshot, and returns the
// snapshot.
func (p *Page) Welcome() map[string]any {
	p.t.Helper()
	if h := p.Expect("hello"); h["client"] != p.ID {
		p.t.Fatalf("page %s: hello = %v", p.ID, h)
	}
	return p.Expect("snapshot")
}

// ExpectNone fails the test when an event arrives within d.
func (p *Page) ExpectNone(d time.Duration) {
	p.t.Helper()
	select {
	case data := <-p.events:
		p.t.Fatalf("page %s: unexpected event %s", p.ID, data)
	case <-time.After(d):
	}
}

// Drain returns the events that are waiting and those that arrive until none came for quiet, as
// the server sent them. It never fails the test.
func (p *Page) Drain(quiet time.Duration) []string {
	var got []string
	t := time.NewTimer(quiet)
	defer t.Stop()
	for {
		select {
		case data := <-p.events:
			got = append(got, data)
			if !t.Stop() {
				select {
				case <-t.C:
				default:
				}
			}
			t.Reset(quiet)
		case <-t.C:
			return got
		}
	}
}

// ExpectEnded fails the test unless the stream ends within Wait. Events queued before the end
// can still be read.
func (p *Page) ExpectEnded() {
	p.t.Helper()
	select {
	case <-p.ended:
	case <-time.After(Wait):
		p.t.Fatalf("page %s: the stream did not end", p.ID)
	}
}

// Close ends the page's stream, as a closed window does, and waits until it is closed here.
// The server notices a moment later.
func (p *Page) Close() {
	p.cancel()
	<-p.ended
}

// Do makes a call with the page's id in the client header and returns the status and the body
// of the answer. path starts with "/". body is nil for none, a string or []byte to send as it
// is, or a value to send as JSON.
func (p *Page) Do(method, path string, body any) (status int, answer []byte) {
	p.t.Helper()
	status, answer, err := p.do(method, path, body)
	if err != nil {
		p.t.Fatalf("page %s: %s %s: %v", p.ID, method, path, err)
	}
	return status, answer
}

func (p *Page) do(method, path string, body any) (int, []byte, error) {
	var rd io.Reader
	switch v := body.(type) {
	case nil:
	case string:
		rd = strings.NewReader(v)
	case []byte:
		rd = bytes.NewReader(v)
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			return 0, nil, err
		}
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, p.base+path, rd)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set(ClientHeader, p.ID)
	for k, v := range p.header {
		req.Header.Set(k, v)
	}
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	answer, err := io.ReadAll(resp.Body)
	return resp.StatusCode, answer, err
}
