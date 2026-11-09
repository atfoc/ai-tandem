//go:build !windows

// Command fakedocker is the stand-in for the docker program in the tests: it answers the command
// lines of internal/container/run.go the way Docker 29 does, keeping its containers, images and
// runs in the folder $AIWB_FAKEDOCKER_STATE (see internal/container/fakedocker/fdstate). It never
// touches Docker. The processes `exec` runs, run on the host. Tests get it through
// internal/container/containertest.
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"

	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/container/fakedocker/fdstate"
)

const (
	failLine = "Error response from daemon: stand-in docker failure"
	downLine = "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory"
)

var dir string

func main() {
	dir = os.Getenv(fdstate.EnvState)
	if dir == "" {
		fmt.Fprintln(os.Stderr, "fakedocker: "+fdstate.EnvState+" is not set")
		os.Exit(2)
	}
	args := os.Args[1:]
	st, err := fdstate.LogCall(dir, args)
	if err != nil {
		die(2, "fakedocker: state: %v", err)
	}
	switch st.Mode {
	case "fail":
		die(1, "%s", failLine)
	case "down":
		die(1, "%s", downLine)
	case "slow":
		d := st.Slow
		if d <= 0 {
			d = fdstate.DefaultSlow
		}
		time.Sleep(d)
	}
	cmd := ""
	if len(args) > 0 {
		cmd = args[0]
	}
	if line, ok := st.FailOn[cmd]; ok && line != "" {
		die(1, "%s", line)
	}
	if len(args) == 0 {
		die(1, "docker: unknown command: ")
	}
	rest := args[1:]
	switch cmd {
	case "version":
		fmt.Println("29.0.0-standin")
	case "inspect":
		inspect(rest)
	case "ps":
		ps(rest)
	case "create":
		create(rest)
	case "start":
		start(rest)
	case "stop":
		stop(rest)
	case "rm":
		rm(rest)
	case "image":
		if len(rest) > 0 && rest[0] == "inspect" {
			imageInspect(rest[1:])
		}
		die(1, "docker: unknown command: image %s", strings.Join(rest, " "))
	case "build":
		build(rest)
	case "pull":
		pull(rest)
	case "exec":
		execCmd(rest)
	default:
		die(1, "docker: unknown command: %s", cmd)
	}
	os.Exit(0)
}

func die(code int, format string, a ...any) {
	if msg := fmt.Sprintf(format, a...); msg != "" {
		fmt.Fprintln(os.Stderr, msg)
	}
	os.Exit(code)
}

func update(fn func(*fdstate.State) error) {
	if err := fdstate.Update(dir, fn); err != nil {
		var e exitErr
		if errors.As(err, &e) {
			die(e.code, "%s", e.msg)
		}
		die(2, "fakedocker: state: %v", err)
	}
}

// exitErr ends an update without saving and the stand-in with code and msg on stderr.
type exitErr struct {
	code int
	msg  string
}

func (e exitErr) Error() string { return e.msg }

func noSuch(name string) string { return "Error response from daemon: No such container: " + name }

func newID() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

func imageID(image string) string {
	h := sha256.Sum256([]byte(image))
	return "sha256:" + hex.EncodeToString(h[:])
}

// takeOpt matches args[i] against the option names that take a value, in the forms "-o v",
// "--opt v" and "--opt=v", and returns the value and the next index.
func takeOpt(args []string, i int, names ...string) (string, int, bool) {
	a := args[i]
	for _, n := range names {
		if a == n {
			if i+1 >= len(args) {
				die(125, "flag needs an argument: %s", n)
			}
			return args[i+1], i + 2, true
		}
		if strings.HasPrefix(a, n+"=") {
			return a[len(n)+1:], i + 1, true
		}
	}
	return "", i, false
}

// --- inspect

type inspectJSON struct {
	ID      string `json:"Id"`
	Name    string `json:"Name"`
	Created string `json:"Created"`
	State   struct {
		Status  string `json:"Status"`
		Running bool   `json:"Running"`
	} `json:"State"`
	Config struct {
		Image  string            `json:"Image"`
		Labels map[string]string `json:"Labels"`
		User   string            `json:"User"`
		Cmd    []string          `json:"Cmd"`
	} `json:"Config"`
	HostConfig struct {
		Init       bool     `json:"Init"`
		Binds      []string `json:"Binds"`
		ExtraHosts []string `json:"ExtraHosts"`
	} `json:"HostConfig"`
	Mounts []mountJSON `json:"Mounts"`
}

