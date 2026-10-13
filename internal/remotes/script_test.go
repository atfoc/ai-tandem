package remotes

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/servers/standin"
)

// got is one request a scripted route received.
type got struct {
	Method, URI, Body string
}

// script is a route of a stand-in whose answer the test sets and whose requests it can read.
// Without an answer it says 404 "not found", as the stand-in does for a route it does not have.
type script struct {
	mu   sync.Mutex
	h    func(w http.ResponseWriter, r *http.Request)
	gots []got
}

// script makes the stand-in serve the pattern from a script. One pattern, one script per server.
func (f *far) script(pattern string) *script {
	s := &script{}
	f.s.Handle(pattern, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.gots = append(s.gots, got{r.Method, r.URL.RequestURI(), string(body)})
		h := s.h
		s.mu.Unlock()
		if h == nil {
			writeAnswer(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		h(w, r)
	})
	return s
}

func (s *script) set(h func(w http.ResponseWriter, r *http.Request)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.h = h
}

// answer makes the route answer every request with the status and v as JSON.
func (s *script) answer(status int, v any) {
	s.set(func(w http.ResponseWriter, r *http.Request) { writeAnswer(w, status, v) })
}

// hang makes the route never answer: a request waits until it ends, or until release is called.
// arrived gets one value per request.
func (s *script) hang() (arrived <-chan struct{}, release func()) {
	in, out := make(chan struct{}, 64), make(chan struct{})
	s.set(func(w http.ResponseWriter, r *http.Request) {
		in <- struct{}{}
		select {
		case <-out:
			panic(http.ErrAbortHandler) // released: the request ends with no answer
		case <-r.Context().Done():
		}
	})
	var once sync.Once
	return in, func() { once.Do(func() { close(out) }) }
}

// drop makes the route end every request at once with no answer, as hang does once it is
// released. For the relay that is a call that got no answer, the same as one that waited out its
// limit, so a test that only needs such a call does not sit the limit out.
func (s *script) drop() {
	s.set(func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) })
}

func (s *script) calls() []got {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]got(nil), s.gots...)
}

func (s *script) count() int { return len(s.calls()) }

// last is the request the route received last.
func (s *script) last(t *testing.T) got {
	t.Helper()
	c := s.calls()
	if len(c) == 0 {
		t.Fatal("the route was not asked")
	}
	return c[len(c)-1]
}

func writeAnswer(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// noSecret fails the test when text holds the entry's secret.
func noSecret(t *testing.T, what, text string) {
	t.Helper()
	if strings.Contains(text, standin.DefaultSecret) {
		t.Errorf("%s holds a secret: %s", what, text)
	}
}
