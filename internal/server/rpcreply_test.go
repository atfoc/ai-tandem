package server

import (
	"strings"
	"testing"
	"time"
)

// A page's answer above rpcReplyMax is refused with 413, and the call it answers ends at once
// with the size, not with the call's timeout.
func TestRPCReplyAboveLimit(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.page("V")
	_, token := e.boardChat(v)

	type result struct {
		text  string
		isErr bool
	}
	called := make(chan result, 1)
	go func() {
		text, isErr := e.tool(token, "read_board")
		called <- result{text, isErr}
	}()
	var id string
	for id == "" {
		if ev := v.Next(); ev["type"] == "rpc" {
			id, _ = ev["id"].(string)
		}
	}
	large := `{"id":"` + id + `","result":"` + strings.Repeat("a", rpcReplyMax) + `"}`
	if status, out := v.Do("POST", "/api/rpc-reply", large); status != 413 || !strings.Contains(string(out), "larger than 32 MB") {
		t.Fatalf("the oversize answer: %d %s", status, out)
	}
	select {
	case r := <-called:
		if !r.isErr || !strings.Contains(r.text, "larger than 32 MB") || !strings.Contains(r.text, "smaller scope") {
			t.Fatalf("the call's answer: %+v", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the call did not end with the size error")
	}
}

func TestIDAtStart(t *testing.T) {
	t.Parallel()
	for body, want := range map[string]string{
		`{"id":"rpc_1","result":"x"}`:            "rpc_1",
		`{"result":{"id":"inner"},"id":"rpc_2"}`: "rpc_2",
		`{"id":"rpc_3","result":"cut off in th`:  "rpc_3",
		`{"result":"cut off in th`:               "",
		`[1]`:                                    "",
		``:                                       "",
		`{"id":7}`:                               "",
	} {
		if got := idAtStart([]byte(body)); got != want {
			t.Errorf("idAtStart(%q) = %q, want %q", body, got, want)
		}
	}
}
