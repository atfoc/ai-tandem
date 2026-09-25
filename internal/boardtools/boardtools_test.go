package boardtools

import (
	"encoding/json"
	"testing"
)

func TestTools(t *testing.T) {
	want := []string{"list_boards", "read_board", "get_view", "apply", "delete_elements", "create_board", "show_board"}
	if len(Tools) != len(want) {
		t.Fatalf("len(Tools) = %d, want %d", len(Tools), len(want))
	}
	for i, tool := range Tools {
		if tool.Name != want[i] {
			t.Errorf("Tools[%d].Name = %q, want %q", i, tool.Name, want[i])
		}
		if tool.Description == "" {
			t.Errorf("%s: empty Description", tool.Name)
		}
		if tool.Summary == "" {
			t.Errorf("%s: empty Summary", tool.Name)
		}
		if tool.Schema == nil || tool.Schema["type"] != "object" {
			t.Errorf("%s: schema is not an object schema", tool.Name)
		}
		if _, err := json.Marshal(tool.Schema); err != nil {
			t.Errorf("%s: schema does not marshal: %v", tool.Name, err)
		}
	}
}

const (
	tok  = "0123456789abcdef0123456789abcdef"
	good = "curl -s --data-binary @- http://127.0.0.1:4321/agent/" + tok + "/apply <<'JSON'\n{\"create\":[{\"type\":\"rectangle\"}]}\nJSON"
)

func TestParseCommandAccepts(t *testing.T) {
	for _, cmd := range []string{good, "  " + good + "\n", good + "\n\n"} {
		token, tool, args, ok := ParseCommand(cmd)
		if !ok {
			t.Fatalf("rejected %q", cmd)
		}
		if token != tok || tool != "apply" || string(args) != `{"create":[{"type":"rectangle"}]}` {
			t.Errorf("got %q %q %s", token, tool, args)
		}
	}
	multi := "curl -s --data-binary @- http://127.0.0.1:1/agent/" + tok + "/read_board <<'JSON'\n{\n  \"board\": \"b1\"\n}\nJSON"
	if _, tool, _, ok := ParseCommand(multi); !ok || tool != "read_board" {
		t.Errorf("multi-line JSON rejected")
	}
}

func TestParseCommandRejects(t *testing.T) {
	pre := "curl -s --data-binary @- http://127.0.0.1:4321/agent/" + tok
	body := " <<'JSON'\n{}\nJSON"
	cases := map[string]string{
		"another host":     "curl -s --data-binary @- http://example.com:4321/agent/" + tok + "/apply" + body,
		"localhost name":   "curl -s --data-binary @- http://localhost:4321/agent/" + tok + "/apply" + body,
		"missing heredoc":  pre + "/apply",
		"inline data":      "curl -s --data-binary '{}' http://127.0.0.1:4321/agent/" + tok + "/apply",
		"extra flag":       "curl -s -X POST --data-binary @- http://127.0.0.1:4321/agent/" + tok + "/apply" + body,
		"trailing flag":    pre + "/apply -o /tmp/x" + body,
		"semicolon rm":     pre + "/apply; rm -rf ~" + body,
		"and and":          pre + "/apply && rm -rf ~" + body,
		"pipe":             pre + "/apply | sh" + body,
		"command subst":    pre + "/$(whoami)" + body,
		"subst in url":     "curl -s --data-binary @- http://127.0.0.1:4321/agent/$(cat /etc/passwd)/apply" + body,
		"redirect":         pre + "/apply > /tmp/x" + body,
		"invalid json":     pre + "/apply <<'JSON'\n{not json}\nJSON",
		"empty json":       pre + "/apply <<'JSON'\n\nJSON",
		"unknown tool":     pre + "/rm_board" + body,
		"prototype tool":   pre + "/list_pages" + body,
		"after heredoc":    pre + "/apply" + body + "\nrm -rf ~",
		"two heredocs":     pre + "/apply" + body + "\n" + pre + "/apply" + body,
		"short token":      "curl -s --data-binary @- http://127.0.0.1:4321/agent/abc/apply" + body,
		"unquoted heredoc": pre + "/apply <<JSON\n{}\nJSON",
	}
	for name, cmd := range cases {
		if _, _, _, ok := ParseCommand(cmd); ok {
			t.Errorf("%s: accepted %q", name, cmd)
		}
	}
}