type mountJSON struct {
	Type        string `json:"Type"`
	Source      string `json:"Source"`
	Destination string `json:"Destination"`
	RW          bool   `json:"RW"`
}

func splitBind(b string) (src, dst string, rw bool) {
	parts := strings.Split(b, ":")
	src, dst, rw = parts[0], parts[0], true
	if len(parts) > 1 {
		dst = parts[1]
	}
	if len(parts) > 2 && slices.Contains(strings.Split(parts[2], ","), "ro") {
		rw = false
	}
	return
}

func toJSON(c *fdstate.Container) inspectJSON {
	var j inspectJSON
	j.ID = c.ID
	j.Name = "/" + c.Name
	j.Created = c.Created.UTC().Format(time.RFC3339Nano)
	j.State.Status = c.State
	j.State.Running = c.State == "running"
	j.Config.Image = c.Image
	j.Config.Labels = c.Labels
	if j.Config.Labels == nil {
		j.Config.Labels = map[string]string{}
	}
	j.Config.User = c.User
	j.Config.Cmd = c.Cmd
	j.HostConfig.Init = c.Init
	j.HostConfig.Binds = c.Binds
	j.HostConfig.ExtraHosts = c.ExtraHosts
	j.Mounts = []mountJSON{}
	for _, b := range c.Binds {
		src, dst, rw := splitBind(b)
		typ := "bind"
		if !filepath.IsAbs(src) {
			typ = "volume"
		}
		j.Mounts = append(j.Mounts, mountJSON{Type: typ, Source: src, Destination: dst, RW: rw})
	}
	return j
}

func inspect(args []string) {
	var names []string
	for i := 0; i < len(args); {
		if v, n, ok := takeOpt(args, i, "--type"); ok {
			if v != "container" {
				die(1, "fakedocker: inspect --type %s is not supported", v)
			}
			i = n
			continue
		}
		if strings.HasPrefix(args[i], "-") {
			die(125, "unknown flag: %s", args[i])
		}
		names = append(names, args[i])
		i++
	}
	if len(names) == 0 {
		die(1, `"docker inspect" requires at least 1 argument.`)
	}
	st, err := fdstate.Read(dir)
	if err != nil {
		die(2, "fakedocker: state: %v", err)
	}
	out := []inspectJSON{}
	var missing []string
	for _, n := range names {
		if c := st.Find(n); c != nil {
			out = append(out, toJSON(c))
		} else {
			missing = append(missing, n)
		}
	}
	b, _ := json.MarshalIndent(out, "", "    ")
	os.Stdout.Write(append(b, '\n'))
	if len(missing) > 0 {
		for _, n := range missing {
			fmt.Fprintln(os.Stderr, noSuch(n))
		}
		os.Exit(1)
	}
	os.Exit(0)
}

// --- ps

func ps(args []string) {
	var filters []string
	all := false
	for i := 0; i < len(args); {
		switch args[i] {
		case "-a", "--all":
			all = true
			i++
			continue
		case "-q", "--quiet", "--no-trunc", "-aq", "-qa":
			if strings.Contains(args[i], "a") && !strings.HasPrefix(args[i], "--") {
				all = true
			}
			i++
			continue
		}
		if v, n, ok := takeOpt(args, i, "--filter", "-f"); ok {
			filters = append(filters, v)
			i = n
			continue
		}
		die(125, "unknown flag: %s", args[i])
	}
	st, err := fdstate.Read(dir)
	if err != nil {
		die(2, "fakedocker: state: %v", err)
	}
	// Docker lists the newest first.
	for i := len(st.Containers) - 1; i >= 0; i-- {
		c := st.Containers[i]
		if !all && c.State != "running" {
			continue
		}
		ok := true
		for _, f := range filters {
			k, v, _ := strings.Cut(f, "=")
			if k != "label" {
				die(1, "Error response from daemon: invalid filter '%s'", k)
			}
			lk, lv, hasV := strings.Cut(v, "=")
			got, has := c.Labels[lk]
			if !has || (hasV && got != lv) {
				ok = false
			}
		}
		if ok {
			fmt.Println(c.ID)
		}
	}
	os.Exit(0)
}

// --- create

