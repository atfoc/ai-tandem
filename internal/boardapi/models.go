package boardapi

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// listSubagentModels answers list_subagent_models: the models spawn_subagent accepts for one
// agent, and what a spawn that omits model and effort uses. It reads the same catalog and the
// same resolution spawn_subagent validates with, on every call, and holds nothing between calls.
// It starts no probe and no process and never goes through the board-tool bridge.
func (r *Relay) listSubagentModels(caller chats.Caller, args json.RawMessage) (text string, isErr bool) {
	var p struct {
		Agent  string `json:"agent"`
		Filter string `json:"filter"`
	}
	if len(args) > 0 && string(args) != "null" {
		if err := json.Unmarshal(args, &p); err != nil {
			return "invalid list_subagent_models arguments", true
		}
	}
	kind := caller.Meta.Agent
	if p.Agent != "" {
		switch model.AgentKind(p.Agent) {
		case model.Claude, model.Cursor, model.Pi:
			kind = model.AgentKind(p.Agent)
		default:
			return fmt.Sprintf("unknown agent %q", p.Agent), true
		}
	}
	cat := r.Chats.SpawnCatalog(kind)
	_, dModel, dEffort, err := r.Chats.SpawnDefaults(caller.Meta.ID, kind)
	if err != nil {
		return err.Error(), true
	}
	if cat == nil {
		return strings.Join(unknownListLines(kind, kind == caller.Meta.Agent, dModel, dEffort), "\n"), false
	}

	matches := matchModels(cat.Models, p.Filter)
	filter := strings.Join(strings.Fields(p.Filter), " ")
	n, k := len(cat.Models), len(matches)
	var header string
	var body []string
	switch listForm(n, k, matches, filter != "") {
	case formRows:
		header, body = rowsAnswer(kind, n, k, filter, matches)
	case formWholeList:
		header, body = rowsAnswer(kind, n, k, filter, cat.Models)
	case formNoneMatch:
		header = noneMatchAnswer(kind, n, filter)
	case formOverview:
		header, body = overviewAnswer(kind, n, filter, matches, cat.Models)
	case formIDsOnly:
		header, body = idsOnlyAnswer(kind, n, filter, matches)
	}
	lines := append([]string{
		header,
		defaultsLine(kind, cat, dModel, dEffort),
		effortRuleLine(caller.Meta.Effort),
	}, body...)
	return strings.Join(lines, "\n"), false
}

// modelListCap is the most models list_subagent_models lists as rows; tunable after real use.
const modelListCap = 60

// An answerForm is the form list_subagent_models answers a known list in.
type answerForm int

const (
	formRows      answerForm = iota // the matches as rows
	formWholeList                   // a filter that matches nothing: every model as a row, with a note
	formNoneMatch                   // a filter that matches nothing in a list over the cap: no rows
	formOverview                    // matches over the cap: how many each id prefix has
	formIDsOnly                     // matches over the cap that share one id prefix: their ids alone
)

// listForm picks the form of an answer from the k matches among the n models of a list; filtered
// says whether the call had a filter. A list over the cap is never cut off, which could be read
// as complete: its answer changes form instead. The agent asked about plays no part.
func listForm(n, k int, matches []model.CatalogModel, filtered bool) answerForm {
	switch {
	case filtered && k == 0 && n <= modelListCap:
		return formWholeList
	case filtered && k == 0:
		return formNoneMatch
	case k <= modelListCap:
		return formRows
	case severalPrefixes(matches):
		return formOverview
	default:
		return formIDsOnly
	}
}

// idPrefix is a model id up to, and without, its last "/": "openrouter/openai" for
// "openrouter/openai/gpt-5", and "" for an id without "/".
func idPrefix(id string) string {
	if i := strings.LastIndexByte(id, '/'); i >= 0 {
		return id[:i]
	}
	return ""
}

// severalPrefixes reports whether models have two or more distinct id prefixes; the empty prefix
// counts as one.
func severalPrefixes(models []model.CatalogModel) bool {
	for _, m := range models {
		if idPrefix(m.ID) != idPrefix(models[0].ID) {
			return true
		}
	}
	return false
}

