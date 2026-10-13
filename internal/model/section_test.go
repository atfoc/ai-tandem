package model

import (
	"reflect"
	"strings"
	"testing"
)

// No view the local server makes and no file it writes has a field of a thing on another server:
// what is on another server is in that server's section, and nothing of it is kept here.
func TestSectionNoServerFields(t *testing.T) {
	gone := map[string]bool{"server": true, "gone": true, "unmoved": true, "moveError": true, "start": true, "was": true,
		"remoteStart": true, "draftReplaced": true}
	for _, v := range []any{ChatView{}, BranchState{}, Board{}, Defaults{}, GroupDefaults{}, ServerDefaults{},
		ChatMeta{}, Group{}} {
		typ := reflect.TypeOf(v)
		for _, f := range reflect.VisibleFields(typ) {
			name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
			if gone[name] {
				t.Errorf("%s.%s is written as %q", typ.Name(), f.Name, name)
			}
		}
	}
}
