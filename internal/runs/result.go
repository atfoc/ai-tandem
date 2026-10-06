package runs

import (
	"regexp"
	"strings"
	"unicode"
)

// resultBlock is the result a task agent or a merge agent ends its last message with.
type resultBlock struct {
	Outcome string // "completed" or "failed"
	Summary string
	Report  string
}

var (
	// engBlockStart finds where a result block may begin.
	engBlockStart = regexp.MustCompile(`<result>\s*<outcome>`)
	// engBlock is the block, tried at one such place: it must reach the end of the text. The
	// summary ends at the first </summary> that <report> follows; the report runs to the last
	// </report> that the closing </result> follows, so a report may quote both tags.
	engBlock = regexp.MustCompile(`(?s)^<result>\s*<outcome>\s*(completed|failed)\s*</outcome>\s*<summary>(.*?)</summary>\s*<report>(.*)</report>\s*</result>\s*$`)
)

// parseResult reads the result block at the end of an agent's last message; nil when there is
// none. Anything may come before the block and nothing after it. The places a block may begin
// are tried from the left and the first that matches wins; one inside a code fence is not tried
// (the block is asked for in plain tags, and an agent that shows the layout in a fence before its
// real block must not have the example read as its result). Any outcome other than completed or
// failed, and an empty summary, are no block.
func parseResult(text string) *resultBlock {
	text = strings.TrimRightFunc(text, unicode.IsSpace)
	for _, loc := range engBlockStart.FindAllStringIndex(text, -1) {
		if engInFence(text[:loc[0]]) {
			continue
		}
		m := engBlock.FindStringSubmatch(text[loc[0]:])
		if m == nil {
			continue
		}
		b := &resultBlock{Outcome: m[1], Summary: strings.TrimSpace(m[2]), Report: strings.TrimSpace(m[3])}
		if b.Summary == "" {
			return nil
		}
		return b
	}
	return nil
}

// engInFence reports whether the text ends inside a code fence: an odd number of lines before
// its end begin with ``` or ~~~.
func engInFence(before string) bool {
	open := false
	for _, line := range strings.Split(before, "\n") {
		l := strings.TrimLeft(line, " \t")
		if strings.HasPrefix(l, "```") || strings.HasPrefix(l, "~~~") {
			open = !open
		}
	}
	return open
}