// rowsAnswer is the header and the body of an answer that lists rows as model rows: the k matches
// of the filter, or the whole list when k is 0.
func rowsAnswer(a model.AgentKind, n, k int, filter string, rows []model.CatalogModel) (header string, body []string) {
	for _, m := range rows {
		body = append(body, modelRow(m))
	}
	return modelsHeader(a, n, k, filter), body
}

// noneMatchAnswer is the header of the answer for a filter that matches none of the n models of a
// list over the cap. It has no body.
func noneMatchAnswer(a model.AgentKind, n int, filter string) string {
	return fmt.Sprintf("%s: none of the %s match filter %q. Call again without filter for an overview of the list.", a, countModels(n), filter)
}

// overCapLead begins the header of an answer whose matches, among the n models of agent a, are
// more than the cap. An empty filter is no filter.
func overCapLead(a model.AgentKind, n, k int, filter string) string {
	if filter == "" {
		return fmt.Sprintf("%s: %s, more than %d, so ", a, countModels(n), modelListCap)
	}
	return fmt.Sprintf("%s: %d of %s match filter %q, more than %d, so ", a, k, countModels(n), filter, modelListCap)
}

// overviewAnswer is the header and the body of an answer that counts matches per id prefix, one
// line per prefix in byte order. A prefix lists its ids as well when, set as the filter, it
// matches a model of all (the agent's whole list) outside its own group, because that filter then
// cannot isolate its models: "openai" matches the ids under "openrouter/openai", a label
// "OpenAI GPT" under another prefix, and the ids under "OpenAI". The group without a prefix
// always lists its ids: a filter cannot name it.
func overviewAnswer(a model.AgentKind, n int, filter string, matches, all []model.CatalogModel) (header string, body []string) {
	what := "Models"
	if filter != "" {
		what = "Matches"
	}
	header = overCapLead(a, n, len(matches), filter) + "they are not listed here. " + what + " per id prefix:"

	groups := map[string][]string{}
	for _, m := range matches {
		p := idPrefix(m.ID)
		groups[p] = append(groups[p], m.ID)
	}
	prefixes := slices.Sorted(maps.Keys(groups))
	for _, p := range prefixes {
		name := p
		if p == "" {
			name = "(no prefix)"
		}
		line := name + ": " + countModels(len(groups[p]))
		if slices.ContainsFunc(matchModels(all, p), func(m model.CatalogModel) bool { return idPrefix(m.ID) != p }) {
			line += ": " + strings.Join(groups[p], ", ")
		}
		body = append(body, line)
	}
	return header, append(body, "Call again with filter set to a prefix, or to an id shown above, to list those models with their efforts.")
}

// idsOnlyAnswer is the header and the body of an answer that lists matches by id alone, in
// catalog order.
func idsOnlyAnswer(a model.AgentKind, n int, filter string, matches []model.CatalogModel) (header string, body []string) {
	for _, m := range matches {
		body = append(body, m.ID)
	}
	header = overCapLead(a, n, len(matches), filter) + "only their ids are listed here."
	return header, append(body, "Call again with a narrower filter, for example one id from this list, to see labels and efforts.")
}

// matchModels keeps, in catalog order, the models whose id or label contains every word of
// filter, in any letter case. A filter without words keeps every model.
func matchModels(models []model.CatalogModel, filter string) []model.CatalogModel {
	terms := strings.Fields(strings.ToLower(filter))
	if len(terms) == 0 {
		return models
	}
	var out []model.CatalogModel
	for _, m := range models {
		id, label := strings.ToLower(m.ID), strings.ToLower(m.Label)
		all := true
		for _, t := range terms {
			if !strings.Contains(id, t) && !strings.Contains(label, t) {
				all = false
				break
			}
		}
		if all {
			out = append(out, m)
		}
	}
	return out
}

// countModels is "1 model" or "<n> models".
func countModels(n int) string {
	if n == 1 {
		return "1 model"
	}
	return fmt.Sprintf("%d models", n)
}

