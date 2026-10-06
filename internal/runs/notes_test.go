package runs

import (
	"fmt"
	"strings"
	"sync"
	"testing"
)

// notesReplaceSection case by case: what counts as a heading, where a section ends, how names
// are compared, and the three things it does.
func TestNotesReplaceSection(t *testing.T) {
	const notes = "# Goal\n\nPort the importer.\n\n## Facts\n\nThree passes.\n\n### Sources\n\nT01.\n\n## Plan\n\nBuild it."
	for _, c := range []struct {
		name, notes, heading, text string
		out, did, refusal          string
	}{
		{name: "the heading is empty", notes: notes, heading: "  ", text: "x", refusal: "the heading is empty"},
		{name: "only # marks is empty too", notes: notes, heading: " ## ", text: "x", refusal: "the heading is empty"},
		{name: "replace: a ### inside the ## section belongs to it", notes: notes, heading: "Facts", text: "One pass.\n",
			out: "# Goal\n\nPort the importer.\n\n## Facts\n\nOne pass.\n\n## Plan\n\nBuild it.", did: "replaced"},
		{name: "replace the inner section only", notes: notes, heading: "Sources", text: "T01, T02.",
			out: "# Goal\n\nPort the importer.\n\n## Facts\n\nThree passes.\n\n### Sources\n\nT01, T02.\n\n## Plan\n\nBuild it.", did: "replaced"},
		{name: "replace the last section", notes: notes, heading: "Plan", text: "Test it.",
			out: "# Goal\n\nPort the importer.\n\n## Facts\n\nThree passes.\n\n### Sources\n\nT01.\n\n## Plan\n\nTest it.", did: "replaced"},
		{name: "a # section holds everything under it", notes: notes, heading: "Goal", text: "All new.", out: "# Goal\n\nAll new.", did: "replaced"},
		{name: "a # ends a ## section", notes: "## Facts\n\nOld.\n\n### More\n\nx\n\n# Later\n\nKept.", heading: "Facts", text: "New.",
			out: "## Facts\n\nNew.\n\n# Later\n\nKept.", did: "replaced"},
		{name: "the heading line is kept as it is written", notes: "##   The  Facts ##\nOld.", heading: "the facts", text: "New.",
			out: "##   The  Facts ##\n\nNew.", did: "replaced"},
		{name: "names differ in case and white space", notes: notes, heading: "  fACTS\t", text: "x",
			out: "# Goal\n\nPort the importer.\n\n## Facts\n\nx\n\n## Plan\n\nBuild it.", did: "replaced"},
		{name: "a heading given with # marks", notes: notes, heading: "## Plan", text: "x",
			out: "# Goal\n\nPort the importer.\n\n## Facts\n\nThree passes.\n\n### Sources\n\nT01.\n\n## Plan\n\nx", did: "replaced"},
		{name: "the # marks given say nothing of the level", notes: notes, heading: "# Plan #", text: "x",
			out: "# Goal\n\nPort the importer.\n\n## Facts\n\nThree passes.\n\n### Sources\n\nT01.\n\n## Plan\n\nx", did: "replaced"},
		{name: "a heading in a fence is no heading", notes: "## Facts\n\n```\n## Plan\n# Top\n```\n\nafter\n\n## Plan\n\nReal.", heading: "Facts", text: "New.",
			out: "## Facts\n\nNew.\n\n## Plan\n\nReal.", did: "replaced"},
		{name: "a fenced heading is not found twice", notes: "## Facts\n\n  ~~~sh\n## Plan\n~~~\n\n## Plan\n\nReal.", heading: "Plan", text: "New.",
			out: "## Facts\n\n  ~~~sh\n## Plan\n~~~\n\n## Plan\n\nNew.", did: "replaced"},
		{name: "a fence that is not closed hides the rest", notes: "## Facts\n\n```\n## Plan\n\nx", heading: "Plan", text: "New.",
			out: "## Facts\n\n```\n## Plan\n\nx\n\n## Plan\n\nNew.", did: "added"},
		{name: "not a heading: no space, seven marks, nothing after", notes: "#Plan\n####### Plan\n## \nx", heading: "Plan", text: "New.",
			out: "#Plan\n####### Plan\n## \nx\n\n## Plan\n\nNew.", did: "added"},
		{name: "an indented heading is no heading", notes: "  ## Plan\nx", heading: "Plan", text: "New.", out: "  ## Plan\nx\n\n## Plan\n\nNew.", did: "added"},
		{name: "duplicate names", notes: "## Facts\n\na\n\n# facts\n\nb\n\n### FACTS ##\n\nc", heading: " Facts ", text: "x",
			refusal: "the notes have 3 sections called 'Facts'; rename them with set_notes"},
		{name: "duplicate names, to remove", notes: "## Facts\n\na\n\n## Facts\n\nb", heading: "Facts",
			refusal: "the notes have 2 sections called 'Facts'; rename them with set_notes"},
		{name: "add to empty notes", notes: "", heading: "Facts", text: "\nThree passes.\n\n", out: "## Facts\n\nThree passes.", did: "added"},
		{name: "add to notes of white space", notes: " \n\n", heading: "Facts", text: "x", out: "## Facts\n\nx", did: "added"},
		{name: "add at the end", notes: notes + "\n\n\n", heading: "Open questions", text: "None.",
			out: notes + "\n\n## Open questions\n\nNone.", did: "added"},
		{name: "add with # marks: as given", notes: "# Goal\n\nx", heading: " ### Risks ", text: "None.", out: "# Goal\n\nx\n\n### Risks\n\nNone.", did: "added"},
		{name: "remove", notes: notes, heading: "Facts", text: "  \n", out: "# Goal\n\nPort the importer.\n\n## Plan\n\nBuild it.", did: "removed"},
		{name: "remove the last section", notes: notes, heading: "Plan", out: "# Goal\n\nPort the importer.\n\n## Facts\n\nThree passes.\n\n### Sources\n\nT01.", did: "removed"},
		{name: "remove the only section", notes: "## Facts\n\nx", heading: "Facts", out: "", did: "removed"},
		{name: "remove a missing one", notes: notes, heading: " Risks ", refusal: "the notes have no section called 'Risks'; there is nothing to remove"},
		{name: "remove from empty notes", notes: "", heading: "Risks", refusal: "the notes have no section called 'Risks'; there is nothing to remove"},
		{name: "blank lines are collapsed everywhere", notes: "# Goal\n\n\n\nx\n\n\n## Facts\n\n\ny", heading: "Facts", text: "z", out: "# Goal\n\nx\n\n## Facts\n\nz", did: "replaced"},
	} {
		out, did, refusal := notesReplaceSection(c.notes, c.heading, c.text)
		if out != c.out || did != c.did || refusal != c.refusal {
			t.Errorf("%s:\n got %q, %q, %q\nwant %q, %q, %q", c.name, out, did, refusal, c.out, c.did, c.refusal)
		}
	}
}

