// Images in chats: the pictures a person attaches to a message (not a picture of a board, which
// is get_image's).
//
// A top-level chat has one image store, shared by its branches: the folder images/ in the chat's
// own, with one file per image, named by the image's id, and index.json, which says of each image
// its type, its size, whether it was sent and when it was last used. An id is the SHA-256 of the
// bytes, so the same picture is one image and an id never names other bytes; a file is written
// once and never changed. A draft and a message hold an image by id, name, type and size, never
// its bytes: those leave the store only as the image blocks of the one Send that carries them.
//
// An image is deleted in one place, sweepImages, by one rule: it was never sent, no draft of any
// branch names it, no Send holds it, and it was last used longer ago than Manager.imageWait (an
// hour). Uploading it, uploading it again, a draft save that names it or drops it and a Send that
// names it count as use. An image that was sent stays until its chat is deleted, which removes
// the folder.
//
// The cleanup runs by itself, over every chat: when the server starts and then twelve times in
// the wait, every five minutes (CleanImages). So the rule holds for a chat nobody touches again,
// and after a restart: the time of an image's last use is in index.json. An upload and a draft
// save that names or drops an image run it for their chat as well, the upload before it counts
// the images that were never sent.
package chats

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// imageWait is how long an image that was never sent and that no draft names is kept after its
// last use (Deps.ImageWait lowers it for a test).
const imageWait = time.Hour

// DefaultImageWait is imageWait, for a test of real server processes, which lowers the wait by
// its name (AIWB_TEST_WAITS) and divides the production value.
const DefaultImageWait = imageWait

// imageSweeps is how many times in one imageWait the cleanup looks at every chat (CleanImages):
// every five minutes of the hour. An image that is due goes at the next of them.
const imageSweeps = 12

// imageNameMax is the most characters the name of an image has.
const imageNameMax = 200

// imageIndexFile is the file of an image store that is no image.
const imageIndexFile = "index.json"

// The refusals of the image calls. Each has a sentence of its own for the person and is one of
// these to errors.Is; the HTTP API gives each its code.
var (
	ErrImageTooLarge = errors.New("the image is too large")                            // image_too_large
	ErrImageType     = errors.New("the image is of a type a chat does not take")       // image_type
	ErrImageCap      = errors.New("the chat holds too many images that were not sent") // image_cap
	ErrImageID       = errors.New("an image id is 64 lower-case hex digits")           // image_id
	ErrImageMissing  = errors.New("the chat does not hold the image")                  // image_missing
	ErrImageLimit    = errors.New("the message has too many images")                   // image_limit
	ErrImageModel    = errors.New("the model takes no images")                         // image_model
	// ErrNoImage is the answer of a fetch of an image the chat does not hold.
	ErrNoImage = errors.New("no such image")
)

// imageErr is a refusal of an image call: text is its sentence, kind the error it is to errors.Is.
type imageErr struct {
	kind error
	text string
}

func (e imageErr) Error() string        { return e.text }
func (e imageErr) Is(target error) bool { return target == e.kind }

// MissingImages is the ErrImageMissing of a Send: the images it named that the chat does not hold.
type MissingImages struct{ IDs []string }

func (e *MissingImages) Error() string {
	if len(e.IDs) == 1 {
		return "the chat no longer holds one of the message's images: add it again"
	}
	return fmt.Sprintf("the chat no longer holds %d of the message's images: add them again", len(e.IDs))
}

func (e *MissingImages) Is(target error) bool { return target == ErrImageMissing }

var imageID = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ValidImageID reports whether id has the form of an image id. An id from outside is checked
// with it before anything is looked up by it.
func ValidImageID(id string) bool { return imageID.MatchString(id) }

// FormedImages splits the images a draft or a message names by the form of their ids: good are
// those whose id has the form of one, in their order (nil for none), and bad the ids of the
// others, each once. It is the one check of the images a server passes on to another server:
// an id of another form goes nowhere, and the caller says which were left out.
func FormedImages(named []model.Image) (good []model.Image, bad []string) {
	for _, im := range named {
		switch {
		case ValidImageID(im.ID):
			good = append(good, im)
		case !slices.Contains(bad, im.ID):
			bad = append(bad, im.ID)
		}
	}
	return good, bad
}

