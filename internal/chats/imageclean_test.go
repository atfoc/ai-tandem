package chats

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/testset"
)

// The cleanup that runs by itself (CleanImages): the rule holds for a chat nobody uploads to or
// types in again, and from the start of the server. cleanImages is one of its looks.

// The limits are the goal's: 5 MB an image, 10 images and 20 MB a message, 50 never-sent images a
// chat, and an hour.
func TestImageLimits(t *testing.T) {
	t.Parallel()
	if model.ImageMaxBytes != 5<<20 || model.ImagesPerMessage != 10 || model.ImagesMessageBytes != 20<<20 ||
		model.ImagesUnsentPerChat != 50 || imageWait != time.Hour {
		t.Fatalf("the limits: %d bytes an image, %d images and %d bytes a message, %d unsent a chat, kept %s",
			model.ImageMaxBytes, model.ImagesPerMessage, model.ImagesMessageBytes, model.ImagesUnsentPerChat, imageWait)
	}
	if !reflect.DeepEqual(model.ImageTypes, []string{"image/png", "image/jpeg", "image/gif", "image/webp"}) {
		t.Fatalf("the types: %v", model.ImageTypes)
	}
}

// With no upload and no draft save after it, an image that was never sent goes once no draft names
// it and its last use is more than an hour ago; never earlier, never one a draft of any branch
// names, never one a message holds.
func TestCleanImagesByItself(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.branched(model.Claude, "", "")
	other := e.create(model.Claude, gOne, "").ID
	const short, long = 59 * time.Minute, 2 * time.Minute // together more than the hour

	sent := e.upload(id, "sent") // a message on the branch holds it; the Send takes the branch's draft, so it comes first
	if _, err := e.m.SendMessage(id, &Target{Branch: exBranch, End: true}, Message{Text: "see", Images: []model.Image{sent}}); err != nil {
		t.Fatal(err)
	}
	orphan := e.upload(id, "orphan")           // never reached a draft
	far := e.upload(other, "orphan elsewhere") // in a chat nothing else is done in
	onMain, onBranch, dropped := e.upload(id, "main"), e.upload(id, "branch"), e.upload(id, "dropped")
	e.saveDraft(id, model.MainBranch, model.Draft{Text: "t", Images: []model.Image{onMain, dropped}})
	e.saveDraft(id, exBranch, model.Draft{Images: []model.Image{onBranch}})
	refused := e.upload(id, "refused")
	all := []model.Image{orphan, onMain, onBranch, dropped, refused, sent}
	held := func(when string, want ...model.Image) {
		t.Helper()
		for _, im := range all {
			wanted := false
			for _, w := range want {
				wanted = wanted || w.ID == im.ID
			}
			if e.holds(id, im.ID) != wanted {
				t.Fatalf("%s: %s held %v, want %v", when, im.Name, !wanted, wanted)
			}
		}
		// The folder and index.json say the same.
		if files, idx := e.imageFiles(id), e.imageIndex(id); len(files) != len(want) || len(idx) != len(want) {
			t.Fatalf("%s: %d files and %d entries, want %d", when, len(files), len(idx), len(want))
		}
	}

	e.later(short)
	e.m.cleanImages()
	held("within the hour", all...)
	if !e.holds(other, far.ID) {
		t.Fatal("within the hour: the other chat's image was deleted")
	}

	// The draft drops one image, and a Send of another is refused: both are uses, at this moment.
	e.saveDraft(id, model.MainBranch, model.Draft{Text: "t", Images: []model.Image{onMain}})
	if err := e.m.SetArchive(id, model.Archive{Archived: true}); err != nil {
		t.Fatal(err)
	}
	if err := e.sendPics(id, "look", refused); !errors.Is(err, ErrArchived) {
		t.Fatalf("a Send to an archived chat: %v", err)
	}
	if err := e.m.SetArchive(id, model.Archive{}); err != nil {
		t.Fatal(err)
	}
	e.m.cleanImages()
	held("at the moment a draft stopped naming an image", all...)

	// Past the hour of the upload: the orphans go, in both chats, by the cleanup alone.
	e.later(long)
	e.m.cleanImages()
	held("past the hour of the uploads", onMain, onBranch, dropped, refused, sent)
	if e.holds(other, far.ID) || e.imageFiles(other) == nil || len(e.imageFiles(other)) != 0 || len(e.imageIndex(other)) != 0 {
		t.Fatalf("past the hour: the other chat still holds %v", e.imageFiles(other))
	}
	if _, err := os.Stat(e.m.imagePath(id, orphan.ID)); !os.IsNotExist(err) {
		t.Fatalf("the orphan's file: %v", err)
	}

	// The dropped image and the refused Send's count from the drop and from the Send.
	e.later(short - long)
	e.m.cleanImages()
	held("within the hour of the drop and of the refused Send", onMain, onBranch, dropped, refused, sent)
	e.later(long)
	e.m.cleanImages()
	held("past the hour of the drop and of the refused Send", onMain, onBranch, sent)

	// What a draft names and what a message holds stay, however long nobody touches the chat. The
	// message is on another branch than the draft that named its image last.
	e.saveDraft(id, model.MainBranch, model.Draft{Images: []model.Image{onMain, sent}})
	e.saveDraft(id, model.MainBranch, model.Draft{Images: []model.Image{onMain}})
	for i := 0; i < 3; i++ {
		e.later(100 * time.Hour)
		e.m.cleanImages()
	}
	held("after three hundred hours", onMain, onBranch, sent)
	if _, data, err := e.m.Image(id, sent.ID); err != nil || !bytes.Equal(data, pic("sent")) {
		t.Fatalf("the sent image's bytes: %v", err)
	}
}

