package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/store"
)

// legacyPort is where the servers of the build before listened for their own page, and so where a
// running server of that build is looked for besides the port in server.json. A variable for the
// tests of this package, which look elsewhere.
var legacyPort = 4747

// build says whose a running server is: this build's, or the build before's.
type build string

const (
	thisBuild  build = "this"
	olderBuild build = "older"
)

// helloReply is a server's answer to hello: the control socket's /hello for this build, the
// loopback port's /api/hello for the build before.
type helloReply struct {
	App     string `json:"app"`
	Version string `json:"version"`
	Pid     int    `json:"pid"`
	// FeatureLevel is 0 for a build that reports none; from level 1 on a running server reads its
	// secret again when it is sent SIGUSR1.
	FeatureLevel int    `json:"featureLevel"`
	InstanceID   string `json:"instanceId"`
	DataDir      string `json:"dataDir"` // the control socket's hello only
}

// runningServer is a server found running for a data folder.
type runningServer struct {
	build   build
	hello   helloReply
	control string // this build: the control socket's path
	legacy  string // the build before: http://127.0.0.1:<port>, where its page was served
}

// findRunning looks for the AI Whiteboard server running for the data folder p, and finds it when
// it is of this build or of the one before.
//
// This build: the control socket named in server.json (else the default path) answers hello within
// 1 s, with the folder's instance id and the folder as its data folder. The build before: the
// legacy probe, which is the only place that speaks HTTP to 127.0.0.1: the port of a server.json
// that has no control socket, then 4747, answers /api/hello with a pid and the folder's instance id
// (when the folder has one), and /api/state names the folder as its data folder. A stale
// server.json, another program and another data folder's server are ignored.
func findRunning(p store.Paths) (runningServer, bool) {
	sf, haveFile := store.ReadServerFile(p)
	control := sf.Control
	if control == "" {
		control = store.ControlSocketPath(p.Root)
	}
	id := folderInstanceID(p.Root)
	var h helloReply
	if controlGet(control, "/hello", time.Second, &h) && h.App == "ai-whiteboard" && id != "" && h.InstanceID == id &&
		h.DataDir != "" && realPath(h.DataDir) == realPath(p.Root) {
		return runningServer{build: thisBuild, hello: h, control: control}, true
	}

	var ports []int
	if haveFile && sf.Control == "" {
		ports = append(ports, sf.Port)
	}
	if len(ports) == 0 || ports[0] != legacyPort {
		ports = append(ports, legacyPort)
	}
	for _, port := range ports {
		base := "http://127.0.0.1:" + strconv.Itoa(port)
		h, ok := legacyHello(base)
		if !ok || h.Pid <= 0 || (id != "" && h.InstanceID != id) {
			continue
		}
		if dir, ok := legacyDataDir(base); !ok || realPath(dir) != realPath(p.Root) {
			continue
		}
		return runningServer{build: olderBuild, hello: h, legacy: base}, true
	}
	return runningServer{}, false
}

// folderInstanceID is the instance id in the data folder's instance-id file, "" when there is none
// or it is not an id.
func folderInstanceID(root string) string {
	b, err := os.ReadFile(remote.FilesIn(root).InstanceID)
	id := strings.TrimSpace(string(b))
	if err != nil || !remote.ValidID(id) {
		return ""
	}
	return id
}

// controlGet asks the control socket at path for route, an HTTP/1.1 GET, and decodes the JSON
// answer into v. ok is false for anything but a 200 with JSON within the time.
func controlGet(path, route string, timeout time.Duration, v any) bool {
	c := &http.Client{Timeout: timeout, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", path)
		},
		DisableKeepAlives: true,
	}}
	defer c.CloseIdleConnections()
	resp, err := c.Get("http://control" + route)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK && json.NewDecoder(resp.Body).Decode(v) == nil
}

// legacyClient asks a server of the build before within 1 s.
func legacyClient() *http.Client { return &http.Client{Timeout: time.Second} }

// legacyHello asks base for /api/hello; ok only when an AI Whiteboard server answers.
func legacyHello(base string) (helloReply, bool) {
	var h helloReply
	resp, err := legacyClient().Get(base + "/api/hello")
	if err != nil {
		return h, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&h) != nil {
		return h, false
	}
	return h, h.App == "ai-whiteboard"
}

// legacyDataDir asks base for its data folder: the dataDir of GET /api/state. ok is false for any
// answer that is not 200 with JSON that names one.
func legacyDataDir(base string) (string, bool) {
	resp, err := legacyClient().Get(base + "/api/state")
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	var st struct {
		DataDir string `json:"dataDir"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&st) != nil || st.DataDir == "" {
		return "", false
	}
	return st.DataDir, true
}

// legacyRemoteStatus is the build before's answer to GET /api/remote/status.
type legacyRemoteStatus struct {
	Listening     bool  `json:"listening"`
	SecretReloads int64 `json:"secretReloads"`
}

// legacyRemote asks a server of the build before whether it listens for remote access.
func legacyRemote(base string) (legacyRemoteStatus, bool) {
	var st legacyRemoteStatus
	resp, err := legacyClient().Get(base + "/api/remote/status")
	if err != nil {
		return st, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&st) != nil {
		return st, false
	}
	return st, true
}

// controlStatus is the control socket's /status.
type controlStatus struct {
	Client clientStatus   `json:"client"`
	MCP    map[string]any `json:"mcp"`
}

// clientStatus is the client listener's part of /status.
type clientStatus struct {
	Listening     bool     `json:"listening"`
	Address       string   `json:"address"`
	Port          int      `json:"port"`
	Names         []string `json:"names"`
	Fingerprint   string   `json:"fingerprint"`
	SecretReloads int64    `json:"secretReloads"`
}

// statusOf asks a running server of this build for its /status.
func (r runningServer) statusOf() (controlStatus, bool) {
	var st controlStatus
	if r.build != thisBuild {
		return st, false
	}
	return st, controlGet(r.control, "/status", 3*time.Second, &st)
}

// realPath is path with symlinks resolved, or cleaned when it cannot be resolved.
func realPath(path string) string {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return filepath.Clean(path)
}
