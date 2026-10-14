package server

import (
	"errors"
	"io"
	"net/http"
)

// SceneMax is the largest drawing a client may write.
const SceneMax = 128 << 20

// readScene reads the drawing of a write, cut at SceneMax: a larger one is answered 413 and false
// is returned.
func readScene(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, SceneMax))
	var large *http.MaxBytesError
	switch {
	case errors.As(err, &large):
		writeErrorCode(w, http.StatusRequestEntityTooLarge, "the drawing is larger than 128 MB", "too_large")
	case err != nil:
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		return b, true
	}
	return nil, false
}
