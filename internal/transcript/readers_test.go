package transcript

import (
	"testing"

	"ai-whiteboard/internal/agent"
)

// Len, LastTextSince and LastTool read the thread without copying it.
func TestReaders(t *testing.T) {
	tr := newT(t)
	if tr.Len() != 0 || tr.LastTextSince(0) != "" {
		t.Fatalf("empty thread: len %d, text %q", tr.Len(), tr.LastTextSince(0))
	}
	if n, last := tr.LastTool(); n != 0 || last.Kind != "" {
		t.Fatalf("empty thread: %d tools, last %+v", n, last)
	}

	tr.AddUser("one", "", nil)                                                     // 0
	tr.Apply(agent.Event{Kind: agent.EvText, Text: "first answer"})                // 1
	tr.Apply(agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Bash"}) // 2
	tr.Apply(agent.Event{Kind: agent.EvToolResult, ToolID: "t1", Result: "ok"})    //
	tr.Apply(agent.Event{Kind: agent.EvTurnEnd})                                   //
	tr.AddEnd("p1")                                                                // 3
	from := tr.Len()
	if from != len(items(tr)) || from != 4 {
		t.Fatalf("Len %d, items %d", from, len(items(tr)))
	}
	if got := tr.LastTextSince(0); got != "first answer" {
		t.Fatalf("LastTextSince(0) = %q", got)
	}
	if got := tr.LastTextSince(1); got != "first answer" {
		t.Fatalf("LastTextSince(1) = %q", got)
	}
	// Nothing at or past an index that follows the last text: never an older turn's text.
	if got := tr.LastTextSince(2); got != "" {
		t.Fatalf("LastTextSince(2) = %q", got)
	}

	tr.AddUser("two", "", nil)                                                     // 4
	tr.Apply(agent.Event{Kind: agent.EvToolStart, ToolID: "t2", ToolName: "Read"}) // 5
	tr.Apply(agent.Event{Kind: agent.EvToolResult, ToolID: "t2", Result: "file"})  //
	tr.Apply(agent.Event{Kind: agent.EvTurnEnd})                                   //
	tr.AddEnd("p2")                                                                // 6
	if got := tr.LastTextSince(from); got != "" {
		t.Fatalf("a turn without text: LastTextSince(%d) = %q", from, got)
	}
	if got := tr.LastText(); got != "first answer" {
		t.Fatalf("LastText = %q", got)
	}
	n, last := tr.LastTool()
	if n != 2 || last.Kind != "tool" || last.Name != "Read" || last.ToolID != "t2" || last.Result == nil || *last.Result != "file" {
		t.Fatalf("LastTool: %d, %+v", n, last)
	}
	// Out of range on either side is not an error.
	if tr.LastTextSince(-5) != "first answer" || tr.LastTextSince(99) != "" {
		t.Fatal("LastTextSince out of range")
	}

	// A text still being written counts: it is the last text item.
	tr.AddUser("three", "", nil)
	tr.Apply(agent.Event{Kind: agent.EvTextStart})
	tr.Apply(agent.Event{Kind: agent.EvTextDelta, Text: "half"})
	if got := tr.LastTextSince(tr.Len() - 1); got != "half" {
		t.Fatalf("open text: %q", got)
	}
}
