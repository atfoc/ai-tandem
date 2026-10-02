package pi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// piModel is one model of get_available_models' data (the fields the catalog needs).
type piModel struct {
	ID               string                     `json:"id"`
	Name             string                     `json:"name"`
	Provider         string                     `json:"provider"`
	Reasoning        bool                       `json:"reasoning"`
	ThinkingLevelMap map[string]json.RawMessage `json:"thinkingLevelMap"`
	ContextWindow    int                        `json:"contextWindow"`
}

// reasoningLevels is the base thinking-level list of a reasoning model; a level the model maps
// to null is removed, xhigh and max are added only when the model defines them non-null.
var reasoningLevels = []string{"off", "minimal", "low", "medium", "high"}

// catalogFrom builds the app catalog from get_state's and get_available_models' data. It returns
// nil when no model is available (pi without auth exits before answering, so callers see the
// stderr tail instead).
func catalogFrom(stateData, modelsData json.RawMessage) *model.Catalog {
	var answer struct {
		Models []piModel `json:"models"`
	}
	if json.Unmarshal(modelsData, &answer) != nil || len(answer.Models) == 0 {
		return nil
	}
	cat := &model.Catalog{Models: make([]model.CatalogModel, 0, len(answer.Models))}
	for _, m := range answer.Models {
		cm := model.CatalogModel{ID: qualifiedID(m.Provider, m.ID), Label: m.Name, Provider: m.Provider, ContextWindow: m.ContextWindow}
		if cm.Label == "" {
			cm.Label = m.ID
		}
		if m.Reasoning {
			cm.Efforts = effortsFor(m.ThinkingLevelMap)
			cm.DefaultEffort = defaultEffort(cm.Efforts)
		}
		cat.Models = append(cat.Models, cm)
	}

	// Default: the model get_state currently uses when it is offered, else the first one.
	def := ""
	var st struct {
		Model struct {
			ID       string `json:"id"`
			Provider string `json:"provider"`
		} `json:"model"`
	}
	if json.Unmarshal(stateData, &st) == nil && st.Model.ID != "" {
		def = qualifiedID(st.Model.Provider, st.Model.ID)
	}
	chosen := cat.Models[0]
	if m := findCatalogModel(cat, def); m != nil {
		chosen = *m
	}
	cat.Default = model.ModelChoice{Model: chosen.ID, Effort: chosen.DefaultEffort}
	return cat
}

// qualifiedID is a model's provider-qualified catalog id: "provider/id", or just id when the
// provider is unknown.
func qualifiedID(provider, id string) string {
	if provider == "" {
		return id
	}
	return provider + "/" + id
}

// effortsFor derives a model's supported thinking levels: the base list minus levels the model
// maps to null, plus xhigh/max when the map defines them non-null.
func effortsFor(levelMap map[string]json.RawMessage) []string {
	out := make([]string, 0, len(reasoningLevels)+2)
	for _, level := range reasoningLevels {
		if !levelNull(levelMap, level) {
			out = append(out, level)
		}
	}
	for _, level := range []string{"xhigh", "max"} {
		if levelDefined(levelMap, level) {
			out = append(out, level)
		}
	}
	return out
}

// levelNull reports whether the model's thinkingLevelMap names the level and maps it to null.
func levelNull(levelMap map[string]json.RawMessage, level string) bool {
	raw, ok := levelMap[level]
	return ok && bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// levelDefined reports whether the model's thinkingLevelMap names the level with a real value.
func levelDefined(levelMap map[string]json.RawMessage, level string) bool {
	raw, ok := levelMap[level]
	return ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// defaultEffort is the level a model starts at: medium when supported, else the first non-off
// level, else off, else none.
func defaultEffort(efforts []string) string {
	for _, e := range efforts {
		if e == "medium" {
			return "medium"
		}
	}
	for _, e := range efforts {
		if e != "off" {
			return e
		}
	}
	if len(efforts) > 0 {
		return efforts[0]
	}
	return ""
}

func findCatalogModel(cat *model.Catalog, id string) *model.CatalogModel {
	if id == "" {
		return nil
	}
	for i := range cat.Models {
		if cat.Models[i].ID == id {
			return &cat.Models[i]
		}
	}
	return nil
}

// Catalog asks a short-lived pi for its authenticated models (the boot refresh). It runs in the
// temp folder as `pi --mode rpc --no-session --no-extensions`, with no bridge and no extension,
// handshakes get_state + get_available_models, closes stdin and waits. Errors carry pi's stderr
// tail.
func (s *Spawner) Catalog(timeout time.Duration) (*model.Catalog, error) {
	bin, err := s.lookPath()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(bin, "--mode", "rpc", "--no-session", "--no-extensions")
	cmd.Dir = os.TempDir()
	cmd.Env = s.cleanEnv()
	stderr := &cappedBuffer{max: stderrCap}
	cmd.Stderr = stderr
	stdin, err1 := cmd.StdinPipe()
	stdout, err2 := cmd.StdoutPipe()
	if err := errors.Join(err1, err2); err != nil {
		return nil, err
	}
	if err := agent.StartGroup(cmd); err != nil {
		return nil, err
	}
	fail := func(err error) (*model.Catalog, error) {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return nil, fmt.Errorf("pi catalog: %v: %s", err, msg)
		}
		return nil, fmt.Errorf("pi catalog: %w", err)
	}

	rpc := newRPC(stdin, nil) // events are irrelevant for the catalog
	go rpc.readLoop(stdout)
	state, err := rpc.call("get_state", nil, timeout)
	if err == nil && !state.Success {
		err = fmt.Errorf("get_state: %s", state.Error)
	}
	var models rpcResponse
	if err == nil {
		models, err = rpc.call("get_available_models", nil, timeout)
		if err == nil && !models.Success {
			err = fmt.Errorf("get_available_models: %s", models.Error)
		}
	}
	stdin.Close()
	waited := make(chan struct{})
	go func() {
		cmd.Wait()
		agent.Exited(cmd)
		close(waited)
	}()
	select {
	case <-waited:
	case <-time.After(killGrace()):
		cmd.Process.Kill()
		<-waited
	}
	if err != nil {
		return fail(err)
	}
	cat := catalogFrom(state.Data, models.Data)
	if cat == nil {
		return fail(errors.New("no models reported"))
	}
	return cat, nil
}
