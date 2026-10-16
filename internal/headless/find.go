package headless

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// What the headless writer runs on, and where its program is. Both are looked up when an agent's call
// first needs it, and again after a failed start has been remembered for the retry wait (Node may be
// installed meanwhile), never at boot.

const (
	// BundleFile is the program of the headless writer inside a bundle folder.
	BundleFile = "headless.mjs"
	// ManifestFile says which build the bundle is.
	ManifestFile = "manifest.json"
	// MinNodeMajor is the oldest Node that runs the bundle (esbuild target node22).
	MinNodeMajor = 22
	// ElectronProgram is the desktop app's executable, next to the server binary in the Mac app.
	ElectronProgram = "AI Whiteboard"
	// NodeEnv names the runtime like -headless-node does.
	NodeEnv = "AIWB_HEADLESS_NODE"
)

// Runtime is the program that runs the bundle.
type Runtime struct {
	Path     string
	Electron bool   // run with ELECTRON_RUN_AS_NODE=1
	Source   string // "flag", "electron" or "path": for the log and for status
}

// Bundle is a bundle folder that can be used.
type Bundle struct {
	Dir     string // holds headless.mjs and manifest.json
	Program string // Dir/headless.mjs
}

// lookups are the things find asks of the machine, each replaceable by a test.
type lookups struct {
	Executable func() (string, error)                 // the server binary's path
	LookPath   func(name string) (string, error)      // exec.LookPath
	Getenv     func(string) string                    // os.Getenv
	Stat       func(path string) (os.FileInfo, error) // os.Stat
	ReadFile   func(path string) ([]byte, error)      // os.ReadFile
	NodeVer    func(path string) (string, error)      // the output of `path --version`
}

func systemLookups() lookups {
	return lookups{
		Executable: func() (string, error) {
			p, err := os.Executable()
			if err != nil {
				return "", err
			}
			if r, err := filepath.EvalSymlinks(p); err == nil {
				p = r
			}
			return p, nil
		},
		LookPath: exec.LookPath,
		Getenv:   os.Getenv,
		Stat:     os.Stat,
		ReadFile: os.ReadFile,
		NodeVer:  nodeVersion,
	}
}

// nodeVersion runs `path --version`.
func nodeVersion(path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "--version").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

var nodeVersionRe = regexp.MustCompile(`^v?(\d+)\.(\d+)`)

// nodeMajor reads the major number of "v22.3.0".
func nodeMajor(v string) (int, bool) {
	m := nodeVersionRe.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return 0, false
	}
	n, _ := strconv.Atoi(m[1])
	return n, true
}

// findRuntime finds the program that runs the bundle (D33), the first that exists:
//  1. node, the flag -headless-node (or AIWB_HEADLESS_NODE): that program, as it is;
//  2. the desktop app's own Electron, when the server binary is …/Contents/MacOS/<exe> and
//     …/Contents/MacOS/AI Whiteboard is there;
//  3. `node` on PATH, of Node 22 or later.
//
// The error says why none could be used.
func findRuntime(node string, l lookups) (Runtime, error) {
	if node == "" {
		node = l.Getenv(NodeEnv)
	}
	if node != "" {
		p, err := l.LookPath(node)
		if err != nil {
			return Runtime{}, fmt.Errorf("the Node given with -headless-node (%s) cannot be run: %v", node, unwrapPathErr(err))
		}
		return Runtime{Path: p, Source: "flag"}, nil
	}
	var why []string
	if exe, err := l.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if filepath.Base(dir) == "MacOS" && filepath.Base(filepath.Dir(dir)) == "Contents" {
			electron := filepath.Join(dir, ElectronProgram)
			if electron != exe {
				if fi, err := l.Stat(electron); err == nil && !fi.IsDir() {
					return Runtime{Path: electron, Electron: true, Source: "electron"}, nil
				}
				why = append(why, "the desktop app's program is not next to the server ("+electron+")")
			}
		}
	}
	p, err := l.LookPath("node")
	if err != nil {
		why = append(why, "node is not on the PATH")
		return Runtime{}, fmt.Errorf("no Node to run it with: %s; give one with -headless-node", strings.Join(why, ", "))
	}
	v, err := l.NodeVer(p)
	if err != nil {
		return Runtime{}, fmt.Errorf("node at %s does not tell its version: %v", p, err)
	}
	major, ok := nodeMajor(v)
	if !ok {
		return Runtime{}, fmt.Errorf("node at %s tells a version that is not understood: %q", p, v)
	}
	if major < MinNodeMajor {
		return Runtime{}, fmt.Errorf("node at %s is %s; version %d or later is needed", p, v, MinNodeMajor)
	}
	return Runtime{Path: p, Source: "path"}, nil
}

func unwrapPathErr(err error) error {
	if pe, ok := err.(*exec.Error); ok {
		return pe.Err
	}
	return err
}

// Manifest is manifest.json of a bundle.
type Manifest struct {
	Version string `json:"version"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
}

// findBundle finds the folder with the program (D34): dir (-headless-dir) when given, and then nothing
// else; else <exe dir>/../Resources/headless, else <exe dir>/headless. The manifest's version must be the
// server's version, unless the server is "dev", which takes any: the server and its headless writer are
// one build. The error says why no folder could be used.
func findBundle(dir, version string, l lookups) (Bundle, error) {
	if dir != "" {
		b, err := checkBundle(dir, version, l)
		if err != nil {
			return Bundle{}, fmt.Errorf("the headless folder given with -headless-dir cannot be used: %v", err)
		}
		return b, nil
	}
	exe, err := l.Executable()
	if err != nil {
		return Bundle{}, fmt.Errorf("the place of the server program is not known: %v", err)
	}
	exeDir := filepath.Dir(exe)
	var why []string
	for _, c := range []string{
		filepath.Join(exeDir, "..", "Resources", "headless"),
		filepath.Join(exeDir, "headless"),
	} {
		c = filepath.Clean(c)
		b, err := checkBundle(c, version, l)
		if err == nil {
			return b, nil
		}
		why = append(why, err.Error())
	}
	return Bundle{}, fmt.Errorf("no headless writer is installed with this server (%s)", strings.Join(why, "; "))
}

// checkBundle says whether dir holds a bundle of the version.
func checkBundle(dir, version string, l lookups) (Bundle, error) {
	program := filepath.Join(dir, BundleFile)
	if fi, err := l.Stat(program); err != nil || fi.IsDir() {
		return Bundle{}, fmt.Errorf("%s is missing", program)
	}
	raw, err := l.ReadFile(filepath.Join(dir, ManifestFile))
	if err != nil {
		return Bundle{}, fmt.Errorf("%s cannot be read: %v", filepath.Join(dir, ManifestFile), unwrapPathErr(err))
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return Bundle{}, fmt.Errorf("%s is not valid: %v", filepath.Join(dir, ManifestFile), err)
	}
	if version != "dev" && m.Version != version {
		return Bundle{}, fmt.Errorf("%s is of version %q, the server is %q", dir, m.Version, version)
	}
	return Bundle{Dir: dir, Program: program}, nil
}