func create(args []string) {
	c := &fdstate.Container{Args: slices.Clone(args), State: "created", Labels: map[string]string{}}
	i := 0
	for i < len(args) && strings.HasPrefix(args[i], "-") {
		if args[i] == "--" { // the end of the options: what follows is the image, even "--privileged"
			i++
			break
		}
		if args[i] == "--init" {
			c.Init = true
			i++
			continue
		}
		if v, n, ok := takeOpt(args, i, "--name"); ok {
			c.Name, i = v, n
			continue
		}
		if v, n, ok := takeOpt(args, i, "--label", "-l"); ok {
			k, val, _ := strings.Cut(v, "=")
			c.Labels[k], i = val, n
			continue
		}
		if v, n, ok := takeOpt(args, i, "--volume", "-v"); ok {
			c.Binds, i = append(c.Binds, v), n
			continue
		}
		if v, n, ok := takeOpt(args, i, "--add-host"); ok {
			c.ExtraHosts, i = append(c.ExtraHosts, v), n
			continue
		}
		if v, n, ok := takeOpt(args, i, "--user", "-u"); ok {
			c.User, i = v, n
			continue
		}
		die(125, "unknown flag: %s", args[i])
	}
	if i >= len(args) {
		die(125, `"docker create" requires at least 1 argument.`)
	}
	c.Image = args[i]
	c.Cmd = slices.Clone(args[i+1:])
	if !validRef(c.Image) {
		die(125, "docker: invalid reference format.")
	}
	for _, b := range c.Binds {
		src, _, _ := splitBind(b)
		if filepath.IsAbs(src) {
			if _, err := os.Stat(src); err != nil {
				die(1, "Error response from daemon: invalid mount config for type \"bind\": bind source path does not exist: %s", src)
			}
		}
	}
	update(func(s *fdstate.State) error {
		if c.Name != "" {
			if o := s.Find(c.Name); o != nil && o.Name == c.Name {
				return exitErr{1, fmt.Sprintf("Error response from daemon: Conflict. The container name \"/%s\" is already in use by container \"%s\". You have to remove (or rename) that container to be able to reuse that name.", c.Name, o.ID)}
			}
		}
		img := fdstate.NormImage(c.Image)
		if _, ok := s.Images[img]; !ok {
			if denied(c.Image) {
				return exitErr{1, fmt.Sprintf("Unable to find image '%s' locally\n%s", c.Image, deniedLine())}
			}
			if s.Images == nil {
				s.Images = map[string]string{}
			}
			s.Images[img] = imageID(img) // pulled
		}
		c.ID = newID()
		if c.Name == "" {
			c.Name = "standin_" + c.ID[:8]
		}
		c.Created = time.Now()
		s.Containers = append(s.Containers, c)
		return nil
	})
	fmt.Println(c.ID)
	os.Exit(0)
}

// --- start, stop, rm

func oneName(args []string, what string) string {
	if len(args) != 1 || strings.HasPrefix(args[0], "-") {
		die(125, "fakedocker: %s: want exactly one container, got %q", what, args)
	}
	return args[0]
}

func start(args []string) {
	name := oneName(args, "start")
	update(func(s *fdstate.State) error {
		c := s.Find(name)
		if c == nil {
			return exitErr{1, noSuch(name) + "\nfailed to start containers: " + name}
		}
		c.State = "running"
		return nil
	})
	fmt.Println(name)
	os.Exit(0)
}

func stop(args []string) {
	for len(args) > 0 && strings.HasPrefix(args[0], "-") {
		if _, n, ok := takeOpt(args, 0, "-t", "--time", "--timeout"); ok {
			args = args[n:]
			continue
		}
		die(125, "unknown flag: %s", args[0])
	}
	name := oneName(args, "stop")
	update(func(s *fdstate.State) error {
		c := s.Find(name)
		if c == nil {
			return exitErr{1, noSuch(name)}
		}
		s.KillRuns(c.Name)
		if c.State == "running" {
			c.State = "exited"
		}
		return nil
	})
	fmt.Println(name)
	os.Exit(0)
}

func rm(args []string) {
	force := false
	for len(args) > 0 && strings.HasPrefix(args[0], "-") {
		switch args[0] {
		case "-f", "--force":
			force = true
		default:
			die(125, "unknown flag: %s", args[0])
		}
		args = args[1:]
	}
	name := oneName(args, "rm")
	update(func(s *fdstate.State) error {
		c := s.Find(name)
		if c == nil {
			if force {
				return exitErr{0, ""}
			}
			return exitErr{1, noSuch(name)}
		}
		if c.State == "running" && !force {
			return exitErr{1, fmt.Sprintf("Error response from daemon: cannot remove container \"/%s\": container is running: stop the container before removing or force remove", c.Name)}
		}
		s.KillRuns(c.Name)
		s.Remove(c.Name)
		return nil
	})
	fmt.Println(name)
	os.Exit(0)
}

// --- images

