package headless

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeBundle(t *testing.T, dir, version, program string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, BundleFile), []byte(program), 0o644); err != nil {
		t.Fatal(err)
	}
	mf, _ := json.Marshal(Manifest{Version: version, OS: "darwin", Arch: "arm64"})
	if err := os.WriteFile(filepath.Join(dir, ManifestFile), mf, 0o644); err != nil {
		t.Fatal(err)
	}
}
