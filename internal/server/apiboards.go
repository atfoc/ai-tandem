package server

import (
	"errors"
	"io"
	"net/http"
)

// SceneMax is the largest drawing an API client may write. A page's write has no cap.
const SceneMax = 32 << 20

// readScene reads the drawing of a write. An API client's is cut at SceneMax: a larger one is
// answered 413 and false is returned.
func readScene(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body := r.Body
	if fromRemote(r) {
		body = http.MaxBytesReader(w, body, SceneMax)
	}
	b, err := io.ReadAll(body)
	var large *http.MaxBytesError
	switch {
	case errors.As(err, &large):
		writeErrorCode(w, http.StatusRequestEntityTooLarge, "the drawing is larger than 32 MB", "too_large")
	case err != nil:
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		return b, true
	}
	return nil, false
}
