package runs

import "errors"

// Sentinel errors; the HTTP layer maps them in statusOf.
var (
	ErrNotFound   = errors.New("no such run")                                                   // 404
	ErrNoTask     = errors.New("no such task")                                                  // 404
	ErrNoAttempt  = errors.New("no such attempt")                                               // 404
	ErrNoVersion  = errors.New("no such version")                                               // 404
	ErrNoText     = errors.New("nothing recorded yet")                                          // 404: a report or changes that do not exist yet
	ErrArchived   = errors.New("the run is archived")                                           // 409
	ErrStarted    = errors.New("the run has started: its agent, folder and settings are fixed") // 409
	ErrNotStarted = errors.New("the run has not started")                                       // 409
	ErrFinished   = errors.New("the run is finished")                                           // 409
	ErrNotHalted  = errors.New("the run is not stopped")                                        // 409: resume of a run that runs
	ErrNotRunning = errors.New("the run is not running")                                        // 409: stop of a run that does not run
	ErrStopping   = errors.New("the run is stopping; try again in a moment")                    // 409
	ErrLimit      = errors.New("the limit that stopped the run must be raised to resume it")    // 409
	ErrGroup      = errors.New("no such group")                                                 // 404

	errEmptyName = errors.New("the name is empty")                     // 400
	errLongName  = errors.New("the name is longer than 80 characters") // 400
	errBadName   = errors.New("the name has a control character")      // 400
)

// ErrLive refuses applying the result of a run that is running or stopping: the result is still
// moving. 409.
var ErrLive = errors.New("the run is still going: its result can be applied when it has ended or is stopped")

// BlockedError is a start or resume refused because of how the run is set up; its text is
// RunView.Blocked. 409.
type BlockedError struct{ Reason string }

func (e *BlockedError) Error() string { return e.Reason }