// validRef reports whether image is a reference Docker takes: not empty, no option-like start, no
// space, lower-case repository (a rough check, enough for the tests).
func validRef(image string) bool {
	repo := image
	if i := strings.LastIndex(image, ":"); i > strings.LastIndex(image, "/") {
		repo = image[:i]
	}
	repo, _, _ = strings.Cut(repo, "@")
	return image != "" && !strings.HasPrefix(image, "-") && !strings.ContainsAny(image, " \t\n=") &&
		repo == strings.ToLower(repo)
}

// denied reports whether a pull of image is refused: the default image's repository is never in a
// registry (it is built on the machine).
func denied(image string) bool { return strings.HasPrefix(image, container.DefaultImageRepo+":") }

func deniedLine() string {
	return fmt.Sprintf("Error response from daemon: pull access denied for %s, repository does not exist or may require 'docker login'", container.DefaultImageRepo)
}

// positional is args split into the value of the option names (the last one given; "" when
// none) and the rest; "--" ends the options, and any other option is refused.
func positional(args []string, names ...string) (string, []string) {
	val := ""
	var rest []string
	for i := 0; i < len(args); {
		if args[i] == "--" {
			return val, append(rest, args[i+1:]...)
		}
		if len(names) > 0 {
			if v, n, ok := takeOpt(args, i, names...); ok {
				val, i = v, n
				continue
			}
		}
		if strings.HasPrefix(args[i], "-") {
			die(125, "unknown flag: %s", args[i])
		}
		rest = append(rest, args[i])
		i++
	}
	return val, rest
}

func imageInspect(args []string) {
	format, names := positional(args, "--format", "-f")
	if format != "{{.Id}}" || len(names) != 1 {
		die(1, "fakedocker: only `image inspect --format {{.Id}} <image>` is supported")
	}
	st, err := fdstate.Read(dir)
	if err != nil {
		die(2, "fakedocker: state: %v", err)
	}
	if id, ok := st.Images[fdstate.NormImage(names[0])]; ok {
		fmt.Println(id)
		os.Exit(0)
	}
	fmt.Println()
	die(1, "Error response from daemon: No such image: %s", names[0])
}

// pull is `docker pull [--] <image>`: after PullDelay the image is there, unless it is of the
// default image's repository (refused, as by a registry that does not have it).
func pull(args []string) {
	_, names := positional(args)
	if len(names) != 1 {
		die(1, `"docker pull" requires exactly 1 argument.`)
	}
	image := names[0]
	if !validRef(image) {
		die(1, "invalid reference format")
	}
	st, err := fdstate.Read(dir)
	if err != nil {
		die(2, "fakedocker: state: %v", err)
	}
	time.Sleep(st.PullDelay)
	if denied(image) {
		die(1, "%s", deniedLine())
	}
	img := fdstate.NormImage(image)
	update(func(s *fdstate.State) error {
		if s.Images == nil {
			s.Images = map[string]string{}
		}
		s.Images[img] = imageID(img)
		s.Pulls = append(s.Pulls, image)
		return nil
	})
	fmt.Printf("%s: Pulling from library\nDigest: %s\nStatus: Downloaded newer image for %s\n", image, imageID(img), img)
	os.Exit(0)
}

func build(args []string) {
	image := ""
	ctx := ""
	for i := 0; i < len(args); {
		if v, n, ok := takeOpt(args, i, "-t", "--tag"); ok {
			image, i = v, n
			continue
		}
		ctx = args[i]
		i++
	}
	if image == "" || ctx != "-" {
		die(1, "fakedocker: only `build -t <image> -` is supported")
	}
	df, err := io.ReadAll(os.Stdin)
	if err != nil {
		die(1, "fakedocker: reading the Dockerfile: %v", err)
	}
	st, err := fdstate.Read(dir)
	if err != nil {
		die(2, "fakedocker: state: %v", err)
	}
	time.Sleep(st.BuildDelay)
	img := fdstate.NormImage(image)
	update(func(s *fdstate.State) error {
		if s.Images == nil {
			s.Images = map[string]string{}
		}
		s.Images[img] = imageID(img)
		s.Builds = append(s.Builds, fdstate.Build{Image: image, Dockerfile: string(df)})
		return nil
	})
	fmt.Printf("Successfully built %s\nSuccessfully tagged %s\n", imageID(img)[7:19], image)
	os.Exit(0)
}

// --- exec