// The cap of fifty never-sent images is counted after the cleanup has run: once the cleanup that
// runs by itself has taken them, the chat takes fifty more.
func TestImageCapAfterCleanupByItself(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	for i := 0; i < model.ImagesUnsentPerChat; i++ {
		e.upload(id, strconv.Itoa(i))
	}
	if _, err := e.m.UploadImage(id, "over.png", "image/png", pic("over")); !errors.Is(err, ErrImageCap) {
		t.Fatalf("the upload past the cap: %v", err)
	}
	e.later(imageWait + time.Minute)
	e.m.cleanImages()
	if got := e.imageFiles(id); len(got) != 0 {
		t.Fatalf("after the cleanup the store holds %d images", len(got))
	}
	for i := 0; i < model.ImagesUnsentPerChat; i++ {
		e.upload(id, "second "+strconv.Itoa(i))
	}
	if _, err := e.m.UploadImage(id, "over.png", "image/png", pic("over")); !errors.Is(err, ErrImageCap) {
		t.Fatalf("the upload past the cap, the second time: %v", err)
	}
}

// Across a restart: the time of an image's last use and the drafts are known again before the
// cleanup looks, so it takes what is due and nothing a draft names. A chat on a run and a branch
// are among them.
func TestCleanImagesAfterRestart(t *testing.T) {
	t.Parallel()
	e, fr := runEnv(t)
	id, _ := e.branched(model.Claude, "", "")
	e.m.Runs = fr // branched restarted the manager
	onRun := e.onRun(model.Claude).ID

	orphan, dropped := e.upload(id, "orphan"), e.upload(id, "dropped")
	onMain, onBranch := e.upload(id, "main"), e.upload(id, "branch")
	e.saveDraft(id, model.MainBranch, model.Draft{Images: []model.Image{onMain, dropped}})
	e.saveDraft(id, exBranch, model.Draft{Text: "b", Images: []model.Image{onBranch}})
	e.saveDraft(id, model.MainBranch, model.Draft{Images: []model.Image{onMain}})
	runOrphan, runDraft := e.upload(onRun, "run orphan"), e.upload(onRun, "run draft")
	e.saveDraft(onRun, "", model.Draft{Text: "r", Images: []model.Image{runDraft}})

	e.later(30 * time.Minute)
	e.reboot(fr)
	e.m.cleanImages()
	for _, im := range []model.Image{orphan, dropped, onMain, onBranch} {
		if !e.holds(id, im.ID) {
			t.Fatalf("half an hour after its last use, after a restart, %s was deleted", im.Name)
		}
	}
	if !e.holds(onRun, runOrphan.ID) || !e.holds(onRun, runDraft.ID) {
		t.Fatal("half an hour after its last use, after a restart, an image of the chat on a run was deleted")
	}

	// The second half of the hour passes while the server is down. The cleanup of its start
	// takes what is due, with no upload and no draft save.
	e.reboot(fr)
	e.later(31 * time.Minute)
	e.m.cleanImages()
	if e.holds(id, orphan.ID) || e.holds(id, dropped.ID) || e.holds(onRun, runOrphan.ID) {
		t.Fatalf("past the hour, after a restart: the orphan held %v, the dropped image %v, the run chat's orphan %v",
			e.holds(id, orphan.ID), e.holds(id, dropped.ID), e.holds(onRun, runOrphan.ID))
	}
	if got, want := e.imageFiles(id), sortedIDs(onMain, onBranch); !reflect.DeepEqual(got, want) {
		t.Fatalf("the chat's folder holds %v, want the two images its drafts name", got)
	}
	if got := e.imageFiles(onRun); !reflect.DeepEqual(got, []string{runDraft.ID}) {
		t.Fatalf("the folder of the chat on a run holds %v, want the image its draft names", got)
	}

	// What the drafts name stays over any number of restarts, and the drafts still name it.
	for i := 0; i < 2; i++ {
		e.later(50 * time.Hour)
		e.reboot(fr)
		e.m.cleanImages()
	}
	if !e.holds(id, onMain.ID) || !e.holds(id, onBranch.ID) || !e.holds(onRun, runDraft.ID) {
		t.Fatalf("an image a draft names was deleted after a restart: main's held %v, the branch's %v, the run chat's %v",
			e.holds(id, onMain.ID), e.holds(id, onBranch.ID), e.holds(onRun, runDraft.ID))
	}
	if d := e.view(onRun).Draft; d == nil || d.Text != "r" || !reflect.DeepEqual(idsOf(d.Images), []string{runDraft.ID}) {
		t.Fatalf("the draft of the chat on a run after the restarts: %+v", d)
	}
	if d, _ := draftAt(e.chatObj(id), exBranch); d == nil || !reflect.DeepEqual(idsOf(d.Images), []string{onBranch.ID}) {
		t.Fatalf("the branch's draft after the restarts: %+v", d)
	}
}