// sniffImage is the type of the image b is, found from its first bytes alone: one of
// model.ImageTypes, "" for anything else.
func sniffImage(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(b, []byte("\xff\xd8\xff")):
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return "image/gif"
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp"
	}
	return ""
}

// cleanImageName is the name of an image as the server keeps it: without control characters, cut
// to imageNameMax characters, and model.ImageWord when nothing is left. It is only ever shown.
func cleanImageName(name string) string {
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.ToValidUTF8(name, "")))
	if r := []rune(name); len(r) > imageNameMax {
		name = strings.TrimSpace(string(r[:imageNameMax]))
	}
	if name == "" {
		return model.ImageWord
	}
	return name
}

// imageEntry is what an image store knows of one image.
type imageEntry struct {
	Type string `json:"type"` // found from the bytes: one of model.ImageTypes
	Size int64  `json:"size"`
	// Sent is set when a message that holds the image enters a thread of the chat, and never
	// taken back: from then on the image stays until the chat is deleted.
	Sent bool      `json:"sent,omitempty"`
	Used time.Time `json:"used"` // the last use, which the cleanup counts from
}

// imageIndex is index.json of an image store.
type imageIndex struct {
	Images map[string]*imageEntry `json:"images"`
}

// imageStore is the image store of a top-level chat (Chat.imgs) as the manager holds it. mu
// guards the rest, the folder's files included. It is a leaf lock: taken with a chat's mu held
// (the branch's a message goes to, or the top-level chat's) or with none, and no lock is taken
// under it. What the chat's drafts name is read under it from what the chat publishes
// (Chat.drafts), without the chat's mu.
type imageStore struct {
	mu     sync.Mutex
	loaded bool                   // idx is the folder's (see loadImages)
	idx    map[string]*imageEntry // by image id
	pins   map[string]int         // the Sends that hold each image (see takeImages); never saved
	// named are the images the chat's drafts named when the cleanup last looked at the store,
	// and looked is when that was (see sweepImages); never saved.
	named  map[string]bool
	looked time.Time
}

func (m *Manager) imageWaitNow() time.Duration {
	if m.ImageWait > 0 {
		return m.ImageWait
	}
	return imageWait
}

func (m *Manager) imagesDir(chat string) string { return filepath.Join(m.chatDir(chat), "images") }

func (m *Manager) imagePath(chat, image string) string {
	return filepath.Join(m.imagesDir(chat), image)
}

// loadImages reads the image store of the top-level chat top, whose id is chat, the first time
// it is needed. A chat without the folder has no images, and none is made here. An index that is
// missing or cannot be read is made again from the files, each as an image that was sent: what
// the store cannot account for is never deleted. top.imgs.mu held.
func (m *Manager) loadImages(top *Chat, chat string) {
	s := &top.imgs
	if s.loaded {
		return
	}
	s.loaded, s.idx, s.pins = true, map[string]*imageEntry{}, map[string]int{}
	dir := m.imagesDir(chat)
	raw, err := os.ReadFile(filepath.Join(dir, imageIndexFile))
	var f imageIndex
	if err == nil {
		err = json.Unmarshal(raw, &f)
	}
	if err == nil {
		for id, e := range f.Images {
			if ValidImageID(id) && e != nil && slices.Contains(model.ImageTypes, e.Type) {
				s.idx[id] = e
			}
		}
		return
	}
	ents, derr := os.ReadDir(dir)
	if derr != nil {
		return // no folder: no images
	}
	if !errors.Is(err, fs.ErrNotExist) {
		log.Printf("chats: images of %s: %v", chat, err)
	}
	for _, ent := range ents {
		if !ValidImageID(ent.Name()) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, ent.Name()))
		if typ := sniffImage(b); err == nil && typ != "" {
			s.idx[ent.Name()] = &imageEntry{Type: typ, Size: int64(len(b)), Sent: true, Used: m.now()}
		}
	}
}

