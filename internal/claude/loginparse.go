package claude

import (
	"strings"
)

// What `claude auth login` writes is read through a terminal (util-linux `script` in the
// container, D21) or plain pipes: cleanTerminal makes text of it, findLoginURL finds the URL in
// that text, lastLine Claude's answer to a code.

// cleanTerminal returns the text of what a program wrote to a terminal: CSI sequences (ESC [ …),
// OSC sequences (ESC ] … ended by BEL or ESC \, such as an OSC 8 hyperlink, whose hidden target
// goes with it), other escape sequences, carriage returns and the other control characters but
// newline and tab are dropped. A sequence cut off at the end of b is dropped too; text written
// later is cleaned again from the start, so the result of a longer b starts with this one's.
func cleanTerminal(b []byte) string {
	var out strings.Builder
	out.Grow(len(b))
	for i := 0; i < len(b); i++ {
		c := b[i]
		switch {
		case c == 0x1b:
			i = skipEscape(b, i)
		case c == '\n' || c == '\t':
			out.WriteByte(c)
		case c < 0x20 || c == 0x7f:
			// \r, BEL, backspace, …: nothing of the text
		default:
			out.WriteByte(c)
		}
	}
	return out.String()
}

// skipEscape returns the index of the last byte of the escape sequence that starts at b[i] (ESC),
// or len(b)-1 when it is cut off.
func skipEscape(b []byte, i int) int {
	if i+1 >= len(b) {
		return len(b) - 1
	}
	switch b[i+1] {
	case '[': // CSI: parameter and intermediate bytes, then one final byte 0x40–0x7E
		for j := i + 2; j < len(b); j++ {
			if b[j] >= 0x40 && b[j] <= 0x7e {
				return j
			}
		}
		return len(b) - 1
	case ']', 'P', '_', '^', 'X': // OSC (and DCS, APC, PM, SOS): up to BEL or ESC \
		for j := i + 2; j < len(b); j++ {
			if b[j] == 0x07 {
				return j
			}
			if b[j] == 0x1b && j+1 < len(b) && b[j+1] == '\\' {
				return j + 1
			}
		}
		return len(b) - 1
	case '(', ')', '*', '+', '-', '.', '/', '#', '%': // a character set and the like: one more byte
		return min(i+2, len(b)-1)
	default: // ESC 7, ESC =, ESC M, …
		return i + 1
	}
}

// isURLText reports whether s is not empty and made only of characters a URL can hold (RFC 3986
// unreserved, reserved and %): a line that may be the rest of a URL the terminal wrapped.
func isURLText(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case strings.IndexByte("-._~:/?#[]@!$&'()*+,;=%", c) >= 0:
		default:
			return false
		}
	}
	return true
}

// findLoginURL finds the first https:// URL in text (from cleanTerminal) and joins to it the lines
// that follow it made only of URL characters, when it reaches the end of its line: a URL the
// terminal wrapped. It reports whether the URL is complete: something other than its own
// characters follows it (more text on its line, an empty line, a line of other text, Claude's
// prompt), or ended (the program wrote all it will) is set. "" when there is none yet.
func findLoginURL(text string, ended bool) (url string, complete bool) {
	lines := strings.Split(text, "\n") // the last one is the line being written (maybe "")
	for i, line := range lines {
		at := strings.Index(line, "https://")
		if at < 0 {
			continue
		}
		line = strings.TrimRight(line[at:], " \t")
		if sp := strings.IndexAny(line, " \t"); sp >= 0 {
			return line[:sp], true // text follows it on its line
		}
		url = line
		for j := i + 1; ; j++ {
			if j == len(lines) { // its line is still being written
				return url, ended
			}
			next := strings.TrimRight(lines[j], " \t")
			last := j == len(lines)-1
			if !isURLText(next) {
				if last && next == "" {
					return url, ended // the next line has not begun yet
				}
				return url, true
			}
			if last {
				return url + next, ended // the next line may hold more of it
			}
			url += next
		}
	}
	return "", false
}

// loginPrompt is how Claude asks for the code, with no newline after it: what it writes next
// follows it on the same line.
const loginPrompt = "Paste code here if prompted >"

// lastLine is the last line of text that is not blank and holds nothing of skip (a code echoed
// by the terminal; skip "" skips nothing), without Claude's prompt for the code in front of it,
// trimmed; "" if none.
func lastLine(text, skip string) string {
	lines := strings.Split(text, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if at := strings.Index(l, loginPrompt); at >= 0 {
			l = strings.TrimSpace(l[at+len(loginPrompt):])
		}
		if l == "" || skip != "" && strings.Contains(l, skip) {
			continue
		}
		return l
	}
	return ""
}
