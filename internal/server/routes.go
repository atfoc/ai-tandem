package server

import "net/http"

// routeMux is an http.ServeMux that keeps the pattern of every route registered on it, in order,
// so that a test can ask the remote listener for each of them (see RemoteRoutes).
type routeMux struct {
	*http.ServeMux
	patterns []string
}

func newRouteMux() *routeMux { return &routeMux{ServeMux: http.NewServeMux()} }

// HandleFunc records pattern and registers f for it.
func (m *routeMux) HandleFunc(pattern string, f func(http.ResponseWriter, *http.Request)) {
	m.patterns = append(m.patterns, pattern)
	m.ServeMux.HandleFunc(pattern, f)
}

// Handle records pattern and registers h for it.
func (m *routeMux) Handle(pattern string, h http.Handler) {
	m.patterns = append(m.patterns, pattern)
	m.ServeMux.Handle(pattern, h)
}
