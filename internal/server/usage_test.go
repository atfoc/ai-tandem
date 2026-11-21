package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

type usageAccounts []model.AgentKind

func (a usageAccounts) Kinds() []model.AgentKind      { return a }
func (a usageAccounts) Check(model.AgentKind) error   { return nil }
func (a usageAccounts) Name(k model.AgentKind) string { return string(k) }

func TestUsageOverviewStreamsEachResultAndSharesTheCache(t *testing.T) {
	t.Parallel()
	work, home := model.AliasKind("a_work0001"), model.AliasKind("a_home0001")
	e := newRawEnv(t, withClients)
	set := usable.NewWith(map[model.AgentKind]string{model.Claude: "claude", model.Codex: "codex", model.Pi: "pi"}, func(bin string) (string, error) { return bin, nil })
	set.SetExtra(usageAccounts{work, home})
	e.a.Agents = set

	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	var calls atomic.Int32
	caches := map[model.AgentKind]*agent.UsageCache{}
	for _, kind := range set.List() {
		if kind == model.Pi {
			continue
		}
		caches[kind] = &agent.UsageCache{TTL: time.Minute, Fetch: func() (model.PlanUsage, error) {
			calls.Add(1)
			switch kind {
			case model.Claude:
				<-release
			case work:
				return model.PlanUsage{}, errors.New("account check failed")
			}
			return model.PlanUsage{Plan: true, Limits: []model.UsageLimit{{Kind: "session", Percent: 42}}}, nil
		}}
	}
	e.s.UsageFor = func(kind model.AgentKind) UsageCheck {
		if cache := caches[kind]; cache != nil {
			return cache.Get
		}
		return nil
	}
	client := e.s.ClientHandler()
	ctx, cancel := context.WithCancel(context.Background())
	stream := make(usageStream, len(set.List())+2)
	streamDone := make(chan struct{})
	go func() {
		defer close(streamDone)
		e.s.Bridge.Serve(stream, httptest.NewRequestWithContext(ctx, "GET", "/api/events", nil), testAPIClient, func() any {
			return map[string]string{"type": "snapshot"}
		})
	}()
	defer func() { cancel(); <-streamDone }()
	waitFor := func(match func(string) bool) {
		t.Helper()
		timeout := time.NewTimer(2 * time.Second)
		defer timeout.Stop()
		for {
			select {
			case line := <-stream:
				if match(line) {
					return
				}
			case <-timeout.C:
				t.Fatal("no matching usage event")
			}
		}
	}
	waitFor(func(line string) bool { return strings.Contains(line, `"type":"hello"`) })
	finished := make(chan *httptest.ResponseRecorder, 1)
	go func() { finished <- clientDo(client, "GET", "/api/usage?request=overview", testHost, testSecret) }()
	seen := map[model.AgentKind]bool{}
	waitFor(func(line string) bool {
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok {
			return false
		}
		var event struct {
			Type, Request string
			Result        usageResult
		}
		if json.Unmarshal([]byte(data), &event) == nil && event.Type == "plan_usage" && event.Request == "overview" {
			seen[event.Result.Agent] = true
		}
		return seen[model.Codex] && seen[work] && seen[home]
	})
	if seen[model.Claude] {
		t.Fatal("the slow agent answered before it was unblocked")
	}
	unblock()
	reply := <-finished
	if reply.Code != http.StatusOK {
		t.Fatalf("overview: %d %s", reply.Code, reply.Body)
	}
	results := decode[[]usageResult](t, reply.Body.String())
	var kinds []model.AgentKind
	for _, result := range results {
		kinds = append(kinds, result.Agent)
		switch result.Agent {
		case work:
			if result.Error != "account check failed" || result.Usage != nil {
				t.Fatalf("failed account: %+v", result)
			}
		case model.Pi:
			if result.Usage == nil || result.Usage.Plan || result.Usage.Note == "" {
				t.Fatalf("no plan: %+v", result)
			}
		default:
			if result.Usage == nil || !result.Usage.Plan {
				t.Fatalf("missing plan: %+v", result)
			}
		}
	}
	if want := set.List(); !slices.Equal(kinds, want) {
		t.Fatalf("agents: %v, want %v", kinds, want)
	}
	reply = clientDo(client, "GET", "/api/usage", testHost, testSecret)
	if second := decode[[]usageResult](t, reply.Body.String()); len(second) != len(kinds) || int(calls.Load()) != len(caches) {
		t.Fatalf("second request started another check: calls=%d results=%+v", calls.Load(), second)
	}
	reply = clientDo(client, "GET", "/api/usage/codex", testHost, testSecret)
	if reply.Code != http.StatusOK || int(calls.Load()) != len(caches) {
		t.Fatalf("per-agent request did not use the same cache: status=%d calls=%d", reply.Code, calls.Load())
	}

}

// usageStream lets the test observe the real bridge deliveries while the HTTP handler is running.
type usageStream chan string

func (w usageStream) Header() http.Header { return make(http.Header) }
func (w usageStream) WriteHeader(int)     {}
func (w usageStream) Flush()              {}
func (w usageStream) Write(p []byte) (int, error) {
	w <- string(p)
	return len(p), nil
}
