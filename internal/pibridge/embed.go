package pibridge

import (
	"bytes"
	"embed"
	"io/fs"
	"os"
	"path/filepath"
)

// extensionFS is the embedded pi extension asset (index.ts, protocol.ts,
// mcp.ts, mcp-wiring.ts, permissions.ts, subagent.ts and the Node tests).
//
//go:embed extension
var extensionFS embed.FS

// MaterializeExtension writes the embedded extension tree into dir (created
// 0700, files 0600; identical files are left untouched) and returns the
// absolute path of the copied index.ts. The pi adapter passes that path to
// `pi -e`.
func MaterializeExtension(dir string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(abs, 0o700); err != nil {
		return "", err
	}

	err = fs.WalkDir(extensionFS, "extension", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel("extension", path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		dest := filepath.Join(abs, rel)
		if d.IsDir() {
			if err := os.MkdirAll(dest, 0o700); err != nil {
				return err
			}
			return os.Chmod(dest, 0o700)
		}
		data, err := extensionFS.ReadFile(path)
		if err != nil {
			return err
		}
		if existing, err := os.ReadFile(dest); err == nil && bytes.Equal(existing, data) {
			return os.Chmod(dest, 0o600)
		}
		if err := os.WriteFile(dest, data, 0o600); err != nil {
			return err
		}
		return os.Chmod(dest, 0o600)
	})
	if err != nil {
		return "", err
	}
	return filepath.Join(abs, "index.ts"), nil
}