// saveImages writes index.json of top's image store. Nothing is written for a chat that was
// deleted (closeImages keeps the two apart), and no folder is made for a store without images.
// top.imgs.mu held.
func (m *Manager) saveImages(top *Chat, chat string) error {
	if top.gone.Load() {
		return ErrNotFound
	}
	dir := m.imagesDir(chat)
	if len(top.imgs.idx) == 0 {
		if _, err := os.Lstat(dir); errors.Is(err, fs.ErrNotExist) {
			return nil
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return store.WriteJSONAtomic(filepath.Join(dir, imageIndexFile), imageIndex{Images: top.imgs.idx}, 0o600)
}

// closeImages waits for whatever is writing in the image store of the chat object top, which was
// retired: nothing is written there afterwards (saveImages and the others look at Chat.gone under
// the store's lock), so the caller can remove the chat's folder for good.
func (m *Manager) closeImages(top *Chat) {
	top.imgs.mu.Lock()
	top.imgs.mu.Unlock()
}

// sweepImages is the cleanup, the one place an image of a chat that stays is deleted: every image
// of top's store that was never sent, that no draft of any branch names, that no Send holds and
// that was last used more than the wait before now. A file of the folder the store does not know
// (what a write that failed left) goes too. It reports whether the index changed.
//
// An image is never deleted at the moment a draft stops naming it, whoever changed the draft: one
// that a draft named when the cleanup last looked, and that none names now, was in use until
// that look at least, and counts as used then. A draft save says of the images it drops that
// they were used at that moment (draftImages); this is for a draft that goes another way: removed
// by a Send that did not carry its images (dropDraft).
// top.imgs.mu held, the store loaded.
func (m *Manager) sweepImages(top *Chat, chat string, now time.Time) (changed bool) {
	s := &top.imgs
	named := map[string]bool{}
	for _, d := range draftsOf(top) {
		for _, im := range d.Images {
			named[im.ID] = true
		}
	}
	for id := range s.named {
		if e := s.idx[id]; e != nil && !named[id] && e.Used.Before(s.looked) {
			e.Used, changed = s.looked, true
		}
	}
	s.named, s.looked = named, now
	wait := m.imageWaitNow()
	for id, e := range s.idx {
		if e.Sent || named[id] || s.pins[id] > 0 || now.Sub(e.Used) <= wait {
			continue
		}
		if err := os.Remove(m.imagePath(chat, id)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			log.Printf("chats: images of %s: %v", chat, err)
			continue
		}
		delete(s.idx, id)
		changed = true
	}
	ents, _ := os.ReadDir(m.imagesDir(chat))
	for _, ent := range ents {
		name := ent.Name()
		if name == imageIndexFile || name == imageIndexFile+".tmp" || s.idx[name] != nil {
			continue
		}
		os.Remove(filepath.Join(m.imagesDir(chat), name))
	}
	return changed
}

// CleanImages runs the cleanup over every chat, at once and then imageSweeps times in the wait,
// for as long as the server runs: it blocks until stop is closed (nil = never) or Shutdown has
// begun. With it the rule of the cleanup holds for a chat nobody uploads to or types in again,
// and from the start of the server for what was left before it stopped.
func (m *Manager) CleanImages(stop <-chan struct{}) {
	t := time.NewTicker(max(m.imageWaitNow()/imageSweeps, time.Millisecond))
	defer t.Stop()
	for !m.down.Load() {
		m.cleanImages()
		select {
		case <-stop:
			return
		case <-t.C:
		}
	}
}

// cleanImages runs the cleanup once in every top-level chat. A chat that
// has no image the cleanup could ever take, which is nearly every chat, costs nothing after the
// first time, when its store is read.
func (m *Manager) cleanImages() {
	for _, c := range m.all() {
		if c.top != nil {
			continue
		}
		c.mu.Lock()
		id, skip := c.meta.ID, c.unlisted || c.deleted // a fork still being made fills its store itself (forkImages)
		c.mu.Unlock()
		if !skip {
			m.cleanImagesOf(c, id)
		}
	}
}

// cleanImagesOf runs the cleanup in the store of the top-level chat top, whose id is chat, when
// the store has an image that was never sent, and writes the index when it changed.
func (m *Manager) cleanImagesOf(top *Chat, chat string) {
	s := &top.imgs
	s.mu.Lock()
	defer s.mu.Unlock()
	if top.gone.Load() {
		return
	}
	m.loadImages(top, chat)
	unsent := false
	for _, e := range s.idx {
		unsent = unsent || !e.Sent
	}
	if !unsent || !m.sweepImages(top, chat, m.now()) {
		return
	}
	if err := m.saveImages(top, chat); err != nil && !errors.Is(err, ErrNotFound) {
		log.Printf("chats: images of %s: %v", chat, err)
	}
}

// uploadable returns the top-level chat id when it takes images: who may upload to a chat is who
// may save its draft, so ErrNotFound for an id that is no chat's.
func (m *Manager) uploadable(id string) (*Chat, error) {
	top, err := m.lockTop(id)
	if err != nil {
		return nil, err
	}
	top.mu.Unlock()
	return top, nil
}

// ImageUploadable says whether the chat id takes an upload at all (see uploadable), for a caller
// that asks before it reads the upload's bytes.
func (m *Manager) ImageUploadable(id string) error {
	_, err := m.uploadable(id)
	return err
}

// UploadImage puts an image into the store of the top-level chat id and returns it as a draft
// holds it. data is the whole image, name what the page calls it (see cleanImageName) and stated
// the type the upload says it is. The type is found from the bytes: an upload that is none of
// model.ImageTypes, or that states another type than its bytes are, is refused (ErrImageType),
// as is one over model.ImageMaxBytes (ErrImageTooLarge).
//
// The same bytes are one image: uploading them again changes nothing but the time of the image's
// last use. A new image is refused (ErrImageCap) when the chat holds model.ImagesUnsentPerChat
// images that were never sent, counted after the cleanup has run (sweepImages). An upload that
// is refused leaves nothing in the store.
func (m *Manager) UploadImage(id, name, stated string, data []byte) (model.Image, error) {
	none := model.Image{}
	top, err := m.uploadable(id)
	if err != nil {
		return none, err
	}
	if len(data) > model.ImageMaxBytes {
		return none, imageErr{ErrImageTooLarge, fmt.Sprintf("the image is larger than %d MB", model.ImageMaxBytes>>20)}
	}
	typ := sniffImage(data)
	if typ == "" {
		return none, imageErr{ErrImageType, "the file is not a PNG, JPEG, GIF or WebP image"}
	}
	if mt, _, err := mime.ParseMediaType(stated); err != nil || mt != typ {
		return none, imageErr{ErrImageType, fmt.Sprintf("the file is %s, and it was uploaded as %q", typ, stated)}
	}
	sum := sha256.Sum256(data)
	img := model.Image{ID: hex.EncodeToString(sum[:]), Name: cleanImageName(name), Type: typ, Size: int64(len(data))}

	now := m.now()
	s := &top.imgs
	s.mu.Lock()
	defer s.mu.Unlock()
	if top.gone.Load() {
		return none, ErrNotFound
	}
	m.loadImages(top, id)
	path := m.imagePath(id, img.ID)
	e := s.idx[img.ID]
	if e != nil {
		if _, err := os.Lstat(path); err != nil {
			e = nil // its file is gone: the upload brings it back
		}
	}
	if e != nil {
		e.Used = now // before the cleanup: an upload is a use
	}
	m.sweepImages(top, id, now)
	if e != nil {
		return img, m.saveImages(top, id)
	}
	unsent := 0
	for other, x := range s.idx {
		if !x.Sent && other != img.ID {
			unsent++
		}
	}
	if unsent >= model.ImagesUnsentPerChat {
		if err := m.saveImages(top, id); err != nil {
			log.Printf("chats: images of %s: %v", id, err)
		}
		return none, imageErr{ErrImageCap, fmt.Sprintf("this chat holds %d images that were not sent: send or remove some, and try again in an hour", unsent)}
	}
	if err := os.MkdirAll(m.imagesDir(id), 0o700); err != nil {
		return none, err
	}
	if err := store.WriteFileAtomic(path, data, 0o600); err != nil {
		return none, err
	}
	was := s.idx[img.ID] // an entry whose file was gone
	s.idx[img.ID] = &imageEntry{Type: typ, Size: img.Size, Sent: was != nil && was.Sent, Used: now}
	if err := m.saveImages(top, id); err != nil {
		if was == nil {
			delete(s.idx, img.ID)
			os.Remove(path)
		}
		return none, err
	}
	return img, nil
}

// Image is the image with the id image of the top-level chat id, with its bytes: what a fetch
// serves. Its Name is empty: a store knows no names. The id is checked for its form before
// anything is looked up (ErrImageID); ErrNotFound for an id that is no chat's, ErrNoImage for an
// image the chat does not hold. A fetch is no use of the image.
func (m *Manager) Image(id, image string) (model.Image, []byte, error) {
	none := model.Image{}
	if !ValidImageID(image) {
		return none, nil, ErrImageID
	}
	top, err := m.topChat(id)
	if err != nil {
		return none, nil, err
	}
	s := &top.imgs
	s.mu.Lock()
	defer s.mu.Unlock()
	if top.gone.Load() {
		return none, nil, ErrNotFound
	}
	m.loadImages(top, id)
	e := s.idx[image]
	if e == nil {
		return none, nil, ErrNoImage
	}
	data, err := os.ReadFile(m.imagePath(id, image))
	if err != nil {
		return none, nil, ErrNoImage
	}
	return model.Image{ID: image, Type: e.Type, Size: int64(len(data))}, data, nil
}

// draftImages is the image list of a draft that is being saved for a branch of the top-level
// chat top, whose id is chat: of the images the save names, those the chat holds, each once, with
// the name cleaned and the type and size the store has; missing are the ids that were left out,
// an id of the wrong form among them, which is looked up nowhere. A draft may hold more images
// than a message takes: nothing is dropped for a limit here, the Send decides.
//
// The save is a use of every image it names and of every image the draft before, old, named and
// this one drops: none is deleted at the moment a draft stops naming it. top.mu held.
func (m *Manager) draftImages(top *Chat, chat string, old *model.Draft, named []model.Image) (kept []model.Image, missing []string) {
	if len(named) == 0 && (old == nil || len(old.Images) == 0) {
		return nil, nil
	}
	now := m.now()
	s := &top.imgs
	s.mu.Lock()
	defer s.mu.Unlock()
	if top.gone.Load() {
		return nil, nil
	}
	m.loadImages(top, chat)
	seen := map[string]bool{}
	for _, im := range named {
		if seen[im.ID] {
			continue
		}
		seen[im.ID] = true
		var e *imageEntry
		if ValidImageID(im.ID) {
			e = s.idx[im.ID]
		}
		if e == nil {
			missing = append(missing, im.ID)
			continue
		}
		e.Used = now
		kept = append(kept, model.Image{ID: im.ID, Name: cleanImageName(im.Name), Type: e.Type, Size: e.Size})
	}
	if old != nil {
		for _, im := range old.Images {
			if e := s.idx[im.ID]; e != nil {
				e.Used = now
			}
		}
	}
	m.sweepImages(top, chat, now)
	if err := m.saveImages(top, chat); err != nil {
		log.Printf("chats: images of %s: %v", chat, err)
	}
	return kept, missing
}

// takenImages are the images of one Send, held from the check of the message to its end
// (takeImages, releaseImages): while they are held the cleanup leaves them alone.
type takenImages struct {
	top  *Chat
	chat string        // top's id
	list []model.Image // as the message holds them, in its order
}

// takeImages checks the images a Send to the top-level chat top names and holds them for it:
// each id has the form of one (ErrImageID), there are at most model.ImagesPerMessage of them
// (ErrImageLimit), the chat holds every one (a *MissingImages that names the others) and
// together they are at most model.ImagesMessageBytes (ErrImageLimit). An image named twice is in
// the message once. Of what the Send says of an image only the id and the name, cleaned, are
// taken; type and size are the store's.
//
// The Send is a use of the images, so those of a message that is then refused stay for the wait
// from here. nil for a Send without images. The caller releases what it gets (releaseImages).
func (m *Manager) takeImages(top *Chat, chat string, named []model.Image) (*takenImages, error) {
	if len(named) == 0 {
		return nil, nil
	}
	var list []model.Image
	seen := map[string]bool{}
	for _, im := range named {
		if !ValidImageID(im.ID) {
			return nil, ErrImageID
		}
		if !seen[im.ID] {
			seen[im.ID] = true
			list = append(list, model.Image{ID: im.ID, Name: cleanImageName(im.Name)})
		}
	}
	if len(list) > model.ImagesPerMessage {
		return nil, imageErr{ErrImageLimit, fmt.Sprintf("a message takes at most %d images, and this one has %d", model.ImagesPerMessage, len(list))}
	}
	now := m.now()
	s := &top.imgs
	s.mu.Lock()
	defer s.mu.Unlock()
	if top.gone.Load() {
		return nil, ErrNotFound
	}
	m.loadImages(top, chat)
	var missing []string
	var total int64
	for i := range list {
		e := s.idx[list[i].ID]
		if e != nil {
			if _, err := os.Lstat(m.imagePath(chat, list[i].ID)); err != nil {
				e = nil
			}
		}
		if e == nil {
			missing = append(missing, list[i].ID)
			continue
		}
		list[i].Type, list[i].Size = e.Type, e.Size
		total += e.Size
	}
	if len(missing) > 0 {
		return nil, &MissingImages{IDs: missing}
	}
	if total > model.ImagesMessageBytes {
		return nil, imageErr{ErrImageLimit, fmt.Sprintf("the images of a message are at most %d MB together", model.ImagesMessageBytes>>20)}
	}
	for _, im := range list {
		s.idx[im.ID].Used = now
		s.pins[im.ID]++
	}
	if err := m.saveImages(top, chat); err != nil {
		log.Printf("chats: images of %s: %v", chat, err)
	}
	return &takenImages{top: top, chat: chat, list: list}, nil
}

// releaseImages ends the hold of a Send on its images; t may be nil.
func (m *Manager) releaseImages(t *takenImages) {
	if t == nil {
		return
	}
	s := &t.top.imgs
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, im := range t.list {
		if s.pins[im.ID]--; s.pins[im.ID] <= 0 {
			delete(s.pins, im.ID)
		}
	}
}

// images is the image list of the message t is of; nil for none.
func (t *takenImages) images() []model.Image {
	if t == nil {
		return nil
	}
	return t.list
}

// imageBlocks reads the bytes of the images t holds and returns them as the image blocks of the
// one Send they are for, in the message's order. Nothing keeps the bytes after it. The images are
// held, so their files are there unless the chat is being deleted.
func (m *Manager) imageBlocks(t *takenImages) ([]agent.ContentBlock, error) {
	if t == nil {
		return nil, nil
	}
	blocks := make([]agent.ContentBlock, 0, len(t.list))
	for _, im := range t.list {
		data, err := os.ReadFile(m.imagePath(t.chat, im.ID))
		if err != nil {
			return nil, &MissingImages{IDs: []string{im.ID}}
		}
		blocks = append(blocks, agent.ContentBlock{Image: &agent.Image{Name: im.Name, Type: im.Type, Data: data}})
	}
	return blocks, nil
}

// markSent records that the images t holds were sent: their message enters a thread of the chat.
// It is never taken back, whatever the agent answers. t may be nil.
func (m *Manager) markSent(t *takenImages) {
	if t == nil {
		return
	}
	s := &t.top.imgs
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, im := range t.list {
		if e := s.idx[im.ID]; e != nil {
			e.Sent = true
		}
	}
	if err := m.saveImages(t.top, t.chat); err != nil && !errors.Is(err, ErrNotFound) {
		log.Printf("chats: images of %s: %v", t.chat, err)
	}
}

// noImagesFor refuses a message with images for the model modelID of an agent of kind a when the
// catalog marks the model as taking none (ErrImageModel, in a sentence that names the model). A
// model the catalog does not know, or does not mark, takes them.
func (m *Manager) noImagesFor(a model.AgentKind, modelID string) error {
	cm, _ := findModel(m.catalog(a), modelID)
	return noImagesErr(cm)
}

// noImagesErr is noImagesFor for the catalog row cm, nil when the catalog has none.
func noImagesErr(cm *model.CatalogModel) error {
	if cm == nil || !cm.NoImages {
		return nil
	}
	name := cm.Label
	if name == "" {
		name = cm.ID
	}
	return imageErr{ErrImageModel, name + " takes no images: remove them from the message, or choose another model"}
}

// heldImages are those of imgs the store of the top-level chat top holds, in their order, each
// once, with the store's type and size. top.imgs.mu must not be held.
func (m *Manager) heldImages(top *Chat, chat string, imgs []model.Image) []model.Image {
	if len(imgs) == 0 {
		return nil
	}
	s := &top.imgs
	s.mu.Lock()
	defer s.mu.Unlock()
	m.loadImages(top, chat)
	var out []model.Image
	seen := map[string]bool{}
	for _, im := range imgs {
		if e := s.idx[im.ID]; e != nil && !seen[im.ID] {
			seen[im.ID] = true
			out = append(out, model.Image{ID: im.ID, Name: im.Name, Type: e.Type, Size: e.Size})
		}
	}
	return out
}

// forkImages gives the fork c, which is still unlisted, its own image store: a copy of every
// image the messages it copied hold (items, the copied part of the source's thread), each as an
// image that was sent, and of those of the message that becomes its draft (draft, nil for none),
// which the fork never sent. top is the source's top-level chat and chat its id. An image the
// source no longer holds is left out. The files are never changed once written, so a copy is a
// hard link where the file system makes one. Nothing of the source changes: deleting it, or the
// cleanup in it, takes nothing from the fork, and the other way round.
func (m *Manager) forkImages(top *Chat, chat string, c *Chat, fork string, items []model.Item, draft *model.Draft) error {
	sent := map[string]bool{}
	var ids []string
	add := func(imgs []model.Image, was bool) {
		for _, im := range imgs {
			if _, in := sent[im.ID]; !in {
				ids = append(ids, im.ID)
			}
			sent[im.ID] = sent[im.ID] || was
		}
	}
	for _, it := range items {
		if it.Kind == "user" {
			add(it.Images, true)
		}
	}
	if draft != nil {
		add(draft.Images, false)
	}
	if len(ids) == 0 {
		return nil
	}
	now := m.now()
	s := &top.imgs
	s.mu.Lock()
	defer s.mu.Unlock()
	m.loadImages(top, chat)
	idx := map[string]*imageEntry{}
	for _, id := range ids {
		e := s.idx[id]
		if e == nil || !ValidImageID(id) {
			continue
		}
		if len(idx) == 0 {
			if err := os.MkdirAll(m.imagesDir(fork), 0o700); err != nil {
				return err
			}
		}
		from, to := m.imagePath(chat, id), m.imagePath(fork, id)
		if err := os.Link(from, to); err != nil {
			data, rerr := os.ReadFile(from)
			if errors.Is(rerr, fs.ErrNotExist) {
				continue
			}
			if rerr != nil {
				return rerr
			}
			if err := store.WriteFileAtomic(to, data, 0o600); err != nil {
				return err
			}
		}
		idx[id] = &imageEntry{Type: e.Type, Size: e.Size, Sent: sent[id], Used: now}
	}
	if len(idx) == 0 {
		return nil
	}
	c.imgs.mu.Lock() // nobody else knows c yet
	defer c.imgs.mu.Unlock()
	c.imgs.loaded, c.imgs.idx, c.imgs.pins = true, idx, map[string]int{}
	return store.WriteJSONAtomic(filepath.Join(m.imagesDir(fork), imageIndexFile), imageIndex{Images: idx}, 0o600)
}
