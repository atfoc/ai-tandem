package app

import (
	"errors"
	"slices"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// DropRemoteGroup is the change-over of a server from before level 5, which put everything an API
// client made into one group, "Remote", and remembered that group's id in state.json
// ("remoteGroup"). It removes the group the file names, whatever its name is now and whoever put
// things in it: its boards and its plain chats go to no group and keep their own archive
// marks (a chat on a board stays there), and a group nested in it goes to the top
// level with what is in it. Then the id is forgotten, so this runs once. A group that is merely
// named "Remote" is an ordinary group and stays.
//
// It is called at the server's start, after boards and chats are loaded and before a
// request is served: nobody is told. An error leaves the id in state.json and the next start
// goes on where this one stopped: what was moved out stays out.
func (a *App) DropRemoteGroup() error {
	var id string
	there := false
	a.St.Read(func(s *model.State) {
		id = s.RemoteGroup
		there = id != "" && groupIndex(s.Groups, id) >= 0
	})
	if id == "" {
		return nil
	}
	if there {
		in := map[string]bool{id: true}
		for _, b := range a.boardsIn(in) {
			if err := a.Boards.Move(b.ID, model.Ungrouped); err != nil {
				return err
			}
		}
		for _, c := range a.plainChatsIn(in) {
			if err := a.Chats.Move(c.ID, model.Ungrouped); err != nil && !errors.Is(err, chats.ErrNotFound) {
				return err
			}
		}
	}
	return a.St.Update(func(s *model.State) error {
		s.Groups = slices.DeleteFunc(s.Groups, func(g model.Group) bool { return g.ID == id })
		for i := range s.Groups {
			if s.Groups[i].Parent == id {
				s.Groups[i].Parent = ""
			}
		}
		delete(s.Defaults.Groups, id)
		s.RemoteGroup = ""
		return nil
	})
}
