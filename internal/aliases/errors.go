package aliases

import (
	"errors"
	"fmt"
)

// The codes of the client API's refusals about accounts (the JSON "code" beside "error").
const (
	CodeNotMounted   = "not_mounted"        // MountError, not Pending
	CodeMountPending = "mount_pending"      // MountError, Pending
	CodeRemoved      = "alias_removed"      // ErrRemoved
	CodeDocker       = "docker_unavailable" // a *container.Unavailable
	CodeBadFolder    = "bad_folder"         // *FolderError
	CodeBadName      = "bad_name"           // ErrNoName
	CodeRestarting   = "alias_restarting"   // ErrRestarting
	CodeStopped      = "alias_stopped"      // ErrStopped
	CodePreparing    = "alias_preparing"    // ErrPreparing
	CodeBadImage     = "bad_image"          // *ImageError
)

// ErrRemoved is the refusal of anything a chat on a removed account asks (goal §4.2): the chat can
// be read, not continued.
var ErrRemoved = errors.New("This account was removed")

// ErrNotFound is the answer for an account id the server does not have.
var ErrNotFound = errors.New("No such account")

// ErrNotLoggedIn is why an account that is not logged in cannot be used (usable.Extra.Check).
var ErrNotLoggedIn = errors.New("Not logged in")

// ErrRestarting refuses a new run on an account whose container is being recreated or stopped
// (Restart, Edit, Stop): it would start in the old container and be killed a moment later.
var ErrRestarting = errors.New("The account's container is restarting; try again in a moment")

// ErrStopped answers what is read in an account's container (its plan usage) while the container
// does not run: no container is started just to read it (plan D24).
var ErrStopped = errors.New("Start the account to see its usage")

// ErrPreparing refuses a chat's process on an account whose container could not be made ready
// in the time a chat's start may wait (its image is still being built or pulled, or another
// change of the container takes long): the preparation goes on, and a later message finds it
// done.
var ErrPreparing = errors.New("The account's container is being prepared; try again in a moment")

// ErrNoName refuses an account without a name.
var ErrNoName = errors.New("An account needs a name")

// MountError refuses a message, a subagent or a fork of a chat on an account whose folder is not
// mounted in the account's container (goal §1.5). Its text is the banner's sentence.
type MountError struct {
	Account string // the account's name
	Folder  string // the chat's folder
	// Pending: the folder is saved for the account but its running container does not have it
	// yet (a restart applies it).
	Pending bool
}

func (e *MountError) Error() string {
	if e.Pending {
		return fmt.Sprintf("Restart %s to use this folder", e.Account)
	}
	return fmt.Sprintf("This folder isn't mounted in %s — Add it in Settings", e.Account)
}

// FolderError refuses one folder of an account's Input (goal §1.2.4 and §1.8): Why is the end of
// the sentence, "does not exist", "is not a folder", "has a “:” in its path, which Docker cannot
// mount", "is listed twice", "holds this computer's Claude login (~/.claude)", "holds the app's
// data folder", "is inside the app's data folder", "is inside this computer's Claude folder
// (~/.claude)".
type FolderError struct {
	Folder string
	Why    string
}

func (e *FolderError) Error() string { return e.Folder + " " + e.Why }

// ImageError refuses an account's image that is not an image reference Docker could take (goal
// §1.8.2: nothing of it may be read as an option of docker create).
type ImageError struct {
	Image string
}

func (e *ImageError) Error() string {
	return "“" + e.Image + "” is not an image name (like ubuntu:24.04 or registry.example.com/team/claude:1)"
}
