//go:build !windows

package agent

import (
	"os/exec"
	"strconv"
	"strings"
)

// listProcs lists every process of the machine with its parent and its group. A line that does
// not read as three numbers is skipped.
func listProcs() ([]procInfo, error) {
	out, err := exec.Command("ps", "-A", "-o", "pid=,ppid=,pgid=").Output()
	if err != nil {
		return nil, err
	}
	var ps []procInfo
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) != 3 {
			continue
		}
		var n [3]int
		ok := true
		for i, s := range f {
			if n[i], err = strconv.Atoi(s); err != nil {
				ok = false
			}
		}
		if ok {
			ps = append(ps, procInfo{pid: n[0], ppid: n[1], pgid: n[2]})
		}
	}
	return ps, nil
}
