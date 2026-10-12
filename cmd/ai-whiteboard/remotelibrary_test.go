package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/library"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/linksim"
)

// The prompt library of another server, between two server processes: what the program wires
// (the library of each server in its data folder, the copy A's relay keeps of B's, the events of
// the server list that tell A of a new name) and what only a process shows: nothing of B's
// library survives a restart of A. The cases one by one are in internal/server
// (libraryremote_test.go), with both servers in one process, and in internal/remotes.

// libraries is A's list of the libraries, as its page reads it.
func (rp *remotePair) libraries(t *testing.T) []library.View {
	t.Helper()
	var l struct{ Libraries []library.View }
	rp.a.must(t, pairPage, "GET", "/api/library", nil, &l)
	return l.Libraries
}

// libraryThere is B's library on A; ok is false when A shows none.
func (rp *remotePair) libraryThere(t *testing.T) (library.View, bool) {
	t.Helper()
	for _, v := range rp.libraries(t) {
		if v.Server == rp.entry {
			return v, true
		}
	}
	return library.View{}, false
}

// promptNames lists the prompts of a library as "name=text", in their order.
func promptNames(v library.View) string {
	var out []string
	for _, p := range v.Prompts {
		out = append(out, p.Name+"="+p.Text)
	}
	return strings.Join(out, " | ")
}

func TestRemoteLibraryBetweenTwoServers(t *testing.T) {
	serverTest(t, "TestRemoteLibraryIsShown, TestRemoteLibraryIsChangedFromHere, TestRemoteLibraryOfAServerThatDrops (internal/server)", "TestLibraryCopyIsInMemoryOnly (internal/remotes)")
	rp := startRemotePairIn(t, linksim.Good, "", []string{fast.env(t, "silence", "backoff")})
	const pageOfB = "page-of-b"
	bPage := watch(t, http.DefaultClient, strings.TrimSuffix(rp.b.in.url, "/"), pageOfB, nil)
	defer bPage.close()

	// Without a remote server in the list there is this computer's library and no other.
	if l := rp.libraries(t); len(l) != 1 || l[0].Server != servers.LocalID {
		t.Fatalf("A's libraries without a server: %+v", l)
	}
	// B's owner has a prompt before A knows B.
	var made struct{ Prompt library.Prompt }
	rp.b.must(t, pageOfB, "POST", "/api/library/local/prompts", map[string]any{"name": "review", "text": "Look at it."}, &made)
	mark := rp.page.mark()
	rp.addEntry(t)
	rp.page.awaitEvent(t, mark, 20*time.Second, "library", `"server":"`+rp.entry+`"`, `"name":"`+pairName+`"`, `"connected":true`, `"review"`)
	if v, ok := rp.libraryThere(t); !ok || !v.Connected || v.Name != pairName || promptNames(v) != "review=Look at it." {
		t.Fatalf("B's library on A: %+v (there: %v)", v, ok)
	}
	path := "/api/library/" + rp.entry

	// A change from A is made on B: B's own page is told, and A's page before its call returns.
	mark, bMark := rp.page.mark(), bPage.mark()
	var mine struct{ Prompt library.Prompt }
	if a := rp.ok(t, "POST", path+"/prompts", map[string]any{"name": "commit", "text": "Write it.\n"}); json.Unmarshal([]byte(a.Raw), &mine) != nil || mine.Prompt.Text != "Write it.\n" {
		t.Fatalf("the prompt A's page got: %s", a)
	}
	if v, _ := rp.libraryThere(t); promptNames(v) != "review=Look at it. | commit=Write it.\n" {
		t.Fatalf("B's library on A after the call: %+v", v)
	}
	rp.page.awaitEvent(t, mark, 10*time.Second, "library", `"server":"`+rp.entry+`"`, `"commit"`)
	bPage.awaitEvent(t, bMark, 10*time.Second, "library", `"server":"local"`, `"commit"`)
	// A change of B's owner arrives at A's page by itself.
	mark = rp.page.mark()
	rp.b.must(t, pageOfB, "PATCH", "/api/library/local/prompts/"+made.Prompt.ID, map[string]any{"text": "Look twice."}, nil)
	rp.page.awaitEvent(t, mark, 10*time.Second, "library", `"server":"`+rp.entry+`"`, `Look twice.`)
	// B refuses what breaks a rule, with its sentence.
	if a := rp.refused(t, http.StatusConflict, library.CodeNameTaken, "POST", path+"/prompts", map[string]any{"name": "Commit", "text": ""}); !strings.Contains(a.Raw, `There is already a prompt called \"commit\"`) {
		t.Fatalf("the refusal: %s", a)
	}

	// The server gets another name in A's list.
	mark = rp.page.mark()
	rp.ok(t, "PATCH", "/api/servers/"+rp.entry, map[string]any{"name": "Workshop"})
	rp.page.awaitEvent(t, mark, 10*time.Second, "library", `"server":"`+rp.entry+`"`, `"name":"Workshop"`)

	// B stops: its prompts stay on A, marked, and cannot be changed.
	mark = rp.page.mark()
	rp.b.stop(t)
	rp.page.awaitEvent(t, mark, 40*time.Second, "library", `"server":"`+rp.entry+`"`, `"connected":false`, `"commit"`)
	if v, ok := rp.libraryThere(t); !ok || v.Connected || promptNames(v) != "review=Look twice. | commit=Write it.\n" {
		t.Fatalf("B's library on A while B is down: %+v (there: %v)", v, ok)
	}
	rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", "DELETE", path+"/prompts/"+mine.Prompt.ID, nil)

	// A restarts while B is down: nothing of B's library is kept, in memory or in a file.
	rp.a.stop(t)
	err := filepath.WalkDir(rp.a.home, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if b, _ := os.ReadFile(p); strings.Contains(string(b), "Look twice.") || strings.Contains(string(b), "Write it.") {
			t.Errorf("A's file %s holds a prompt of B", p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	rp.a.start(t)
	rp.page = watch(t, http.DefaultClient, strings.TrimSuffix(rp.a.in.url, "/"), pairPage, nil)
	rp.waitState(t, servers.StateUnreachable, 20*time.Second)
	if l := rp.libraries(t); len(l) != 1 || l[0].Server != servers.LocalID {
		t.Fatalf("A's libraries after its restart, with B down: %+v", l)
	}
	rp.refused(t, http.StatusNotFound, "no_server", "POST", path+"/prompts", map[string]any{"name": "x", "text": ""})

	// B is back, with its library from its file: A shows it again, and can change it.
	mark = rp.page.mark()
	rp.b.up(t)
	rp.back(t, 45*time.Second)
	rp.page.awaitEvent(t, mark, 20*time.Second, "library", `"server":"`+rp.entry+`"`, `"name":"Workshop"`, `"connected":true`, `Look twice.`)
	rp.ok(t, "DELETE", path+"/prompts/"+mine.Prompt.ID, nil)
	if v, _ := rp.libraryThere(t); promptNames(v) != "review=Look twice." {
		t.Fatalf("B's library on A after the delete: %+v", v)
	}

	// Removed from the list, the server takes its library along.
	mark = rp.page.mark()
	rp.ok(t, "DELETE", "/api/servers/"+rp.entry, nil)
	rp.page.awaitEvent(t, mark, 10*time.Second, "library_removed", rp.entry)
	if l := rp.libraries(t); len(l) != 1 || l[0].Server != servers.LocalID || len(l[0].Prompts) != 0 {
		t.Fatalf("A's libraries after the removal: %+v", l)
	}
}