// The drafts of a chat on a run are published when the chat is loaded, as every chat's are: the
// counter a page saves on is the stored one, and the cleanup knows what the drafts name.
func TestRunChatDraftsAfterRestart(t *testing.T) {
	t.Parallel()
	e, fr := runEnv(t)
	id := e.onRun(model.Claude).ID
	e.saveDraft(id, "", model.Draft{Text: "one"})
	e.saveDraft(id, "", model.Draft{Text: "two"})
	rev := e.draftRev(id, "")
	e.reboot(fr)
	if got := e.draftRev(id, ""); got != rev || rev != 2 {
		t.Fatalf("the draft's counter after a restart: %d, was %d", got, rev)
	}
	if drafts := draftsOf(e.chatObj(id)); len(drafts) != 1 || drafts[model.MainBranch] == nil || drafts[model.MainBranch].Text != "two" {
		t.Fatalf("the drafts the chat publishes after a restart: %+v", drafts)
	}
}

// A draft can stop naming an image with no save that says so: a Send takes the draft it was typed
// as, whatever the message names of its images. The image the message left out is not deleted at
// that moment, however old it is: it was in use until the cleanup last saw a draft name it, and
// goes an hour after that look.
func TestCleanImagesAfterASendTookTheDraft(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	sent, left := e.upload(id, "sent"), e.upload(id, "left out")
	e.saveDraft(id, "", model.Draft{Text: "look", Images: []model.Image{sent, left}})
	e.later(5 * time.Hour)
	e.m.cleanImages() // the look that sees the draft name both
	e.later(time.Minute)
	if err := e.sendPics(id, "look", sent); err != nil {
		t.Fatal(err)
	}
	if v := e.view(id); v.Draft != nil {
		t.Fatalf("the draft after the Send: %+v", v.Draft)
	}
	e.m.cleanImages()
	if !e.holds(id, left.ID) {
		t.Fatal("an image was deleted at the moment a Send took the draft that named it")
	}
	e.later(58 * time.Minute) // 59 minutes after the look that saw it named
	e.m.cleanImages()
	if !e.holds(id, left.ID) {
		t.Fatal("an image was deleted within the hour of the look that saw its draft name it")
	}
	// The time it counts from is in the index: a restart changes nothing.
	e.boot()
	e.later(2 * time.Minute)
	e.m.cleanImages()
	if e.holds(id, left.ID) || !e.holds(id, sent.ID) {
		t.Fatalf("past the hour: the image the message left out is held %v, the message's %v", e.holds(id, left.ID), e.holds(id, sent.ID))
	}
}

