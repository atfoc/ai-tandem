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
// arrives. A request with no script entry is answered by the stateful fake Cursor (fakeCursor)
// when it knows the method, else with the result {}. Every received line is appended to
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
	Cursor  bool            `json:"cursor,omitempty"`  // answer the current request as fakeCursor does
}

type fakeScript map[string][]fakeStep

func TestMain(m *testing.M) {
	if path := os.Getenv("FAKE_ACP_SCRIPT"); path != "" {
		runFakeACP(path, os.Getenv("FAKE_ACP_RECORD"), os.Getenv("FAKE_ACP_STATE"))
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func runFakeACP(scriptPath, recordPath, statePath string) {
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
	fc := newFakeCursor(statePath)

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
	answer := func(m msg) {
		res, rpcErr := fc.handle(m.Method, m.Params)
		if rpcErr != nil {
			write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": rpcErr})
		} else {
			write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": res})
		}
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
			case s.Cursor:
				answer(m)
				answered = true
			case s.Hang:
				for range in {
				}
				return
			}
		}
		if !scripted && len(m.ID) > 0 && !answered {
			answer(m)
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
	t.Setenv("FAKE_ACP_STATE", filepath.Join(dir, "cli-config.json"))
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

// fakeModels is the fake Cursor's cursor/list_available_models result: each option's currentValue
// is the model's default. It covers every shape the policy meets: context + effort, thinking +
// context + effort, thinking only, reasoning without context, reasoning_effort + fast, no options,
// and optimize_for. Context values are deliberately not always in ascending order.
var fakeModels = raw(`{"models":[
 {"value":"claude-opus-5-5","name":"Claude Opus 5.5","configOptions":[
  {"id":"context","name":"Context","category":"model_config","currentValue":"300k","options":[{"value":"300k","name":"300K"},{"value":"1m","name":"1M"}]},
  {"id":"effort","name":"Effort","category":"thought_level","currentValue":"medium","options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"xhigh","name":"Extra High"},{"value":"max","name":"Max"}]},
  {"id":"fast","name":"Fast","category":"model_config","currentValue":"false","options":[{"value":"false","name":"Off"},{"value":"true","name":"On"}]}]},
 {"value":"claude-sonnet-5","name":"Claude Sonnet 5","configOptions":[
  {"id":"thinking","name":"Thinking","category":"thought_level","currentValue":"true","options":[{"value":"false","name":"Off"},{"value":"true","name":"On"}]},
  {"id":"context","name":"Context","category":"model_config","currentValue":"300k","options":[{"value":"300k","name":"300K"},{"value":"1m","name":"1M"}]},
  {"id":"effort","name":"Effort","category":"thought_level","currentValue":"high","options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"max","name":"Max"}]}]},
 {"value":"claude-haiku-4-5","name":"Claude Haiku 4.5","configOptions":[
  {"id":"thinking","name":"Thinking","category":"thought_level","currentValue":"true","options":[{"value":"false","name":"Off"},{"value":"true","name":"On"}]}]},
 {"value":"gpt-5.4","name":"GPT-5.4","configOptions":[
  {"id":"context","name":"Context","category":"model_config","currentValue":"272k","options":[{"value":"1m","name":"1M"},{"value":"272k","name":"272K"}]},
  {"id":"reasoning","name":"Reasoning","category":"thought_level","currentValue":"medium","options":[{"value":"none","name":"None"},{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"extra-high","name":"Extra High"}]},
  {"id":"fast","name":"Fast","category":"model_config","currentValue":"false","options":[{"value":"false","name":"Off"},{"value":"true","name":"On"}]}]},
 {"value":"gpt-5.4-mini","name":"GPT-5.4 Mini","configOptions":[
  {"id":"reasoning","name":"Reasoning","category":"thought_level","currentValue":"medium","options":[{"value":"none","name":"None"},{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"xhigh","name":"Extra High"}]}]},
 {"value":"grok-4.7","name":"Grok 4.7","configOptions":[
  {"id":"reasoning_effort","name":"Reasoning Effort","category":"thought_level","currentValue":"xhigh","options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"xhigh","name":"Extra High"}]},
  {"id":"fast","name":"Fast","category":"model_config","currentValue":"false","options":[{"value":"false","name":"Off"},{"value":"true","name":"On"}]}]},
 {"value":"gemini-3.1-pro","name":"Gemini 3.1 Pro","configOptions":[]},
 {"value":"auto-smart","name":"Auto","configOptions":[
  {"id":"optimize_for","name":"Optimize For","category":"model_config","currentValue":"balanced","options":[{"value":"intelligence","name":"Intelligence"},{"value":"balanced","name":"Balanced"},{"value":"cost","name":"Cost"}]}]}
]}`)

// fakeModelDefault is the model the fake Cursor selects when its shared config names none.
const fakeModelDefault = "gpt-5.4-mini"

// fakeConfig is the fake's cli-config.json: the last-used model and each model's last-used params,
// shared by every fake process of a test (as Cursor shares ~/.cursor/cli-config.json).
type fakeConfig struct {
	SelectedModel   string                       `json:"selectedModel"`
	ModelParameters map[string]map[string]string `json:"modelParameters"`
}

// fakeCursor answers initialize, session/new, session/load, cursor/list_available_models and
// session/set_config_option like `agent acp`. With the parameterized model picker flag in
// initialize, "model" takes a bare id and each model parameter is its own config option. Without
// it, "model" takes only pre-built variant values ("gpt-5.4-mini[reasoning=medium]") and there are
// no per-parameter options. Like Cursor, it reads the shared config at start and writes it back
// after every set: session/new and session/load both report the last-used model and params.
type fakeCursor struct {
	path   string
	flag   bool
	models []struct {
		Value         string         `json:"value"`
		Name          string         `json:"name"`
		ConfigOptions []configOption `json:"configOptions"`
	}
	cfg fakeConfig
}

func newFakeCursor(path string) *fakeCursor {
	fc := &fakeCursor{path: path}
	var list struct {
		Models json.RawMessage `json:"models"`
	}
	json.Unmarshal(fakeModels, &list)
	json.Unmarshal(list.Models, &fc.models)
	if b, err := os.ReadFile(path); err == nil {
		json.Unmarshal(b, &fc.cfg)
	}
	if fc.cfg.SelectedModel == "" {
		fc.cfg.SelectedModel = fakeModelDefault
	}
	if fc.cfg.ModelParameters == nil {
		fc.cfg.ModelParameters = map[string]map[string]string{}
	}
	return fc
}

func (fc *fakeCursor) save() {
	if fc.path == "" {
		return
	}
	b, _ := json.Marshal(fc.cfg)
	os.WriteFile(fc.path, b, 0o644)
}

// params returns a model's options with their last-used values, or nil when it is unknown.
func (fc *fakeCursor) params(id string) ([]configOption, bool) {
	for _, m := range fc.models {
		if m.Value != id {
			continue
		}
		out := make([]configOption, len(m.ConfigOptions))
		for i, o := range m.ConfigOptions {
			if v, ok := fc.cfg.ModelParameters[id][o.ID]; ok {
				o.CurrentValue = v
			}
			out[i] = o
		}
		return out, true
	}
	return nil, false
}

// variant is a model's pre-built variant value, from its list defaults (the old picker).
func (fc *fakeCursor) variant(id string) string {
	for _, m := range fc.models {
		if m.Value == id {
			var kv []string
			for _, o := range m.ConfigOptions {
				kv = append(kv, o.ID+"="+o.CurrentValue)
			}
			return id + "[" + strings.Join(kv, ",") + "]"
		}
	}
	return id
}

func (fc *fakeCursor) configOptions() []any {
	mode := map[string]any{"id": "mode", "name": "Mode", "type": "select", "currentValue": "agent",
		"options": []any{map[string]any{"value": "agent", "name": "Agent"}}}
	var values []any
	for _, m := range fc.models {
		v := m.Value
		if !fc.flag {
			v = fc.variant(m.Value)
		}
		values = append(values, map[string]any{"value": v, "name": m.Name})
	}
	current := fc.cfg.SelectedModel
	if !fc.flag {
		current = fc.variant(current)
	}
	out := []any{mode, map[string]any{"id": "model", "name": "Model", "category": "model", "type": "select",
		"currentValue": current, "options": values}}
	if fc.flag {
		ps, _ := fc.params(fc.cfg.SelectedModel)
		for _, o := range ps {
			out = append(out, o)
		}
	}
	return out
}

func invalid(what string) map[string]any {
	return map[string]any{"code": -32602, "message": "Invalid params", "data": what}
}

func (fc *fakeCursor) handle(method string, params json.RawMessage) (result any, rpcErr any) {
	switch method {
	case "initialize":
		var p struct {
			ClientCapabilities struct {
				Meta struct {
					ParameterizedModelPicker bool `json:"parameterizedModelPicker"`
				} `json:"_meta"`
			} `json:"clientCapabilities"`
		}
		json.Unmarshal(params, &p)
		fc.flag = p.ClientCapabilities.Meta.ParameterizedModelPicker
		return map[string]any{"protocolVersion": 1}, nil
	case "session/new":
		return map[string]any{"sessionId": testSessionID, "configOptions": fc.configOptions()}, nil
	case "session/load":
		return map[string]any{"configOptions": fc.configOptions()}, nil
	case "cursor/list_available_models":
		return fakeModels, nil
	case "session/set_config_option":
		var p struct {
			ConfigID string `json:"configId"`
			Value    string `json:"value"`
		}
		json.Unmarshal(params, &p)
		if p.ConfigID == "model" {
			id := p.Value
			if !fc.flag {
				id, _, _ = strings.Cut(p.Value, "[")
				if fc.variant(id) != p.Value {
					return nil, invalid("Invalid value for model: " + p.Value)
				}
			}
			if _, ok := fc.params(id); !ok {
				return nil, invalid("Invalid value for model: " + p.Value)
			}
			fc.cfg.SelectedModel = id
			fc.save()
			return map[string]any{"configOptions": fc.configOptions()}, nil
		}
		ps, _ := fc.params(fc.cfg.SelectedModel)
		for _, o := range ps {
			if fc.flag && o.ID == p.ConfigID && contains(o.values(), p.Value) {
				if fc.cfg.ModelParameters[fc.cfg.SelectedModel] == nil {
					fc.cfg.ModelParameters[fc.cfg.SelectedModel] = map[string]string{}
				}
				fc.cfg.ModelParameters[fc.cfg.SelectedModel][o.ID] = p.Value
				fc.save()
				return map[string]any{"configOptions": fc.configOptions()}, nil
			}
		}
		return nil, invalid("Invalid value for " + p.ConfigID + ": " + p.Value)
	}
	return map[string]any{}, nil
}

func raw(s string) json.RawMessage { return json.RawMessage(s) }

func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
