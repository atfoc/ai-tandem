package server

import (
	"errors"
	"io"
	"net/http"
	"strconv"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// The routes of the images a person attaches to a chat message (chats/images.go). {id} is the
// top-level chat's id: its branches share one image store. A client uploads to the chat and
// fetches from it, and no call checks whose chat it is.

// imagePatterns are the two routes, as registered.
var imagePatterns = []string{"POST /api/chats/{id}/images", "GET /api/chats/{id}/images/{image}"}

// imageRoutes adds the two routes of a chat of this server.
func (s *Server) imageRoutes(mux *routeMux) {
	a := s.App
	// Uploads one image: the body is its bytes, Content-Type the type the page believes it is,
	// ?name= what the page calls it. The answer is the image as a draft holds it: {id, name, type,
	// size}. Who may upload to a chat is who may save its draft. The body is cut at the size
	// limit before it is read, and an upload that is refused or cut leaves nothing: 413
	// "image_too_large", 415 "image_type" (not one of the four types, or the bytes are of another
	// type than the upload says), 409 "image_cap" (too many images that were never sent).
	mux.HandleFunc(imagePatterns[0], func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := a.Chats.ImageUploadable(id); err != nil { // before a byte of the body is read
			fail(w, err, http.StatusInternalServerError)
			return
		}
		data, good := readUpload(w, r)
		if !good {
			return
		}
		img, err := a.Chats.UploadImage(id, r.URL.Query().Get("name"), r.Header.Get("Content-Type"), data)
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeJSON(w, img)
	})
	// The bytes of one image, to every client. The id is checked for its form before anything is looked up (400 "image_id"); 404 when the chat
	// does not hold it. The type is the one the store found from the bytes and the browser is
	// told not to guess another; the id is the hash of the bytes, so the answer never changes and
	// is cacheable for good.
	mux.HandleFunc(imagePatterns[1], func(w http.ResponseWriter, r *http.Request) {
		img, data, err := a.Chats.Image(r.PathValue("id"), r.PathValue("image"))
		if err != nil {
			fail(w, err, http.StatusInternalServerError)
			return
		}
		writeImage(w, r, img.Type, data)
	})
}

// readUpload reads the bytes of an upload, cut at the size limit before it is read: one that
// says it is larger is refused unread, and one that turns out larger is read no further than the
// limit (413 "image_too_large"). An upload that was cut on its way is 400. It reports whether
// the bytes are whole; when not, the answer is written.
func readUpload(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.ContentLength > model.ImageMaxBytes {
		fail(w, chats.ErrImageTooLarge, http.StatusRequestEntityTooLarge)
		return nil, false
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, model.ImageMaxBytes))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		fail(w, chats.ErrImageTooLarge, http.StatusRequestEntityTooLarge)
		return nil, false
	}
	if err != nil { // the upload was cut: nothing of it is kept
		writeError(w, http.StatusBadRequest, "the upload did not arrive whole: "+err.Error())
		return nil, false
	}
	return data, true
}

// writeImage answers a fetch with the bytes of an image of the type typ, one of
// model.ImageTypes, under the headers every image is served with: the browser is told not to
// guess another type, no other site can show it, nothing in it runs, and it is cacheable for good.
func writeImage(w http.ResponseWriter, r *http.Request, typ string, data []byte) {
	h := w.Header()
	h.Set("Content-Type", typ)
	h.Set("Content-Length", strconv.Itoa(len(data)))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cross-Origin-Resource-Policy", "same-origin") // no other site can show it
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Content-Disposition", "inline")
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	if r.Method != http.MethodHead {
		w.Write(data)
	}
}
