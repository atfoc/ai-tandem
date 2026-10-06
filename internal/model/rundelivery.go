package model

// RunDeliveryState says where a run's result is with respect to the person's folder.
type RunDeliveryState string

const (
	DeliveryNone    RunDeliveryState = "none"    // nothing to apply (reason no_git or no_changes)
	DeliveryPending RunDeliveryState = "pending" // not applied; Apply is expected to work
	DeliveryApplied RunDeliveryState = "applied"
	DeliveryBlocked RunDeliveryState = "blocked" // not applied; the person has to do something first
)

// RunDelivery is the last attempt to apply a run's result to the person's folder: made by the
// run's end, or by a person. Absent for a draft and for a live run.
type RunDelivery struct {
	State   RunDeliveryState `json:"state"`
	Reason  string           `json:"reason,omitempty"`  // none: no_git|no_changes; pending: manual|not_achieved|halted|other_branch|history_changed; blocked: local_changes|conflict|busy|folder_missing|not_repo|result_missing|git
	Auto    bool             `json:"auto,omitempty"`    // tried by the run's end, not by a person
	At      int64            `json:"at,omitempty"`      // ms: when applied or last tried
	Result  string           `json:"result,omitempty"`  // the commit to apply (integration head)
	Commit  string           `json:"commit,omitempty"`  // applied: the folder's HEAD afterwards
	How     string           `json:"how,omitempty"`     // applied: "ff" | "merge" | "already"
	Branch  string           `json:"branch,omitempty"`  // the folder's branch when tried; "" = detached
	Files   []string         `json:"files,omitempty"`   // local_changes, conflict: at most 50 paths
	More    int              `json:"more,omitempty"`    // paths left out
	Detail  string           `json:"detail,omitempty"`  // reason git: git's words
	Partial bool             `json:"partial,omitempty"` // the run is not completed
}
