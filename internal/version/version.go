// Package version holds the app's version. It imports nothing, so any package can read it.
package version

// Version is the app's version, "dev" unless set at build time:
//
//	go build -ldflags "-X ai-whiteboard/internal/version.Version=0.1.0" ./cmd/ai-whiteboard
var Version = "dev"
