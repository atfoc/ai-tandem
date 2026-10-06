package agent

import (
	"errors"
	"fmt"
	"testing"
)

// NoSession keeps the provider's words and still is the one signal, also when wrapped.
func TestNoSession(t *testing.T) {
	const text = `session/load: Invalid params {"message":"Session \"s1\" not found"}`
	err := NoSession(text)
	if err.Error() != text {
		t.Errorf("text %q, want %q", err.Error(), text)
	}
	if !errors.Is(err, ErrNoSession) {
		t.Error("errors.Is(NoSession(text), ErrNoSession) is false")
	}
	if !errors.Is(fmt.Errorf("resume: %w", err), ErrNoSession) {
		t.Error("a wrapped NoSession does not match ErrNoSession")
	}
	if errors.Is(err, ErrFolderMissing) {
		t.Error("NoSession matches another error")
	}
	if errors.Is(errors.New(text), ErrNoSession) {
		t.Error("an error with the same text matches ErrNoSession")
	}
	if !errors.Is(ErrNoSession, ErrNoSession) {
		t.Error("ErrNoSession does not match itself")
	}
}
