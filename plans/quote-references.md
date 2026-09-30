# Quote references in chat messages

Select part of an earlier message in a chat, press ⌘L, and comment on it in a float at the
passage; the quote goes into the message being written. One message can carry several references,
each with its own comment, plus general text.

Only the chat's own thread can be quoted: your messages and the agent's replies. Quoting from a
subagent's thread is not supported.

## What the agent gets

```
<reference>
<quote>the ShapeStore should own undo</quote>
<comment>I'd keep undo in the canvas, see apply.ts.</comment>
</reference>

<reference>
<quote>retry 3 times with backoff</quote>
<comment>Make it 5.</comment>
</reference>

Otherwise the plan looks good, go ahead.
```

- The references come first, in the order they were added, followed by the general text.
- A reference with no comment leaves out `<comment>`.
- A message can be only references, with no general text.
- `<`, `>` and `&` in quotes and comments are escaped.
- The agent never sees message numbers or positions, so it needs no prompt change.

## Stored in items.jsonl, never sent

On the user item, next to `Context` (`internal/model/model.go`):

```go
// user: parts of earlier messages in this chat the user quoted, with a comment on each
References []Reference `json:"references,omitempty"`

type Reference struct {
	Quote   string `json:"quote"`
	Comment string `json:"comment,omitempty"`
	Item    int    `json:"item"`  // index of the quoted item in this chat's thread
	Start   int    `json:"start"` // selection position in the item's displayed text
	End     int    `json:"end"`
}
```

It's named `Reference` so it doesn't clash with `Ref` in `web/src/logic/refs.ts`, the
board-selection chip.

Positions are in the message's displayed text, not its markdown source. The selection is made in
the displayed text and the highlight is drawn there, so the positions work directly. Mapping them
back to the source is hard with formatting like `**bold**` or links, and nothing needs it.

Item indices are safe to store: the transcript only adds items or updates them in place and never
renumbers them.

## Server

- **`Manager.Send` (`internal/chats/manager.go`)** takes a `references` argument. It checks each
  one: the quote isn't empty, and `Item` points to an earlier user message or agent reply in this
  chat. It writes the `<reference>` blocks in front of the text in the message to the agent, and
  saves the list on the item through `Transcript.AddUser` (`internal/transcript/transcript.go`).
- **The send endpoint** accepts `references` in the request body.
- **The draft (`c.meta.Draft`)** stores the references too, so the cards survive switching chats
  and reloading.

## Web

### Choosing what to quote

- Only your messages and the agent's replies in the main thread can be quoted, and only once a
  reply has finished writing. While a reply is still being written its displayed text can change,
  so positions could end up pointing at the wrong words.
- Tool cards, notes and the subagent drawer can't be quoted.
- The selection has to stay inside one message. If it doesn't, the composer shows a short note:
  "Select text within one message".

### ⌘L

⌘L works in every chat:

- Text selected in a message opens a float to comment on it (below).
- Otherwise ⌘L takes the board selection, as it does now (board chats only).

This means the key handler in `web/src/Composer.tsx` can no longer be limited to board chats
(`canRef`).

### Commenting: a float at the passage

Chosen with the `quote-references-ui` prototype (variant 3, "Wide float"). It replaces a card
per quote in the composer, which made the composer grow.

- ⌘L with text selected opens a float just below the passage, or above it when there's no room
  below. It never covers the composer and follows the passage as the thread scrolls.
- It has the composer box's width, left edge and look, with a one-line preview of the quote over a
  comment field at least 3 lines tall.
- Enter (or **Add**) adds the quote, with or without a comment; Shift+Enter starts a new line. Esc
  drops it. A click elsewhere, or ⌘L on another selection, adds it if a comment was typed and drops
  it if not.
- After adding, the float closes, the selection is cleared and nothing takes the focus, so the next
  selection and ⌘L can follow straight away.
- Quoting a passage that's already in the draft opens its float to edit it, with **Save** and
  **Remove**.
- While a quote is in the draft its passage stays marked in the thread (faint yellow, underlined).
  Clicking a mark opens its float.

### Composer

- The composer shows one count, "❝ 3 comments", the same size for any number of quotes, and only
  when there are some. Board chats put it in the context row next to the board's name; below 440px
  it shortens to "❝ 3" and the board buttons drop their key hints. Plain chats give it a row above
  the text box.
- Clicking the count lists the quotes, each with its comment ("No comment" if there isn't one) and
  ×. Clicking an entry scrolls to the passage and opens its float.
- Send is enabled when there's text or at least one reference. `sendMessage` and `api.send` pass
  the references on.
- The draft saves both the text and the quotes.

### Thread (`web/src/ChatView.tsx`)

- Each user message and agent reply in the main thread is tagged with its item index. The
  subagent drawer is not tagged, which is what keeps it from being quoted.
- A sent message shows its reference cards above its text, drawn from `item.references`.
- Clicking a card:
  1. Scrolls to the quoted message.
  2. Checks that the characters from `start` to `end` in its displayed text match the quote.
  3. If not (for example, after a change to how markdown is displayed), searches the message for
     the quote.
  4. If the quote isn't found, highlights the whole message.
- The highlight uses the browser's built-in text highlighting (the CSS Custom Highlight API), which
  Electron supports. That way it doesn't change the message's DOM, which React owns. The highlight
  fades after a few seconds.

### Code layout

- `web/src/logic/quotes.ts` holds the logic that doesn't touch the DOM, mainly finding a quote in a
  message's text with the fallbacks above.
- `web/src/quoteDom.ts` converts between a selection and positions in the text, and draws the
  highlights.
- `web/src/Quotes.tsx` has the float, the count and its list, and a sent message's cards.

A message's displayed text is the text nodes of its `.md`, joined with nothing between them,
leaving out a code block's header (which can't be selected either). The selection's own text has
line breaks between blocks that the displayed text doesn't, so quotes are compared with whitespace
ignored.

## Tests

- **Go:**
  - The agent gets escaped `<reference>` blocks with no position fields.
  - The transcript saves the references.
  - References that point to a missing or invalid item are rejected.
  - A draft with references saves and loads.
- **Web:**
  - Finding a quote: exact position, then text search, then not found.
  - Drafts with references.
- **In the running app:** quote parts of two messages, comment on both, send, then click the cards
  in the sent message.

## Later, not in the first version

- A "Quote" button next to selected text, for anyone who doesn't know about ⌘L.
