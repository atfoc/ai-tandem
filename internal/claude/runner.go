package claude

import (
	"context"
	"os"
	"os/exec"

	"ai-whiteboard/internal/agent"
)

// bin is the program the spawner starts: Bin, else "claude".
func (s *Spawner) bin() string {
	if s.Bin == "" {
		return "claude"
	}
	return s.Bin
}

// scratchDir is the folder of the runs that have no folder of their own (the catalog probe,
// auth status, login, logout, usage): the temp folder on the host; "/tmp" in a Runner's place,
// whose temp folder is not the host's (a container has /tmp, and so has the host).
func (s *Spawner) scratchDir() string {
	if s.Runner != nil {
		return "/tmp"
	}
	return os.TempDir()
}

// command makes, not started, the process that runs the spawner's program with args in dir,
// with env ("NAME=value") added: through s.Runner when it has one, else on the host with this
// process's environment. The Run is never nil; its Kill and Release are nil on the host. ctx bounds
// only the Runner's preparation of its place (a container start), not the process. The caller
// ends every run it got with killRun (cut short) or agent.ReleaseRun (never started, or waited for
// and ended by itself, never before the wait), as agent.Run says.
func (s *Spawner) command(ctx context.Context, dir string, env []string, args ...string) (*exec.Cmd, *agent.Run, error) {
	if s.Runner == nil {
		cmd := exec.Command(s.bin(), args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), env...)
		return cmd, &agent.Run{Cmd: cmd}, nil
	}
	run, err := s.Runner.Command(ctx, dir, env, append([]string{s.bin()}, args...))
	if err != nil {
		return nil, nil, err
	}
	return run.Cmd, run, nil
}

// killRun ends, where it runs, what run started (a container's run group); nothing on the host.
func killRun(run *agent.Run) {
	if run != nil && run.Kill != nil {
		run.Kill()
	}
}
