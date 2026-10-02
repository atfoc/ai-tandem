package pi

import "log"

// noticeLog is the logging seam for MCP notices. It is a var so tests can
// capture output without touching the global logger; production logs through
// the standard logger like the rest of the adapter.
var noticeLog = log.Printf

// Notice implements agent.RunHandler: the extension reports a non-fatal
// failure for this run (for example an MCP server that could not be reached or
// discovered). The app has no chat card for notices in v1 (plan §3.8/open
// question 3), so the message is surfaced in the server log with the chat/run
// context. An empty message is ignored.
func (p *proc) Notice(message string) {
	if message == "" {
		return
	}
	noticeLog("pi mcp notice chat=%s run=%s: %s", p.o.ChatID, p.runToken, message)
}
