// This file is the change of one section of the run's notes (edit_notes): the script's
// replace_section. It reads and writes nothing: the tool gives it the notes and saves what it
// returns.
package runs

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

var (
	notesHeadingRe = regexp.MustCompile(`^(#{1,6})\s+\S`)
	notesBlankRe   = regexp.MustCompile(`\n{3,}`)
)

// notesName is a heading as two of them are compared: trimmed, without the # marks at its ends,
// white space collapsed, in lower case.
func notesName(s string) string {
	return strings.ToLower(strings.Join(strings.Fields(strings.Trim(strings.TrimSpace(s), "#")), " "))
}

// notesReplaceSection is the notes with the section under a heading replaced, added or (empty
// text) removed. did is "replaced", "added" or "removed"; a refusal changes nothing. A section
// runs from its heading to the next heading of the same or a higher level; a heading inside a
// code fence is not a heading. A heading the notes do not have is added at the end.
func notesReplaceSection(notes, heading, text string) (out, did, refusal string) {
	lines, want, name := strings.Split(notes, "\n"), notesName(heading), strings.TrimSpace(heading)
	text = strings.TrimSpace(text)
	if want == "" {
		return "", "", "the heading is empty"
	}
	type head struct{ i, level int }
	var heads, found []head
	fenced := false
	for i, line := range lines {
		if l := strings.TrimLeftFunc(line, unicode.IsSpace); strings.HasPrefix(l, "```") || strings.HasPrefix(l, "~~~") {
			fenced = !fenced
		}
		if fenced {
			continue
		}
		if m := notesHeadingRe.FindStringSubmatch(line); m != nil {
			h := head{i, len(m[1])}
			heads = append(heads, h)
			if notesName(line) == want {
				found = append(found, h)
			}
		}
	}
	if len(found) > 1 {
		return "", "", fmt.Sprintf("the notes have %d sections called '%s'; rename them with set_notes", len(found), name)
	}
	if len(found) == 0 {
		if text == "" {
			return "", "", fmt.Sprintf("the notes have no section called '%s'; there is nothing to remove", name)
		}
		title := name
		if !strings.HasPrefix(title, "#") {
			title = "## " + title
		}
		if strings.TrimSpace(notes) != "" {
			out = strings.TrimRightFunc(notes, unicode.IsSpace) + "\n\n"
		}
		return out + title + "\n\n" + text, "added", ""
	}
	start, end := found[0].i, len(lines)
	for _, h := range heads {
		if h.i > start && h.level <= found[0].level {
			end = h.i
			break
		}
	}
	kept := append([]string{}, lines[:start]...)
	did = "removed"
	if text != "" {
		kept, did = append(kept, lines[start], "", text, ""), "replaced"
	}
	out = strings.Join(append(kept, lines[end:]...), "\n")
	return strings.TrimSpace(notesBlankRe.ReplaceAllString(out, "\n\n")), did, ""
}
