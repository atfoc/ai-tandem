package pi

import (
	"encoding/json"
	"errors"
	"fmt"

	"ai-whiteboard/internal/model"
)

// ContextSplit implements agent.ContextSplitter for a live process: get_session_stats gives the
// minimal used/free split. It is deliberately not a SplitReader: without a running process pi
// cannot report a split, and v1 has no offline session reader.
func (p *proc) ContextSplit() (model.ContextSplit, error) {
	select {
	case <-p.ready:
	case <-p.done:
		return model.ContextSplit{}, errors.New("pi exited before the context split could be read")
	}
	if p.readyErr != nil {
		return model.ContextSplit{}, p.readyErr
	}
	resp, err := p.rpc.call("get_session_stats", nil, rpcTimeout)
	if err != nil {
		return model.ContextSplit{}, err
	}
	if !resp.Success {
		return model.ContextSplit{}, fmt.Errorf("pi get_session_stats: %s", resp.Error)
	}
	var stats struct {
		ContextUsage *struct {
			Tokens        *int `json:"tokens"` // null right after compaction, until the next turn
			ContextWindow int  `json:"contextWindow"`
		} `json:"contextUsage"`
	}
	if json.Unmarshal(resp.Data, &stats) != nil {
		return model.ContextSplit{}, errors.New("pi get_session_stats: unreadable answer")
	}
	if stats.ContextUsage == nil || stats.ContextUsage.Tokens == nil {
		return model.ContextSplit{}, errors.New("pi does not report context usage right now")
	}
	tokens, window := *stats.ContextUsage.Tokens, stats.ContextUsage.ContextWindow
	free := window - tokens
	if free < 0 {
		free = 0
	}
	return model.ContextSplit{
		Total:  tokens,
		Window: window,
		Categories: []model.ContextCategory{
			{ID: "messages", Label: "Messages", Tokens: tokens, Kind: "used"},
			{ID: "free", Label: "Free", Tokens: free, Kind: "free"},
		},
	}, nil
}
