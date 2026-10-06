// What a chat's agent and its subagents have cost. Only the manager sees every turn end (also of
// turns nobody waits for, and of subagents), so the sum is kept here, in chat.json
// (model.ChatMeta.Cost), for the chats of a run: a run's agents and the chats people open on it.
//
// The adapters report raw numbers and no two kinds mean the same by them:
//
//   - Claude reports a total per process. A resumed process starts again from what an earlier
//     process of the session had reached when it exited in an orderly way, and from 0 when that
//     one was killed, so neither the sum of the totals nor the newest one is what was spent.
//   - pi reports a total per session, across processes.
//   - Cursor reports nothing.
//
// The tokens (input, output, cache read, cache write) come with the cost and are kept the same
// way. Peak is the largest context a request of the chat's own agent was made with, from EvUsage.
package chats

import (
	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// costSample applies what ev, a turn end of a chat's own agent, reports to k. first says the
// report is the first of its process.
//
// Claude: what a process has spent is its total less the total it started from, its baseline. The
// first report of a process closes the process before it (its last total less its baseline goes
// to Sum) and finds the new baseline: CumOutTokens - OutTokens is what the session had put out
// before this process, and the baseline is the total that was reported with that output count, 0
// when the session had put out nothing or no such report is known. Marks keeps the reports a later
// process can start from: the one this process started from and this process's newest. Two are
// enough, because a process starts from the last one that exited in an orderly way, and that is
// either the process before it or the one that process started from.
//
// The tokens are counted as the cost is, in the same branches: a result line's four counts are
// cumulative for the process and start from those of the line the cost's baseline was found at.
// Result lines are never summed.
func costSample(k *model.ChatCost, kind model.AgentKind, first bool, ev agent.Event) {
	switch kind {
	case model.Claude:
		if !ev.HasCost {
			return
		}
		if first {
			k.Sum += k.Last - k.Base
			k.TokSum = tokAdd(k.TokSum, tokSub(k.TokLast, k.TokBase))
			k.Base, k.TokBase = 0, model.TokenCount{}
			var from []model.CostMark
			if baseOut := ev.CumOutTokens - ev.OutTokens; baseOut > 0 {
				found := -1
				for i, mk := range k.Marks {
					// The largest count not past baseOut; among equal counts the newest report.
					if mk.Out <= baseOut && (found < 0 || mk.Out >= k.Marks[found].Out) {
						found = i
					}
				}
				if found >= 0 {
					k.Base, k.TokBase = k.Marks[found].USD, k.Marks[found].Tok
					from = []model.CostMark{k.Marks[found]}
				}
			}
			k.Marks = from
			k.TokLast = k.TokBase // until this process reports its own
			if ev.HasTokens {
				// A count below the baseline's did not start from it: the process counts it from 0.
				k.TokBase = tokBaseFor(k.TokBase, ev.CumTokens)
			}
		}
		if ev.HasTokens {
			k.TokLast = ev.CumTokens
			k.TokKnown = true
		}
		mark := model.CostMark{Out: ev.CumOutTokens, USD: ev.CostUSD, Tok: k.TokLast}
		if n := len(k.Marks); n > 0 && !first {
			k.Marks[n-1] = mark // this process's report before
		} else {
			k.Marks = append(k.Marks, mark)
		}
		k.Last = ev.CostUSD
		k.Known = true
	case model.Pi:
		if ev.HasCost {
			k.Last = ev.CostUSD
			k.Known = true
		}
		if ev.HasTokens {
			k.TokLast = ev.CumTokens
			k.TokKnown = true
		}
	}
}

// costFresh closes the session k counts: the chat's agent starts a new one (OwnedSend.Fresh).
// What the session cost stays in the sum.
func costFresh(k *model.ChatCost) {
	k.Sum += k.Last - k.Base
	k.Base, k.Last, k.Marks = 0, 0, nil
	k.TokSum = tokAdd(k.TokSum, tokSub(k.TokLast, k.TokBase))
	k.TokBase, k.TokLast = model.TokenCount{}, model.TokenCount{}
}

// costTotal is what k comes to.
func costTotal(k *model.ChatCost) Cost {
	if k == nil {
		return Cost{}
	}
	return Cost{USD: k.Sum + (k.Last - k.Base) + k.Subs, Known: k.Known, Partial: k.Lost > 0,
		Tokens:      tokAdd(tokAdd(k.TokSum, tokSub(k.TokLast, k.TokBase)), k.TokSubs),
		TokensKnown: k.TokKnown, Peak: k.Peak}
}

func tokAdd(a, b model.TokenCount) model.TokenCount {
	return model.TokenCount{In: a.In + b.In, Out: a.Out + b.Out, CacheRead: a.CacheRead + b.CacheRead, CacheWrite: a.CacheWrite + b.CacheWrite}
}

func tokSub(a, b model.TokenCount) model.TokenCount {
	return model.TokenCount{In: a.In - b.In, Out: a.Out - b.Out, CacheRead: a.CacheRead - b.CacheRead, CacheWrite: a.CacheWrite - b.CacheWrite}
}

// tokBaseFor is the token baseline of a process whose first report is cum, found at base: each
// count of base that cum has reached, and 0 for one it has not.
func tokBaseFor(base, cum model.TokenCount) model.TokenCount {
	keep := func(b, c int64) int64 {
		if c < b {
			return 0
		}
		return b
	}
	return model.TokenCount{In: keep(base.In, cum.In), Out: keep(base.Out, cum.Out),
		CacheRead: keep(base.CacheRead, cum.CacheRead), CacheWrite: keep(base.CacheWrite, cum.CacheWrite)}
}

// costOf is the cost record of the chat object c, made when it has none; nil for a chat that is
// not on a run, whose cost is not kept. c.mu held.
func costOf(c *Chat) *model.ChatCost {
	if c.meta.Run == "" {
		return nil
	}
	if c.meta.Cost == nil {
		c.meta.Cost = &model.ChatCost{}
	}
	return c.meta.Cost
}

// costTurnEnd counts the cost and the tokens ev, a turn end of c's own agent, reports. The caller writes
// chat.json, as it does at every turn end. c.mu held.
func costTurnEnd(c *Chat, ev agent.Event) {
	if !ev.HasCost && !ev.HasTokens {
		return
	}
	if k := costOf(c); k != nil {
		costSample(k, c.meta.Agent, c.costFirst, ev)
		// Claude's baseline is found by its cost report, so only that one ends the first.
		c.costFirst = c.costFirst && !ev.HasCost
	}
}

// costSubEnd counts the cost and the tokens ev, the turn end of an app-spawned subagent of c, reports: a
// subagent is one process with one turn, so what it reports is what it cost. It reports whether
// the record changed; the caller then writes chat.json. c.mu held.
func costSubEnd(c *Chat, ev agent.Event) bool {
	k := costOf(c)
	if k == nil || (!ev.HasCost && !ev.HasTokens) {
		return false
	}
	if ev.HasCost {
		k.Subs += ev.CostUSD
		k.Known = true
	}
	if ev.HasTokens {
		k.TokSubs = tokAdd(k.TokSubs, ev.CumTokens)
		k.TokKnown = true
	}
	return true
}

// costLost counts a process of c's own agent that ended, or was stopped, in a turn. For Claude
// what that turn spent is in no report: a process reports a turn when it ends. pi's total is the
// session's, which the next report still covers, and Cursor reports nothing. It reports whether
// the record changed. c.mu held.
func costLost(c *Chat, kind model.AgentKind) bool {
	k := costOf(c)
	if k == nil || kind != model.Claude {
		return false
	}
	k.Lost++
	return true
}

// costSubLost is costLost for an app-spawned subagent of c, of kind, that ended or was stopped
// without a turn end: its one turn is all it has, so what it spent is lost for every kind that
// reports a cost. c.mu held.
func costSubLost(c *Chat, kind model.AgentKind) bool {
	k := costOf(c)
	if k == nil || (kind != model.Claude && kind != model.Pi) {
		return false
	}
	k.Lost++
	return true
}

// countInterrupted is costLost for a chat object read at boot whose chat.json says a turn was
// running: the server ended, or was ended, in that turn. Nothing is written here: the count
// reaches chat.json with the next write, which is also the one that clears the turn's mark.
func countInterrupted(c *Chat) {
	if c.meta.TurnActive {
		costLost(c, c.meta.Agent)
	}
}
