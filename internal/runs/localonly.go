package runs

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"slices"

	"ai-whiteboard/internal/model"
)

// keptFor is what is read of a run.json that RunMeta does not have: the server an earlier
// version of the app kept a run that has not started for, and what it knew of a start there. It
// is read by LocalOnly and never written.
type keptFor struct {
	Server      string `json:"server"`
	RemoteStart string `json:"remoteStart"`
}

// LocalOnly makes the runs an earlier version of the app kept here for another server runs of
// this computer. Such a run has not started: it was to start on that server, and its run.json
// names it ("server"). It is called once at every start, after Load and before a page is served;
// with no such run it reads the run.json of each run that has not started and changes nothing.
//
// Each of those runs gets the agent, tiers, folder, limits and set-up command a new run in its
// place begins with here, and keeps its id, name, group, goal draft and archive mark. Nothing is
// known of a start any more, and neither chats on the run nor an archive mark stand in the way.
//
// local are the ids of the runs that were put here, sorted. A run that could not be written is
// logged and left for the next start; err is the first such error.
func (s *Service) LocalOnly() (local []string, err error) {
	for _, r := range s.all() {
		if meta, _ := r.svcMetaRec(); !meta.Started.IsZero() {
			continue
		}
		raw, e := os.ReadFile(filepath.Join(r.dir, fileMeta))
		if e != nil {
			continue // nothing on disk names a server
		}
		var old keptFor
		if json.Unmarshal(raw, &old) != nil || old.Server == "" && old.RemoteStart == "" {
			continue
		}
		unlock := s.svcLock(r.id)
		e = s.svcSetMeta(r, func(m *model.RunMeta) error {
			if old.Server != "" {
				s.svcChoose(m)
			}
			return nil
		})
		unlock()
		if e != nil {
			log.Printf("runs: %s is not put on this computer: %v", r.id, e)
			if err == nil {
				err = e
			}
			continue
		}
		s.svcRefreshFacts(r) // of a folder on this computer
		local = append(local, r.id)
	}
	slices.Sort(local)
	return local, err
}
