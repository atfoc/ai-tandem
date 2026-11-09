//go:build windows

package containertest

import (
	"errors"
	"time"
)

// The stand-in docker runs on Unix only; New skips the test before any of these is used.

type state struct {
	Mode       string
	Slow       time.Duration
	BuildDelay time.Duration
	PullDelay  time.Duration
	FailOn     map[string]string
	Images     map[string]string
	Builds     []struct{ Image, Dockerfile string }
	Pulls      []string
	Containers []*struct {
		ID, Name, State string
		Labels          map[string]string
		Image           string
		Binds           []string
		User            string
		Init            bool
		ExtraHosts      []string
		Cmd, Args       []string
	}
	Runs []*struct {
		ID, Container string
		Pgid          int
		TTY, Live     bool
	}
	Kills []string
}

func (s *state) Find(string) *struct {
	ID, Name, State string
	Labels          map[string]string
	Image           string
	Binds           []string
	User            string
	Init            bool
	ExtraHosts      []string
	Cmd, Args       []string
} {
	return nil
}

func (s *state) KillRuns(string) {}

var errUnix = errors.New("the stand-in docker runs on Unix only")

func readState(string) (*state, error)             { return nil, errUnix }
func updateState(string, func(*state) error) error { return errUnix }
func calls(string) ([][]string, error)             { return nil, errUnix }
func normImage(s string) string                    { return s }
func groupAlive(int) bool                          { return false }