// A draft save is a use of the images it names and of the ones it drops, at the save itself and
// kept in the index. A save that names an image long due, which no cleanup has taken yet, keeps
// it: the cleanup the save runs does not take the image the save names. And an image a save
// dropped stays for the hour from the save over a restart, after which the cleanup no longer
// knows what it once saw a draft name.
func TestDraftSaveIsAUseOfItsImages(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	img := e.upload(id, "a")
	e.later(3 * time.Hour) // no cleanup has looked since: the image is there, and due
	if missing := e.saveDraft(id, "", model.Draft{Images: []model.Image{img}}); len(missing) != 0 {
		t.Fatalf("the save left out %v", missing)
	}
	if !e.holds(id, img.ID) {
		t.Fatal("the cleanup of a draft save took the image the save names")
	}
	if d := e.view(id).Draft; d == nil || !reflect.DeepEqual(idsOf(d.Images), []string{img.ID}) {
		t.Fatalf("the draft: %+v", d)
	}

	e.later(3 * time.Hour)
	e.saveDraft(id, "", model.Draft{Text: "without it"}) // the drop
	e.boot()
	e.m.cleanImages()
	if !e.holds(id, img.ID) {
		t.Fatal("after a restart an image was deleted at the first cleanup after the save that dropped it")
	}
	e.later(59 * time.Minute)
	e.m.cleanImages()
	if !e.holds(id, img.ID) {
		t.Fatal("after a restart an image was deleted within the hour of the save that dropped it")
	}
	e.later(2 * time.Minute)
	e.m.cleanImages()
	if e.holds(id, img.ID) {
		t.Fatal("an image a save dropped was kept past the hour")
	}
}

