// headlessstandin stands in for the headless writer in the tests of the server program. The
// server runs it as its Node (-headless-node) with the bundle's headless.mjs as the argument,
// and gives it its configuration as one JSON line on stdin, as it gives the real process.
//
// It connects to the client API with that configuration, over HTTPS with the certificate pinned,
// takes no board, and answers every rpc with a fixed text. A board it is given (a held event) is
// released with ifIdle once the quiet time of its configuration has passed after the last call,
// as the real process does. When its stdin closes it ends.
//
// $STANDIN_OUT is a folder where it writes what it was told, for the test to read:
//
//	config   the configuration line, without the secret
//	rpcs     the method and the tool name of each rpc, a line each
//	released the board of each release the server answered
package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/server"
)

// Answer is what every rpc is answered with.
const Answer = "STANDIN: the headless writer's fixed answer"

type config struct {
	Address     string `json:"address"`
	Fingerprint string `json:"fingerprint"`
	Secret      string `json:"secret"`
	ClientID    string `json:"clientId"`
	InstanceID  string `json:"instanceId"`
	QuietMs     int64  `json:"quietMs"`
	HandoverMs  int64  `json:"handoverMs"`
	Version     string `json:"version"`
}

func main() {
	line, err := bufio.NewReader(os.Stdin).ReadBytes('\n')
	if err != nil {
		fail("no configuration on stdin: %v", err)
	}
	var cfg config
	if err := json.Unmarshal(line, &cfg); err != nil {
		fail("configuration: %v", err)
	}
	out := os.Getenv("STANDIN_OUT")
	shown := cfg
	shown.Secret = ""
	if raw, err := json.Marshal(shown); err == nil && out != "" {
		os.WriteFile(filepath.Join(out, "config"), append(raw, '\n'), 0o644)
	}

	s := &standIn{cfg: cfg, out: out, timers: map[string]*time.Timer{}}
	s.http = &http.Client{Transport: &http.Transport{ForceAttemptHTTP2: true, TLSClientConfig: &tls.Config{
		InsecureSkipVerify: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if got := remote.Fingerprint(cs.PeerCertificates[0].Raw); got != cfg.Fingerprint {
				return fmt.Errorf("the certificate's fingerprint is %s, want %s", got, cfg.Fingerprint)
			}
			return nil
		},
	}}}
	events, err := s.open()
	if err != nil {
		fail("the event stream: %v", err)
	}
	// Ends with the server: its stdin closes, or its stream does.
	done := make(chan struct{}, 2)
	go func() { io.Copy(io.Discard, os.Stdin); done <- struct{}{} }()
	go func() { s.read(events); done <- struct{}{} }()
	<-done
	os.Exit(0)
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "headlessstandin: "+format+"\n", args...)
	os.Exit(3)
}

type standIn struct {
	cfg  config
	out  string
	http *http.Client

	mu     sync.Mutex
	timers map[string]*time.Timer // by board: the quiet time that runs
}

func (s *standIn) request(method, path string, body any) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, "https://"+s.cfg.Address+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set(server.SecretHeader, s.cfg.Secret)
	req.Header.Set(server.ClientHeader, s.cfg.ClientID)
	req.Header.Set(server.LevelHeader, fmt.Sprint(server.FeatureLevel))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return s.http.Do(req)
}

func (s *standIn) open() (io.ReadCloser, error) {
	resp, err := s.request("GET", "/api/events?client="+s.cfg.ClientID, nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return resp.Body, nil
}

func (s *standIn) read(body io.ReadCloser) {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64<<10), 64<<20)
	for sc.Scan() {
		data, ok := strings.CutPrefix(sc.Text(), "data: ")
		if !ok {
			continue
		}
		var ev struct {
			Type   string `json:"type"`
			ID     string `json:"id"`
			Board  string `json:"board"`
			Method string `json:"method"`
			Params struct {
				Name   string `json:"name"`
				Target string `json:"target"`
			} `json:"params"`
		}
		if json.Unmarshal([]byte(data), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "rpc":
			go s.answer(ev.ID, ev.Method, ev.Params.Name, ev.Params.Target)
		case "server_stopping":
			go s.request("POST", "/api/client/flushed", map[string]any{})
		}
	}
}

func (s *standIn) answer(id, method, name, board string) {
	s.note("rpcs", method+" "+name+" "+board)
	s.request("POST", "/api/rpc-reply", map[string]any{"id": id, "result": Answer})
	if board == "" {
		return
	}
	// The quiet time starts again at each call.
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.timers[board]; t != nil {
		t.Stop()
	}
	s.timers[board] = time.AfterFunc(time.Duration(s.cfg.QuietMs)*time.Millisecond, func() { s.release(board) })
}

func (s *standIn) release(board string) {
	resp, err := s.request("POST", "/api/boards/"+board+"/release", map[string]any{"ifIdle": true})
	if err != nil {
		return
	}
	defer resp.Body.Close()
	var got struct {
		State string `json:"state"`
	}
	json.NewDecoder(resp.Body).Decode(&got)
	s.note("released", board+" "+got.State)
}

// note appends a line to the file name of the out folder.
func (s *standIn) note(name, line string) {
	if s.out == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := os.OpenFile(filepath.Join(s.out, name), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintln(f, line)
}
