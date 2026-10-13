package server

import (
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
)

// What is checked here of the images a draft save or a message of a section's chat names,
// before the body is passed on to the chat's server (section.go). Through the routes:
// TestImageCallsOfASectionArePassedOn.

// checkedImages is the one check of the image ids of a body that is passed on to a chat's
// server, a message's or a draft's: it reads the images as the server that decodes the body
// does, under "images" in any case, and every spelling the body has. formed says whether a Send
// with the body goes on: every id has the form of one, and the images can be read.
func TestCheckedImagesFormed(t *testing.T) {
	t.Parallel()
	good := strings.Repeat("ab", 32)
	for body, want := range map[string]bool{
		`{"text":"hi"}`:                                                             true,
		`{"text":"hi","images":[]}`:                                                 true,
		`{"text":"hi","images":null}`:                                               true,
		`{"images":[{"id":"` + good + `"}]}`:                                        true,
		`{"images":[{"ID":"` + good + `"}]}`:                                        true,
		`{"images":[{"id":"` + good + `x"}]}`:                                       false,
		`{"images":[{"id":""}]}`:                                                    false,
		`{"images":[{"name":"a.png"}]}`:                                             false,
		`{"Images":[{"id":"../x"}],"images":[]}`:                                    false,
		`{"images":[{"id":"../x"}],"Images":[{"id":"` + good + `"}]}`:               false,
		`{"Images":"` + good + `","images":[]}`:                                     false,
		`{"images":[{"id":"` + good + `"},"x"]}`:                                    false,
		`{"images":{"id":"` + good + `"}}`:                                          false,
		`{"images":"` + good + `"}`:                                                 false,
		`{"images":[{"id":"` + good + `"},{"id":"` + strings.ToUpper(good) + `"}]}`: false,
		`not json`: true,
		`[1,2]`:    true,
	} {
		out, _, bad, err := checkedImages([]byte(body))
		if got := err == nil && len(bad) == 0; got != want {
			t.Errorf("checkedImages(%s): formed %v, want %v (bad %q, err %v)", body, got, want, bad, err)
		}
		if err == nil && strings.Contains(string(out), "../x") {
			t.Errorf("checkedImages(%s) passes an id of another form on: %s", body, out)
		}
	}
	// What goes on is one "images" with the good ones the decoding server takes, and bad names
	// each id of another form once, in the order they were named, a shadowed spelling's last.
	out, named, bad, err := checkedImages([]byte(`{"IMAGES":[{"id":"../y"}],"text":"t","images":[{"id":"../x"},{"id":"` + good + `"},{"id":"../x"},{"id":"Z"}]}`))
	if err != nil || string(out) != `{"images":[{"id":"`+good+`","name":"","type":"","size":0}],"text":"t"}` {
		t.Errorf("the body that is passed on: %s (%v)", out, err)
	}
	if len(named) != 4 || !reflect.DeepEqual(bad, []string{"../x", "Z", "../y"}) {
		t.Errorf("named %+v, bad %q", named, bad)
	}
}

// chats.FormedImages and withMissing are the one way an id of another form is left out of a
// draft save and named: the answer's "missing" has the ids left out here and those that server
// left out, each once, in the order the save named them, and then what that server names beside
// them.
func TestMissingIsJoinedInOnePlace(t *testing.T) {
	t.Parallel()
	a, b, c := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)
	named := []model.Image{{ID: "bad"}, {ID: a}, {ID: "../x"}, {ID: b}, {ID: "bad"}}
	good, bad := chats.FormedImages(named)
	if !reflect.DeepEqual(good, []model.Image{{ID: a}, {ID: b}}) || !reflect.DeepEqual(bad, []string{"bad", "../x"}) {
		t.Fatalf("FormedImages: good %+v, bad %q", good, bad)
	}
	if good, bad := chats.FormedImages([]model.Image{{ID: "bad"}}); good != nil || !reflect.DeepEqual(bad, []string{"bad"}) {
		t.Errorf("FormedImages of a bad id alone: %+v %q", good, bad)
	}
	reply := func(status int, body string) remotes.Reply { return remotes.Reply{Status: status, Body: []byte(body)} }
	for _, tc := range []struct {
		name string
		rep  remotes.Reply
		bad  []string
		want string
	}{
		{"that server left one out too", reply(200, `{"ok":true,"rev":3,"missing":["`+b+`","`+c+`"]}`), bad, `{"missing":["bad","../x","` + b + `","` + c + `"],"ok":true,"rev":3}`},
		{"that server left none out", reply(200, `{"ok":true,"rev":3}`), bad, `{"missing":["bad","../x"],"ok":true,"rev":3}`},
		{"no id of another form", reply(200, `{"ok":true,"rev":3,"missing":["`+b+`"]}`), nil, `{"ok":true,"rev":3,"missing":["` + b + `"]}`},
		{"a refusal", reply(409, `{"error":"stale","code":"stale","rev":7,"draft":null}`), bad, `{"error":"stale","code":"stale","rev":7,"draft":null}`},
		{"an answer that is no object", reply(200, `[1]`), bad, `[1]`},
	} {
		if got := withMissing(tc.rep, named, tc.bad); got.Status != tc.rep.Status || string(got.Body) != tc.want {
			t.Errorf("%s: %d %s, want %s", tc.name, got.Status, got.Body, tc.want)
		}
	}
}