// Twenty edit_notes calls of one turn at the same time, each on a section of its own: every call
// makes one version, the versions have no gap, and each holds one section more than the one
// before, so the last holds all twenty.
func TestEditNotesConcurrently(t *testing.T) {
	const calls = 20
	x := newToolRun(t, false)
	n := x.turnStart("start")
	type answer struct {
		text  string
		isErr bool
	}
	answers := make([]answer, calls)
	var wg sync.WaitGroup
	for i := range answers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			args := fmt.Sprintf(`{"heading":"Part %02d","text":"What part %02d found."}`, i, i)
			answers[i].text, answers[i].isErr = x.orchOf(n, "edit_notes", args)
		}()
	}
	wg.Wait()
	for i, a := range answers {
		if a.isErr {
			t.Errorf("call %d is refused: %s", i, a.text)
		}
	}
	l := x.state()
	if len(l.Notes) != calls {
		t.Fatalf("%d versions of the notes, want %d", len(l.Notes), calls)
	}
	sections := func(v int) map[string]bool {
		t.Helper()
		text, err := readNotes(x.r.dir, v)
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]bool{}
		for i := 0; i < calls; i++ {
			head, body := fmt.Sprintf("## Part %02d\n", i), fmt.Sprintf("What part %02d found.", i)
			if h, b := strings.Count(text, head), strings.Count(text, body); h != b || h > 1 {
				t.Errorf("version %d has the heading of part %02d %d times and its text %d times", v, i, h, b)
			} else if h == 1 {
				got[head] = true
			}
		}
		return got
	}
	var before map[string]bool
	for i, nv := range l.Notes {
		v := i + 1
		got := sections(v)
		if nv.V != v || nv.Turn != n || len(got) != v {
			t.Errorf("version %d: recorded as %+v, with %d sections", v, nv, len(got))
		}
		for head := range before {
			if !got[head] {
				t.Errorf("version %d lost the section %q", v, strings.TrimSpace(head))
			}
		}
		before = got
	}
	// Every call is an op of the turn, with the version it made: each of them once.
	made := map[int]int{}
	for _, op := range l.Turns[0].Ops {
		if op.Op != "edit_notes" || op.Error != "" {
			t.Errorf("op: %+v", op)
		}
		made[op.NotesVersion]++
	}
	for v := 1; v <= calls; v++ {
		if made[v] != 1 {
			t.Errorf("version %d was made by %d calls", v, made[v])
		}
	}
	if len(l.Turns[0].Ops) != calls {
		t.Errorf("%d ops", len(l.Turns[0].Ops))
	}
}
