package runs

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// DefaultName is a new run's name until the user renames it or its goal names it.
const DefaultName = "New run"

// maxNameRunes is the longest name the goal gives a run, and the longest a user may type.
const (
	goalNameRunes = 60
	MaxNameRunes  = 80
)

var (
	lineMark    = regexp.MustCompile(`^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|>\s*|\d+[.)]\s+)`) // heading, bullet, checkbox, quote, number
	inlineMark  = regexp.MustCompile("[*_`]+")
	link        = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	sentenceEnd = regexp.MustCompile(`[\pL\pN)\]"'][.!?](\s|$)`)
)

// NameFromGoal makes a run's name from its goal without asking a model: the first line that says
// something, without its markdown marks, cut after its first sentence, and at a word when it is
// longer than 60 characters. "" when the goal has no such line (the run keeps its name).
func NameFromGoal(goal string) string {
	for _, line := range strings.Split(goal, "\n") {
		line = lineMark.ReplaceAllString(line, "")
		line = link.ReplaceAllString(line, "$1")
		line = inlineMark.ReplaceAllString(line, "")
		line = strings.Join(strings.Fields(line), " ")
		if letters(line) < 3 { // a rule, a blank line, "---"
			continue
		}
		if m := sentenceEnd.FindStringIndex(line); m != nil && m[0] >= 12 {
			end := m[0] + utf8.RuneLen(firstRune(line[m[0]:])) // keep the letter before the mark
			if line[end] != '.' {                              // and a "?" or "!", but not a full stop
				end++
			}
			line = line[:end]
		}
		line = strings.TrimRight(line, " :")
		if r := []rune(line); len(r) > goalNameRunes {
			cut := goalNameRunes
			for i := goalNameRunes; i >= goalNameRunes/2; i-- {
				if r[i] == ' ' {
					cut = i
					break
				}
			}
			line = strings.TrimRight(string(r[:cut]), " ,;:-") + "…"
		}
		r, n := utf8.DecodeRuneInString(line)
		return string(unicode.ToUpper(r)) + line[n:]
	}
	return ""
}

// CleanName checks a name the user typed: spaces are kept (a run's name is a label, not a file
// name), runs of white space become one space.
func CleanName(name string) (string, error) {
	name = strings.Join(strings.Fields(name), " ")
	switch {
	case name == "":
		return "", errEmptyName
	case utf8.RuneCountInString(name) > MaxNameRunes:
		return "", errLongName
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", errBadName
		}
	}
	return name, nil
}

func letters(s string) int {
	n := 0
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			n++
		}
	}
	return n
}

func firstRune(s string) rune { r, _ := utf8.DecodeRuneInString(s); return r }
