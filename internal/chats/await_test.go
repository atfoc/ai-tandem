package chats

import (
	"testing"
	"time"
)

// AwaitStart waits for whoever holds the id's creation lock, a creation call or a removal, and
// leaves no lock behind; an id of another form makes no lock at all.
func TestAwaitStart(t *testing.T) {
	e := newEnv(t)
	unlock := e.m.ids.lock(idA) // as Start and a removal of this id hold it
	done := make(chan struct{})
	go func() {
		e.m.AwaitStart(idA)
		close(done)
	}()
	waitFor(t, "AwaitStart to wait on the creation lock", func() bool {
		e.m.ids.mu.Lock()
		defer e.m.ids.mu.Unlock()
		k := e.m.ids.m[idA]
		return k != nil && k.n == 2
	})
	select {
	case <-done:
		t.Fatal("AwaitStart returned while the creation lock was held")
	case <-time.After(50 * time.Millisecond):
	}
	// Another id does not wait, and neither does a string that is no chat id, which makes no
	// lock: not even while a lock of that very string is held.
	e.m.AwaitStart(idB)
	held := e.m.ids.lock("../../etc")
	for _, id := range []string{"", "x", "../../etc", idA + "\n", idA[:35], "{" + idA + "}"} {
		e.m.AwaitStart(id)
	}
	held()
	if n := e.m.ids.held(); n != 1 {
		t.Fatalf("%d creation locks, want the one that is held", n)
	}
	unlock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("AwaitStart did not return after the release")
	}
	if n := e.m.ids.held(); n != 0 {
		t.Fatalf("%d creation locks left", n)
	}
}

// A read that waited with AwaitStart finds the chat a creation call made.
func TestAwaitStartSeesTheStartedChat(t *testing.T) {
	e := newEnv(t)
	in, release := make(chan struct{}), make(chan struct{})
	req := e.startReq(idA, clientX)
	req.Place = func() (string, error) {
		close(in)
		<-release
		return gOne, nil
	}
	started := make(chan error, 1)
	go func() {
		_, err := e.m.Start(req)
		started <- err
	}()
	<-in
	if _, err := e.m.View(idA); err == nil {
		t.Fatal("the chat is there before the creation call made it")
	}
	read := make(chan error, 1)
	go func() {
		e.m.AwaitStart(idA)
		_, err := e.m.View(idA)
		read <- err
	}()
	select {
	case err := <-read:
		t.Fatalf("the read did not wait for the creation call: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if err := <-started; err != nil {
		t.Fatalf("the creation call: %v", err)
	}
	if err := <-read; err != nil {
		t.Fatalf("the read after the creation call: %v", err)
	}
}
