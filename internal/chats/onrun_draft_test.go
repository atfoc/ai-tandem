package chats

import (
	"errors"
	"testing"

	"ai-whiteboard/internal/model"
)

// A chat cannot be made on a run that will start on another server and has not started; on the
// same run once it has started, and on a draft run of this computer, it can.
func TestRunNotStartedRefusesAChat(t *testing.T) {
	e, _ := remoteEnv(t, model.Claude)
	fr := &fakeRuns{runs: map[string]RunInfo{}}
	e.m.Runs = fr
	far := RunInfo{Group: gOne, Cwd: farWork, Agent: model.Claude, Model: "far-1", Effort: "low", Server: entB, Draft: true}
	fr.set(ownRun, far)

	evs := e.listen()
	for _, n := range []NewChat{{Run: ownRun}, {Run: ownRun, Agent: model.Claude}, {Run: ownRun, Server: entB}, {Run: ownRun, Server: model.LocalServer}} {
		if _, err := e.m.CreateChat(n); !errors.Is(err, ErrRunNotStarted) {
			t.Errorf("CreateChat(%+v) on a draft of another server: %v", n, err)
		}
	}
	if _, err := e.m.CreateOnRun(model.Claude, ownRun); !errors.Is(err, ErrRunNotStarted) {
		t.Errorf("CreateOnRun on a draft of another server: %v", err)
	}
	if people, _ := e.m.ChatsOfRun(ownRun); len(people) != 0 {
		t.Fatalf("a refused creation left %v", people)
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("a refused creation sent %v", got)
	}

	// The archive mark of the run is told first, as for every run.
	archived := far
	archived.Archived = true
	fr.set(ownRun, archived)
	if _, err := e.m.CreateOnRun(model.Claude, ownRun); !errors.Is(err, ErrRunArchived) {
		t.Errorf("CreateOnRun on an archived draft of another server: %v", err)
	}

	// Started there: the chat is made, on the run's server.
	started := far
	started.Draft = false
	fr.set(ownRun, started)
	v, err := e.m.CreateOnRun(model.Claude, ownRun)
	if err != nil || v.Server != entB || v.Run != ownRun {
		t.Fatalf("a chat on a started run of another server: %+v %v", v, err)
	}

	// A draft of this computer takes a chat, as before.
	fr.set(ownRun, RunInfo{Group: gOne, Cwd: e.cwd, Agent: model.Claude, Model: "sonnet", Draft: true})
	if v, err := e.m.CreateOnRun(model.Claude, ownRun); err != nil || v.Server != "" {
		t.Fatalf("a chat on a draft of this computer: %+v %v", v, err)
	}
}
