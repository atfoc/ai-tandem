package agent

import "errors"

// listProcs is not available on Windows: the processes an agent started are not adopted (the
// process tree is ended through its leader, see KillGroup).
func listProcs() ([]procInfo, error) {
	return nil, errors.New("listing processes is not supported on Windows")
}