func execCmd(args []string) {
	var env []string
	workdir := ""
	hasW := false
	i := 0
	for i < len(args) && strings.HasPrefix(args[i], "-") {
		switch args[i] {
		case "-i", "-t", "-it", "-ti", "--interactive", "--tty":
			i++
			continue
		}
		if v, n, ok := takeOpt(args, i, "-w", "--workdir"); ok {
			workdir, hasW, i = v, true, n
			continue
		}
		if v, n, ok := takeOpt(args, i, "-e", "--env"); ok {
			if !strings.Contains(v, "=") {
				if val, set := os.LookupEnv(v); set {
					env = append(env, v+"="+val)
				}
			} else {
				env = append(env, v)
			}
			i = n
			continue
		}
		if _, n, ok := takeOpt(args, i, "-u", "--user"); ok {
			i = n
			continue
		}
		die(125, "unknown flag: %s", args[i])
	}
	if i+1 >= len(args) {
		die(125, `"docker exec" requires at least 2 arguments.`)
	}
	name, argv := args[i], args[i+1:]
	st, err := fdstate.Read(dir)
	if err != nil {
		die(2, "fakedocker: state: %v", err)
	}
	c := st.Find(name)
	if c == nil {
		die(1, "%s", noSuch(name))
	}
	if c.State != "running" {
		die(1, "Error response from daemon: container %s is not running", c.ID)
	}
	cwd := dir
	if hasW {
		// /tmp is in every image: Claude's runs that have no folder of their own work in it.
		ok := workdir == "/tmp"
		for _, b := range c.Binds {
			_, dst, _ := splitBind(b)
			if rel, err := filepath.Rel(dst, workdir); err == nil && filepath.IsAbs(workdir) && rel != ".." && !strings.HasPrefix(rel, "../") {
				ok = true
				break
			}
		}
		if !ok {
			die(126, "OCI runtime exec failed: exec failed: unable to start container process: chdir to cwd (\"%s\") set in config.json failed: no such file or directory", workdir)
		}
		cwd = workdir
	}
	var childEnv []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, fdstate.EnvPrefix) {
			childEnv = append(childEnv, kv)
		}
	}
	childEnv = append(childEnv, env...)
	runID := ""
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "AIWB_RUN="); ok {
			runID = v
		}
	}

	if len(argv) >= 4 && argv[0] == "/bin/sh" && argv[1] == "-c" {
		switch argv[3] {
		case container.RunName:
			runWrapped(c.Name, runID, false, argv[4:], cwd, childEnv)
		case container.RunTTYName:
			if len(argv) < 5 {
				die(2, "aiwb-run-tty: the quoted command is missing")
			}
			runWrapped(c.Name, runID, true, argv[5:], cwd, childEnv)
		case container.KillName:
			if len(argv) < 5 {
				os.Exit(2)
			}
			kill(argv[4])
		}
	}
	cmd := command(argv, cwd, childEnv)
	if err := cmd.Start(); err != nil {
		startFailed(argv[0], err)
	}
	os.Exit(status(cmd.Wait()))
}

func command(argv []string, cwd string, env []string) *exec.Cmd {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir, cmd.Env = cwd, env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd
}

func startFailed(prog string, err error) {
	die(127, "OCI runtime exec failed: exec failed: unable to start container process: exec: %q: %v", prog, err)
}

func status(err error) int {
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return 137
		}
		return ee.ExitCode()
	}
	fmt.Fprintln(os.Stderr, "fakedocker:", err)
	return 1
}

func runWrapped(cname, runID string, tty bool, argv []string, cwd string, env []string) {
	if len(argv) == 0 {
		die(2, "%s: no command", container.RunName)
	}
	cmd := command(argv, cwd, env)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		startFailed(argv[0], err)
	}
	r := &fdstate.Run{ID: runID, Container: cname, Pgid: cmd.Process.Pid, TTY: tty, Live: true}
	update(func(s *fdstate.State) error {
		s.Runs = append(s.Runs, r)
		return nil
	})
	code := status(cmd.Wait())
	update(func(s *fdstate.State) error {
		for _, x := range s.Runs {
			if x.Pgid == r.Pgid && x.ID == r.ID {
				x.Live = false
			}
		}
		return nil
	})
	os.Exit(code)
}

func kill(runID string) {
	if runID == "" || strings.Trim(runID, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != "" {
		os.Exit(2) // as KillScript
	}
	update(func(s *fdstate.State) error {
		if r := s.FindRun(runID); r != nil && r.Live {
			fdstate.KillRun(r)
		} else {
			fdstate.KillEnv(runID)
		}
		s.Kills = append(s.Kills, runID)
		return nil
	})
	os.Exit(0)
}
