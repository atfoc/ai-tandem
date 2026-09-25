package cursor

import (
	"errors"
	"fmt"
	"os"
	"time"

	"ai-whiteboard/internal/model"
)

// Catalog runs a short-lived `agent acp` in os.TempDir() only to read the model list.
// It sends no prompt and never changes the model, so the user's default model stays as it is.
func (s *Spawner) Catalog(timeout time.Duration) (*model.Catalog, error) {
	dir := os.TempDir()
	conn, err := Start(s.bin(), []string{"acp"}, dir)
	if err != nil {
		return nil, fmt.Errorf("cannot start Cursor (%s): %w", s.bin(), err)
	}
	defer conn.Close()

	type result struct {
		cat *model.Catalog
		err error
	}
	ch := make(chan result, 1)
	go func() {
		if _, err := conn.Call("initialize", initializeParams()); err != nil {
			ch <- result{err: err}
			return
		}
		if _, err := conn.Call("authenticate", map[string]any{"methodId": "cursor_login"}); err != nil {
			ch <- result{err: err}
			return
		}
		res, err := conn.Call("session/new", map[string]any{"cwd": dir, "mcpServers": []any{}})
		if err != nil {
			ch <- result{err: err}
			return
		}
		cat := ParseCatalog(res)
		if cat == nil {
			ch <- result{err: errors.New("Cursor reported no models")}
			return
		}
		ch <- result{cat: cat}
	}()

	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case r := <-ch:
		if r.err != nil {
			return nil, r.err
		}
		s.remember(r.cat)
		return r.cat, nil
	case <-t.C:
		return nil, fmt.Errorf("Cursor did not report its models within %s", timeout)
	}
}
