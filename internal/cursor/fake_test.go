package cursor

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The test binary doubles as a fake `agent acp` (the helper-process pattern): with
// FAKE_ACP_SCRIPT set, TestMain plays that script instead of running the tests.
//
// A script maps a method to the steps run when a request or notification with that method
// arrives. A request with no script entry gets the result {}. Every received line is appended to
// FAKE_ACP_RECORD; "EOF" is appended when stdin closes, and the fake then exits.
type fakeStep struct {
	Send    json.RawMessage `json:"send,omitempty"`    // write this message as is
	Update  json.RawMessage `json:"update,omitempty"`  // write a session/update notification with this update
	Result  json.RawMessage `json:"result,omitempty"`  // answer the current request with this result
	Error   json.RawMessage `json:"error,omitempty"`   // answer the current request with this error
	Request json.RawMessage `json:"request,omitempty"` // {method, params}: send a request, wait for its answer
	Wait    string          `json:"wait,omitempty"`    // wait until a message with this method arrives
	Sleep   int             `json:"sleep,omitempty"`   // milliseconds
	Hang    bool            `json:"hang,omitempty"`    // never answer; wait for stdin to close
}

type fakeScript map[string][]fakeStep

func TestMain(m *testing.M) {
	if path := os.Getenv("FAKE_ACP_SCRIPT"); path != "" {
		runFakeACP(path, os.Getenv("FAKE_ACP_RECORD"))
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func runFakeACP(scriptPath, recordPath string) {
	b, err := os.ReadFile(scriptPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake: ", err)
		os.Exit(2)
	}
	var script fakeScript
	if err := json.Unmarshal(b, &script); err != nil {
		fmt.Fprintln(os.Stderr, "fake: ", err)
		os.Exit(2)
	}
	rec, err := os.OpenFile(recordPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		os.Exit(2)
	}
	defer rec.Close()

	in := make(chan msg, 64)
	go func() {
		sc := bufio.NewScanner(os.Stdin)
		sc.Buffer(make([]byte, 1<<20), 64<<20)
		for sc.Scan() {
			rec.Write(append(append([]byte{}, sc.Bytes()...), '\n'))
			var m msg
			if json.Unmarshal(sc.Bytes(), &m) == nil {
				in <- m
			}
		}
		rec.WriteString("EOF\n")
		close(in)
	}()
	out := bufio.NewWriter(os.Stdout)
	write := func(v any) {
		b, _ := json.Marshal(v)
		out.Write(append(b, '\n'))
		out.Flush()
	}

	var queue []msg
	next := func() (msg, bool) {
		if len(queue) > 0 {
			m := queue[0]
			queue = queue[1:]
			return m, true
		}
		m, ok := <-in
		return m, ok
	}
	srvSeq := 0
	for {
		m, ok := next()
		if !ok {
			return
		}
		if m.Method == "" {
			continue
		}
		steps, scripted := script[m.Method]
		answered := false
		for _, s := range steps {
			switch {
			case s.Send != nil:
				out.Write(append(append([]byte{}, s.Send...), '\n'))
				out.Flush()
			case s.Update != nil:
				write(map[string]any{"jsonrpc": "2.0", "method": "session/update",
					"params": map[string]any{"sessionId": "fake", "update": s.Update}})
			case s.Result != nil:
				write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": s.Result})
				answered = true
			case s.Error != nil:
				write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": s.Error})
				answered = true
			case s.Request != nil:
				srvSeq++
				id := fmt.Sprintf("srv-%d", srvSeq)
				var r struct {
					Method string          `json:"method"`
					Params json.RawMessage `json:"params"`
				}
				json.Unmarshal(s.Request, &r)
				write(map[string]any{"jsonrpc": "2.0", "id": id, "method": r.Method, "params": r.Params})
				for {
					a, ok := <-in
					if !ok {
						return
					}
					if a.Method == "" && string(a.ID) == `"`+id+`"` {
						break
					}
					queue = append(queue, a)
				}
			case s.Wait != "":
				found := false
				for i, q := range queue {
					if q.Method == s.Wait {
						queue = append(queue[:i], queue[i+1:]...)
						found = true
						break
					}
				}
				for !found {
					a, ok := <-in
					if !ok {
						return
					}
					if a.Method == s.Wait {
						break
					}
					queue = append(queue, a)
				}
			case s.Sleep > 0:
				time.Sleep(time.Duration(s.Sleep) * time.Millisecond)
			case s.Hang:
				for range in {
				}
				return
			}
		}
		if !scripted && len(m.ID) > 0 && !answered {
			write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{}})
		}
	}
}

// fake sets up the fake agent for one test and returns the path of its record file.
func fake(t *testing.T, script fakeScript) string {
	t.Helper()
	dir := t.TempDir()
	b, err := json.Marshal(script)
	if err != nil {
		t.Fatal(err)
	}
	sp := filepath.Join(dir, "script.json")
	if err := os.WriteFile(sp, b, 0o644); err != nil {
		t.Fatal(err)
	}
	rp := filepath.Join(dir, "record.jsonl")
	t.Setenv("FAKE_ACP_SCRIPT", sp)
	t.Setenv("FAKE_ACP_RECORD", rp)
	t.Setenv("GORACE", "atexit_sleep_ms=0") // a -race fake would otherwise wait 1 s before exiting
	return rp
}

// recorded is one line the fake received.
type recorded struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
	EOF    bool            `json:"-"`
}

func readRecord(t *testing.T, path string) []recorded {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []recorded
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if line == "EOF" {
			out = append(out, recorded{EOF: true})
			continue
		}
		var r recorded
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatalf("bad record line %q: %v", line, err)
		}
		out = append(out, r)
	}
	return out
}

func methods(rs []recorded) []string {
	var out []string
	for _, r := range rs {
		if r.Method != "" {
			out = append(out, r.Method)
		}
	}
	return out
}

func find(rs []recorded, method string) (recorded, bool) {
	for _, r := range rs {
		if r.Method == method {
			return r, true
		}
	}
	return recorded{}, false
}

func raw(s string) json.RawMessage { return json.RawMessage(s) }

func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
