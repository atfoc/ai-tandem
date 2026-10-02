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
		if !IsTool(tool.Name) {
			t.Errorf("%s: IsTool says no", tool.Name)
		}
	}
	if IsTool("rm_rf") {
		t.Error("IsTool accepted an unknown tool")
	}
}
