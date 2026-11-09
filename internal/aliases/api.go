package aliases

import "ai-whiteboard/internal/model"

// The client API's shapes (goal §3.8), mirrored field for field by packages/core/src/aliasesapi.ts.
//
//	GET    /api/aliases                     → List
//	POST   /api/aliases                     Input (name required) → View
//	PATCH  /api/aliases/{id}                Input → Change
//	DELETE /api/aliases/{id}                → {} (container removed, folder deleted)
//	POST   /api/aliases/{id}/restart        Force → Change (restart: done | busy)
//	POST   /api/aliases/{id}/stop           Force → Change (restart: done | busy)
//	POST   /api/aliases/{id}/login          → LoginAnswer (waiting with the URL, or preparing)
//	POST   /api/aliases/{id}/login/code     Code → LoginAnswer
//	DELETE /api/aliases/{id}/login          → {} (the login run is ended)
//	POST   /api/aliases/{id}/logout         → View
//
// Every change of an account's state (a record, its container, its login, its busy count,
// Docker's state) is sent to every client as the stream event {"type": EventAliases,
// "aliases": List}, whole; the snapshot carries the same List (app.APISnapshot.Aliases). The
// login URL and the code are in no event and no log: only in the answer to the call.

// EventAliases is the type of the stream event that carries the whole List.
const EventAliases = "aliases"

// List is the accounts of the server, as every client sees them.
type List struct {
	Docker       DockerState `json:"docker"`
	DefaultImage string      `json:"defaultImage"` // what Advanced › Image is prefilled with
	Host         Login       `json:"host"`         // the computer's own Claude Code: the first row
	Aliases      []View      `json:"aliases"`      // in the order they were added; never nil
}

// DockerState is whether Docker can be used now, and if not, why.
type DockerState struct {
	OK     bool   `json:"ok"`
	Kind   string `json:"kind,omitempty"`   // container.NotInstalled, NotRunning, Unsupported, Failed
	Reason string `json:"reason,omitempty"` // the sentence: "Docker is not running"
}

// Login is a login's state, as Claude's own `auth status` last said it.
type Login struct {
	Known    bool   `json:"known"` // auth status has answered (false: not asked yet, or it could not run)
	LoggedIn bool   `json:"loggedIn"`
	Email    string `json:"email,omitempty"`
	Error    string `json:"error,omitempty"`    // why auth status could not be read, when it could not
	InFlight bool   `json:"inFlight,omitempty"` // a login run of the account is open (on this or another device)
}

// The states of an account's container in ContainerView.
const (
	ContainerRunning     = "running"
	ContainerStopped     = "stopped"
	ContainerNone        = "none"               // not created yet (or removed); made when first needed
	ContainerPreparing   = "preparing"          // its image is being built: "Preparing the account's container…"
	ContainerUnavailable = "docker_unavailable" // Docker cannot be used: Reason says why
	ContainerError       = "error"              // the last create or start failed: Reason is Docker's line (an unshared folder)
)

// ContainerView is an account's container as the client shows it.
type ContainerView struct {
	Name   string `json:"name"` // container.Name(id)
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

// View is one account as every client sees it.
type View struct {
	Alias
	Kind      model.AgentKind `json:"kind"`
	Login     Login           `json:"login"`
	Container ContainerView   `json:"container"`
	// RestartNeeded: the saved image or mounts differ from the running container's (SpecDiffers
	// with the container running). Pending are the saved folders that container lacks.
	RestartNeeded bool     `json:"restartNeeded"`
	Pending       []string `json:"pending"` // never nil
	Busy          int      `json:"busy"`    // agents working in the container now (Work.Busy)
}

// Input is the body of POST and PATCH: a field left out is left as it is (POST: Name required,
// Mounts default to none, Image to ""). Mounts are absolute folders of the server's machine.
type Input struct {
	Name   *string   `json:"name,omitempty"`
	Mounts *[]string `json:"mounts,omitempty"`
	Image  *string   `json:"image,omitempty"`
}

// The outcomes of a change that may need the container recreated or stopped (Change.Restart).
const (
	RestartDone      = "done"      // recreated (or stopped) now
	RestartDeferred  = "deferred"  // no running container: the change is taken at its next start
	RestartBusy      = "busy"      // agents work in it: nothing was done; ask the person, then call again with force
	RestartUnchanged = "unchanged" // a PATCH that changed no image or mount (a rename)
)

// Change is the answer of PATCH, restart and stop.
type Change struct {
	Restart string `json:"restart"`
	Busy    int    `json:"busy,omitempty"` // with RestartBusy: how many agents work in it
	Alias   View   `json:"alias"`
}

// Force is the body of restart and stop: true once the person said yes to stopping the agents.
type Force struct {
	Force bool `json:"force"`
}

// Code is the body of POST …/login/code.
type Code struct {
	Code string `json:"code"`
}

// The states of a login run in LoginAnswer.
const (
	// LoginPreparing: the container is being made ready (its image built, which takes minutes the
	// first time); the login starts by itself once it is, and the client calls login again when
	// the "aliases" event shows the container running, which joins it and gets the URL.
	LoginPreparing = "preparing"
	LoginWaiting   = "waiting"   // the URL is out, a code is awaited (Error: the last code was refused)
	LoginLoggedIn  = "logged_in" // done: Email is the account's
	LoginFailed    = "failed"    // the run ended without a login: Error says why
)

// LoginAnswer is the answer of POST …/login and …/login/code.
type LoginAnswer struct {
	State string `json:"state"`
	URL   string `json:"url,omitempty"` // waiting: the URL to open in the person's browser
	Email string `json:"email,omitempty"`
	Error string `json:"error,omitempty"`
}