// What a write that was cut left in a chat's image folder goes with the cleanup, and nothing the
// store knows does.
func TestCleanupTakesLeftovers(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	img := e.upload(id, "a")
	dir := e.m.imagesDir(id)
	cut, unknown := "."+idOf(pic("cut"))+".tmp", idOf(pic("never indexed"))
	for _, name := range []string{cut, unknown} {
		if err := os.WriteFile(filepath.Join(dir, name), pic("half"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	e.m.cleanImages()
	if got := e.imageFiles(id); !reflect.DeepEqual(got, []string{img.ID}) {
		t.Fatalf("after the cleanup the folder holds %v, want the one image", got)
	}
	if e.holds(id, unknown) {
		t.Fatal("a file the index does not name is served as an image")
	}
	if _, data, err := e.m.Image(id, img.ID); err != nil || !bytes.Equal(data, pic("a")) {
		t.Fatalf("the image after the cleanup: %v", err)
	}
}

// An upload that cannot be finished leaves no image: when the index cannot be written the file
// that was written for it goes again, and the upload is taken once the fault is gone.
func TestImageUploadFailedLeavesNothing(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	first := e.upload(id, "first")
	// The index is written through a file of this name: a folder there, with something in it so
	// that it stays, makes every write of the index fail.
	block := filepath.Join(e.m.imagesDir(id), imageIndexFile+".tmp")
	if err := os.MkdirAll(filepath.Join(block, "x"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.UploadImage(id, "second.png", "image/png", pic("second")); err == nil {
		t.Fatal("an upload whose index could not be written was taken")
	}
	if e.holds(id, idOf(pic("second"))) {
		t.Fatal("the failed upload left an image the chat serves")
	}
	if _, err := os.Stat(e.m.imagePath(id, idOf(pic("second")))); !os.IsNotExist(err) {
		t.Fatalf("the failed upload left its file: %v", err)
	}
	if !e.holds(id, first.ID) {
		t.Fatal("the failed upload took another image")
	}
	if err := os.RemoveAll(block); err != nil {
		t.Fatal(err)
	}
	second := e.upload(id, "second")
	if got, want := e.imageFiles(id), sortedIDs(first, second); !reflect.DeepEqual(got, want) || len(e.imageIndex(id)) != 2 {
		t.Fatalf("after the fault was gone the store holds %v, want %v", got, want)
	}
}

// CleanImages is the cleanup for as long as the server runs: it looks at once, then again and
// again, and ends when it is stopped or the manager shuts down. The wait is lowered: a look
// every few milliseconds.
func TestCleanImagesRuns(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.m.ImageWait = 120 * time.Millisecond // of the managers' clock, which only this test moves
	id := e.create(model.Claude, gOne, "").ID
	orphan, drafted := e.upload(id, "orphan"), e.upload(id, "drafted")
	e.saveDraft(id, "", model.Draft{Images: []model.Image{drafted}})
	gone := func(image string) bool {
		_, err := os.Stat(e.m.imagePath(id, image))
		return os.IsNotExist(err)
	}

	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		e.m.CleanImages(stop)
	}()
	e.later(100 * time.Millisecond)
	time.Sleep(60 * time.Millisecond) // several looks
	if gone(orphan.ID) {
		t.Fatal("the image went within the wait")
	}
	e.later(30 * time.Millisecond)
	for deadline := time.Now().Add(20 * time.Second); !gone(orphan.ID); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the cleanup did not take an image that was due, with no upload and no draft save")
		}
	}
	if gone(drafted.ID) || !e.holds(id, drafted.ID) || e.holds(id, orphan.ID) {
		t.Fatal("the cleanup took the image a draft names, or the store still names the one it took")
	}
	close(stop)
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("CleanImages did not end when it was stopped")
	}

	// It ends with the manager too, and looks at once when it starts: what became due while
	// nothing ran goes at the start.
	late := e.upload(id, "late")
	e.later(time.Second)
	done = make(chan struct{})
	go func() {
		defer close(done)
		e.m.CleanImages(nil)
	}()
	for deadline := time.Now().Add(20 * time.Second); !gone(late.ID); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the cleanup did not look when it started")
		}
	}
	e.m.Shutdown()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("CleanImages did not end with the manager")
	}
}

// A fork that is still being made fills its store itself, file by file, and its index comes last:
// the cleanup leaves it alone until it is listed.
func TestCleanImagesLeavesAForkBeingMade(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.create(model.Claude, gOne, "").ID
	img := e.upload(id, "a")
	c := e.chatObj(id)
	e.later(2 * imageWait)
	c.mu.Lock()
	c.unlisted = true // as a fork is until its copy is whole
	c.mu.Unlock()
	e.m.cleanImages()
	if !e.holds(id, img.ID) {
		t.Fatal("the cleanup took an image of a chat that is still being made")
	}
	c.mu.Lock()
	c.unlisted = false
	c.mu.Unlock()
	e.m.cleanImages()
	if e.holds(id, img.ID) {
		t.Fatal("the cleanup left an image that was due")
	}
}