// modelsHeader is the first line of a known list: how many models agent a has, and with a filter
// how many of them (k of n) match it.
func modelsHeader(a model.AgentKind, n, k int, filter string) string {
	words := strings.Fields(filter)
	switch f := strings.Join(words, " "); {
	case len(words) == 0:
		return fmt.Sprintf("%s: %s.", a, countModels(n))
	case k == 0:
		return fmt.Sprintf("%s: none of the %s match filter %q. The whole list follows.", a, countModels(n), f)
	default:
		return fmt.Sprintf("%s: %d of %s match filter %q.", a, k, countModels(n), f)
	}
}

// defaultsLine says what spawn_subagent uses for agent a when model and effort are omitted:
// dModel and dEffort as chats.Manager.SpawnDefaults resolved them against the known list cat.
func defaultsLine(a model.AgentKind, cat *model.Catalog, dModel, dEffort string) string {
	if dModel == "" {
		return fmt.Sprintf("Model omitted -> no model is named, so %s uses its own default.", a)
	}
	for _, m := range cat.Models {
		if m.ID == dModel && len(m.Efforts) == 0 {
			return fmt.Sprintf("Model omitted -> %s, which takes no effort.", dModel)
		}
	}
	if dEffort == "" {
		return fmt.Sprintf("Model omitted -> %s, with no effort named, so %s uses its own default effort.", dModel, a)
	}
	return fmt.Sprintf("Model omitted -> %s, effort %s.", dModel, dEffort)
}

// effortRuleLine says what spawn_subagent does with a named model and no effort. chatEffort is
// the calling chat's own effort.
func effortRuleLine(chatEffort string) string {
	if chatEffort == "" {
		return "Effort omitted with a model named -> the model's default effort (this chat has no effort of its own)."
	}
	return fmt.Sprintf("Effort omitted with a model named -> this chat's effort (%s) if the model offers it, else the model's default effort.", chatEffort)
}

// modelRow is one model of a known list: its id, its label, the efforts it accepts and its
// default effort.
func modelRow(m model.CatalogModel) string {
	row := m.ID
	if m.Label != "" {
		row += " (" + m.Label + ")"
	}
	if len(m.Efforts) == 0 {
		return row + ": takes no effort; omit effort"
	}
	row += ": " + strings.Join(m.Efforts, ", ")
	if m.DefaultEffort != "" && slices.Contains(m.Efforts, m.DefaultEffort) {
		row += "; default " + m.DefaultEffort
	}
	return row
}

// unknownListLines is the whole answer for an agent whose model list the app does not know yet
// (Cursor's and pi's before the agent has reported it). spawn_subagent then checks nothing.
// dModel and dEffort are what it passes on when none is named: for own, a subagent of the chat's
// own agent, the chat's model and effort; for another agent never those, but the model and
// effort last picked for a chat of that agent (never an effort without a model), or none.
func unknownListLines(a model.AgentKind, own bool, dModel, dEffort string) []string {
	var d string
	switch {
	case dModel == "" && dEffort == "":
		d = fmt.Sprintf("Model omitted -> no model or effort is named, so %s uses its own defaults.", a)
	case !own && dEffort != "":
		d = fmt.Sprintf("Model omitted -> %s and effort %s, last picked for a %s chat, are passed on unchecked.", dModel, dEffort, a)
	case !own:
		d = fmt.Sprintf("Model omitted -> %s, last picked for a %s chat, is passed on unchecked; no effort is named, so %s uses its own default effort.", dModel, a, a)
	case dModel != "" && dEffort != "":
		d = fmt.Sprintf("Model omitted -> this chat's model %s and effort %s are passed on unchecked.", dModel, dEffort)
	case dModel != "":
		d = fmt.Sprintf("Model omitted -> this chat's model %s is passed on unchecked; no effort is named, so %s uses its own default effort.", dModel, a)
	default:
		d = fmt.Sprintf("Model omitted -> no model is named, so %s uses its own default model; this chat's effort %s is passed on unchecked.", a, dEffort)
	}
	return []string{
		fmt.Sprintf("%s: the model list is not known to the app yet. It becomes known when the app reads it at start or when a %s chat starts.", a, a),
		fmt.Sprintf("Until then spawn_subagent does not check model or effort for %s: it passes them on as given, unchecked.", a),
		d,
	}
}
