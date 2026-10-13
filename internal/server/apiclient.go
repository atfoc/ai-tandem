package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// What the routes of RemoteRoutes do for an API client, a caller on the remote listener, where
// that differs from what they do for a page: the client's stream and snapshot, and the refusals
// that exist for a client alone. Everything else is the page's handler. RemoteHandler has checked
// the secret, the Host, the client id and the client's level before any of this runs: the id in
// X-AIWB-Client is a valid one, and not the server's own.

// apiEvents is GET /api/events on the remote listener: the stream of the API client whose id the
// header holds. A "client" in the query, which the stream of a page is named by, must be the same
// id or absent. The stream begins with hello and the API snapshot (app.APISnapshot), its fields
// inline in the snapshot event.
func (s *Server) apiEvents(w http.ResponseWriter, r *http.Request) {
	id := r.Header.Get(ClientHeader)
	if q := r.URL.Query(); q.Has("client") && q.Get("client") != id {
		writeErrorCode(w, http.StatusBadRequest, "bad client id", "bad_client")
		return
	}
	// ReloadSecret closes the streams that are open when it runs. This request's secret may have
	// been checked before the reload and its stream be recorded after: such a stream gets no
	// snapshot and ends at once. The snapshot function runs once the stream is recorded, with
	// the bridge's lock held, which the close of the streams takes too.
	call, _ := r.Context().Value(remoteKey{}).(remoteCall)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	s.Bridge.ServeAPI(w, r.WithContext(ctx), id, func() any {
		if rm := s.Remote; rm == nil || rm.secretGen.Load() != call.secretGen {
			cancel()
			return nil
		}
		return s.App.APISnapshot()
	})
}

// apiServerRefused answers an API client's call whose body names a server, whatever the value, and
// reports that it did: the server of what a client makes or changes is the one it called, and
// this server passes no client's call on to another. Nothing is made or changed. The body is
// left to be read again.
func apiServerRefused(w http.ResponseWriter, r *http.Request) bool {
	if !bodyNames(r, "server") {
		return false
	}
	writeErrorCode(w, http.StatusBadRequest, "an API client cannot name a server", "server_refused")
	return true
}

// collapsedRefused answers an API client's change of a group whose body has "collapsed", whatever
// the value, and reports that it did: whether a group shows collapsed is this server's own matter
// and each client's. Nothing is changed.
func collapsedRefused(w http.ResponseWriter, r *http.Request) bool {
	if !bodyNames(r, "collapsed") {
		return false
	}
	writeErrorCode(w, http.StatusBadRequest, "an API client cannot collapse a group", "collapsed_refused")
	return true
}

// bodyNames reports whether r's body is a JSON object with the key, in any letter case (as the
// handlers read their bodies). It reads the body and puts it back: a body that is no JSON object
// names nothing, and the handler that reads it next says what is wrong with it.
func bodyNames(r *http.Request, key string) bool {
	raw, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(raw))
	var keys map[string]json.RawMessage
	if json.Unmarshal(raw, &keys) != nil {
		return false
	}
	for k := range keys {
		if strings.EqualFold(k, key) {
			return true
		}
	}
	return false
}