// The cleanup runs by itself, a look every millisecond, while everything else goes on in the
// chats: a Send, a save of the emptied draft, an upload, a fork and a delete at the same time. No
// message loses its image, no fork lacks the image of its draft, and a deleted chat's folder is
// not made again.
func TestCleanImagesWithEverythingElse(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.m.ImageWait = 12 * time.Millisecond // of the managers' clock, which only this test moves, by hours
	rounds := 6
	if testset.Full() {
		rounds = 40
	}
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		e.m.CleanImages(stop)
	}()
	defer func() {
		close(stop)
		<-done
	}()

	for round := 0; round < rounds; round++ {
		tag := strconv.Itoa(round)
		id := e.create(model.Claude, gOne, "").ID
		first := e.upload(id, "first"+tag)
		ag := e.picTurn(id, nil, 1, "first", first) // items 0..2
		e.m.naming.Wait()
		second := e.upload(id, "second"+tag)
		e.saveDraft(id, "", model.Draft{Text: "look", Images: []model.Image{second}})
		rev := e.draftRev(id, "")
		doomed := e.create(model.Claude, gOne, "").ID
		e.upload(doomed, "doomed"+tag)
		doomedDir := e.m.chatDir(doomed)
		e.later(time.Hour) // only the draft keeps the second image now, and the doomed chat's is due

		var wg sync.WaitGroup
		var sendErr, forkErr, delErr error
		var fork model.ChatView
		wg.Add(5)
		go func() {
			defer wg.Done()
			sendErr = e.sendPics(id, "look", second)
		}()
		go func() { // the composer saves its emptied draft while the Send may still run
			defer wg.Done()
			e.m.SaveDraft(id, "", rev, model.Draft{})
		}()
		go func() {
			defer wg.Done()
			e.m.UploadImage(id, "other.png", "image/png", pic("other"+tag))
		}()
		go func() { // fork and edit of the first message: its image becomes the fork's draft's
			defer wg.Done()
			msg := 0
			fork, forkErr = e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: 0, Message: &msg})
		}()
		go func() {
			defer wg.Done()
			delErr = e.m.Delete(doomed)
		}()
		wg.Wait()
		if sendErr != nil || delErr != nil {
			t.Fatalf("round %d: the Send: %v, the delete: %v", round, sendErr, delErr)
		}
		if forkErr != nil && !errors.Is(forkErr, ErrBusy) && !errors.Is(forkErr, ErrBadPoint) {
			t.Fatalf("round %d: the fork: %v", round, forkErr)
		}
		ag.emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p2"}) // the rounds stay under the cap on working chats
		e.later(time.Hour)
		e.m.cleanImages() // a look for certain, with every image long due
		for name, im := range map[string]model.Image{"first": first, "second": second} {
			if _, data, err := e.m.Image(id, im.ID); err != nil || !bytes.Equal(data, pic(name+tag)) {
				t.Fatalf("round %d: the %s image of a message is gone: %v", round, name, err)
			}
		}
		if e.holds(id, idOf(pic("other"+tag))) {
			t.Fatalf("round %d: the image nothing names was kept", round)
		}
		var withSecond bool
		for _, it := range e.items(id) {
			withSecond = withSecond || it.Kind == "user" && reflect.DeepEqual(idsOf(it.Images), []string{second.ID})
		}
		if !withSecond {
			t.Fatalf("round %d: the thread lacks the message with its image: %+v", round, e.items(id))
		}
		if forkErr == nil {
			if d := fork.Draft; d == nil || !reflect.DeepEqual(idsOf(d.Images), []string{first.ID}) {
				t.Fatalf("round %d: the fork's draft %+v", round, d)
			}
			if _, data, err := e.m.Image(fork.ID, first.ID); err != nil || !bytes.Equal(data, pic("first"+tag)) {
				t.Fatalf("round %d: the fork lacks the image of its draft: %v", round, err)
			}
		}
		if _, err := os.Stat(doomedDir); !os.IsNotExist(err) {
			t.Fatalf("round %d: the folder of the deleted chat: %v", round, err)
		}
	}
}
