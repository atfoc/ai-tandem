package container

import (
	"context"
	_ "embed"
	"errors"
	"strings"
	"time"
)

//go:embed image/Dockerfile
var dockerfile []byte

// Dockerfile is the Dockerfile of the default image (DefaultImage()), shipped with the server.
func Dockerfile() []byte { return append([]byte(nil), dockerfile...) }

// buildLimit bounds a build of the default image, whoever waits on it.
const buildLimit = 30 * time.Minute

// pullLimit bounds a pull of another image, whoever waits on it.
const pullLimit = 30 * time.Minute

// buildLines is how many of a failed build's (or pull's) last lines of output its error holds.
const buildLines = 8

// imageFlight is one look at, and if need be build or pull of, an image, shared by every
// EnsureImage of it meanwhile.
type imageFlight struct {
	done     chan struct{}
	err      error
	building bool // being built or pulled; guarded by Manager.mu
}

// EnsureImage makes image available on this machine. It first looks (`docker image inspect`, a
// quick call); when Docker answers that the image is not there, the default image
// (DefaultImage()) is built from the Dockerfile shipped with the server and any other image is
// pulled (`docker pull`). Calls for one image wait for one another: concurrent callers share one
// look and one build or pull, which runs on when a caller gives up (ctx), for at most 30 minutes;
// Building(image) is true while it runs. A failed build or pull returns an *Error (Op "build" or
// "pull") whose Line names the image and holds the last lines of Docker's output; the next call
// tries again. When Docker cannot be used it returns the *Unavailable and neither builds nor pulls.
//
// It takes no account's lock: a caller that holds one of its own should call it first, without
// the lock, so that a long build or pull never runs under it; Ensure and Recreate then find the
// image there with one quick look.
func (m *Manager) EnsureImage(ctx context.Context, image string) error {
	if windows() {
		return unavailable(errUnsupported)
	}
	if image == "" {
		return errors.New("container: no image")
	}
	m.mu.Lock()
	if m.images == nil {
		m.images = map[string]*imageFlight{}
	}
	f := m.images[image]
	if f == nil {
		f = &imageFlight{done: make(chan struct{})}
		m.images[image] = f
		go m.ensureImage(context.WithoutCancel(ctx), image, f)
	}
	m.mu.Unlock()
	select {
	case <-f.done:
		return f.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *Manager) ensureImage(ctx context.Context, image string, f *imageFlight) {
	defer func() {
		m.mu.Lock()
		delete(m.images, image)
		f.building = false
		m.mu.Unlock()
		close(f.done)
	}()
	_, err := m.docker(ctx, true, nil, "image", "inspect", "--format", "{{.Id}}", "--", image)
	if err == nil {
		return
	}
	if _, ok := IsUnavailable(err); ok {
		f.err = err
		return
	}
	m.mu.Lock()
	f.building = true
	m.mu.Unlock()
	if image == DefaultImage() {
		bctx, cancel := context.WithTimeout(ctx, buildLimit)
		defer cancel()
		_, err = m.docker(bctx, false, Dockerfile(), "build", "-t", image, "-")
		f.err = longErr(err, "build", "Building the image "+image, buildLimit)
		return
	}
	pctx, cancel := context.WithTimeout(ctx, pullLimit)
	defer cancel()
	_, err = m.docker(pctx, false, nil, "pull", "--", image)
	f.err = longErr(err, "pull", "Pulling the image "+image, pullLimit)
}

// longErr is the error of a build or pull (op) that ended with err: Docker's refusal as an *Error
// with what (e.g. "Building the image x") and the last lines of its output, its time limit as an
// *Error saying so, any other error (an *Unavailable) as it is.
func longErr(err error, op, what string, limit time.Duration) error {
	var de *Error
	switch {
	case err == nil:
		return nil
	case errors.As(err, &de):
		tail := lastLines(de.stderr, buildLines)
		if tail == "" {
			tail = de.Line
		}
		return &Error{Op: op, Line: what + " failed:\n" + tail, stderr: de.stderr}
	case errors.Is(err, context.DeadlineExceeded):
		return &Error{Op: op, Line: what + " took longer than " + limit.String()}
	}
	return err
}

// lastLines is the last n non-empty lines of s.
func lastLines(s string, n int) string {
	var keep []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimRight(l, " \r\t"); strings.TrimSpace(l) != "" {
			keep = append(keep, l)
		}
	}
	if len(keep) > n {
		keep = keep[len(keep)-n:]
	}
	return strings.Join(keep, "\n")
}

// Building reports whether image is being built or pulled now (the account shows "Preparing…").
func (m *Manager) Building(image string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	f := m.images[image]
	return f != nil && f.building
}
