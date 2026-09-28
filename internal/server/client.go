package server

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"
)

// clientFiles serves the web client from dir like http.FileServer, but makes the
// browser revalidate every file (Cache-Control: no-cache) against a strong ETag
// made from the file's bytes. File names and times are the same or even older
// across builds, so only the content can tell a new build from a cached one.
func clientFiles(dir string) http.Handler {
	return &clientServer{root: http.Dir(dir), fs: http.FileServer(http.Dir(dir)), tags: map[string]etagEntry{}}
}

type clientServer struct {
	root http.Dir
	fs   http.Handler

	mu   sync.Mutex
	tags map[string]etagEntry // by cleaned file path
}

// etagEntry is a file's content hash, valid while its size and mtime are unchanged.
type etagEntry struct {
	size int64
	mod  time.Time
	tag  string
}

func (c *clientServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache")
	if tag := c.etag(r.URL.Path); tag != "" {
		w.Header().Set("ETag", tag)
	}
	// http.FileServer checks If-None-Match against the ETag set above before
	// If-Modified-Since, so a changed file gets 200 whatever its time.
	c.fs.ServeHTTP(w, r)
}

// etag returns the strong ETag of the file http.FileServer serves for upath, or ""
// when it serves no file content for it (missing file, redirect, directory listing).
func (c *clientServer) etag(upath string) string {
	if !strings.HasPrefix(upath, "/") {
		upath = "/" + upath
	}
	if strings.HasSuffix(upath, "/index.html") {
		return "" // http.FileServer redirects to the directory
	}
	name := path.Clean(upath)
	f, err := c.root.Open(name)
	if err != nil {
		return ""
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return ""
	}
	if st.IsDir() {
		f.Close()
		if !strings.HasSuffix(upath, "/") {
			return "" // redirected to the path with a trailing slash
		}
		name = path.Join(name, "index.html")
		if f, err = c.root.Open(name); err != nil {
			return ""
		}
		if st, err = f.Stat(); err != nil || st.IsDir() {
			f.Close()
			return ""
		}
	}
	defer f.Close()

	c.mu.Lock()
	e, ok := c.tags[name]
	c.mu.Unlock()
	if ok && e.size == st.Size() && e.mod.Equal(st.ModTime()) {
		return e.tag
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	e = etagEntry{size: st.Size(), mod: st.ModTime(), tag: `"` + hex.EncodeToString(h.Sum(nil)[:16]) + `"`}
	c.mu.Lock()
	c.tags[name] = e
	c.mu.Unlock()
	return e.tag
}
