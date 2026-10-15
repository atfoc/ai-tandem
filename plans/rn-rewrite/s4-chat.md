# Package S4: the chat view, as built

What S6–S10 and K3 build on. Code: `app/src/screens/chat/` (registered in the shell's `ChatView` slot by `screens/register.ts`), the checks
`web/dev/checks-app/{L8-stream,L10-chatview,SEC.7-drop,SEC.10-readonly,AAC.2-localdown,A6.3-markdown}.mjs` and `chat.mjs` (readers).

## What it draws (`ChatView.tsx`)
`chat` (testID; dataSet `chat`) = `ChatHeader` + `Thread` + the composer part. A plain chat's page is a column of at most 780 px, the panel beside a
board takes its pane. `MarkdownEnvProvider` gives the Markdown of S5 its env (`env.ts`: a chip press → `boardApp.showRef`, the boards of the text's server,
a mention → `openBoard`). On the phone the chat's own header is the screen's one bar, with the stack's back first (S8: `ChatHeader` draws `BackButton` where the layout is `phone`, and the shell's `Bar` is gone from the chat screen; the drawer keeps its own).

- **Header** (`Header.tsx`; `chat-head` with dataSet `chat`, `status`, `frozen`): glyph, name (`chat-head-name`; a press opens `chat-name-input`: name
  selected, Enter or leaving it commits through `renameChat`, Esc cancels, the same name asks nothing, a section's refusal says "Couldn't rename the
  chat"), the line `chat-head-sub` (board · agent · folder with ~ · server (`chat-head-server`) · status · crumb), `parts.HeaderCrumb`,
  `parts.HeaderTail`, and `chat-hide` (× "Hide chat (⌘J)", board chats on the wide layouts only).
- **Thread** (`Thread.tsx`, `rows.ts`, `StickyList.tsx`): `thread` (dataSet `chat`, `branch`); the rows come from `threadRows` (pure, tested): the note of a
  fork (`forked-from`, `forked-from-link`), the empty state (`empty-thread` with `empty-title`, `empty-reason`, `config-hint`, `suggestions`/`suggestion`),
  the items, the mark of the copy's end (`prefix-end`, dataSet `at`), the message on its way (`msg` with `sending`), the status line (`typing`, with
  `dots`), the waits (`wait-line`, dataSet `wait`). Under the list, outside it: the warning `remote-bar` (dataSet `kind`: `off` | `gone`) with
  `remote-bar-text`, `remote-bar-state`, `remote-servers`; with no thread kept the place is `remote-off` (dataSet `kind`: `unreachable` | `gone` |
  `failed`) with `remote-retry`. A thread that is only the empty state, a fork's note and lines is a plain `ScrollView` (`thread-scroll` too).
- **Items** (`ItemView.tsx`): `msg` (dataSet `role` user | assistant, `item` (the index; none in the drawer), `quotable`, `streaming`), `note` (dataSet `tone`),
  `sent-quotes` / `sent-quote-card` / `sent-quote` / `sent-quote-comment`. The end mark, an unknown item and a note with no text have no row (`drawn`).
- **Scrolling** (goal 4.8): the list is a `@legendapp/list` `LegendList` (new dependency, AD-3). `StickyList` opens at its end (`initialScrollAtEnd`), follows
  while `follows(was, lastOffset, scroll)` (`scroll.ts`: the page's 40 px rule over scroll events, growth never ends it) with `maintainScrollAtEnd`,
  and keeps the user's place (`maintainVisibleContentPosition`). On web its scroller carries `data-testid="thread-scroll"` and `data-follows`. A list is
  drawn anew by `resetKey` (`<chat>:<branch>`). The order of the messages in the page is not their order on screen: read them by position
  (`chat.mjs: messages`). The Markdown counters are on `window.__aiwbMd` in a build for the checks (version `uicheck`).

## Seams (`parts.tsx`: `setChatPart(name, value)`, called from `screens/<area>/index.ts`; the area's import goes in `screens/register.ts`)
| Part | Package | What it gets / does |
|---|---|---|
| `Composer` | K3 | `{chat}`: drawn under the thread. `ChatView` draws none of its own. The composer registers its focus with `nav.ts setFocusComposer`. |
| `sendMessage(chat, text)` | K3 | what a suggestion's chip sends as the first message; the default sends the text alone (a plain chat); K3's adds a board chat's context (`boardApp.buildContext`). |
| `ToolCard` | S6 | `{item, chat, live}`; keep the testID `tool-card` |
| `PermCard` | S6 | `{item, chat, branch, closed}`; keep the testID `perm` (dataSet `state`: pending | allow | deny) |
| `SubagentRow`, `SubResultRow` | S7 | `{item, chat, within?}`, `{item, chat}`; stand-in testID `sub-row` |
| `MessageExtras` | S8 | `{chat, index, item, hovered}` (`hovered`: the pointer, a mouse's, is over the message), drawn inside the message after its text (fork actions, label, branch marker) |
| `Banner` | S8 | `{chat}`: the pending move's banner, between the thread and the composer (added by S8) |
| `HeaderCrumb` | S8 | nested `Text` at the end of `chat-head-sub` (starts with " · "), nothing for a chat never split |
| `HeaderTail` | S8 | the branch alert and the Tree button, before the × (a `View` row child; it owns its own spacing) |
| `MessageImages` | S10 | `{chat, images, alone, again}`, above the words of a user message |
| `showQuote(chat, ref)` | K5 | a press on a sent quote card |
Also exported from `screens/chat` (`index.ts`): `ItemView` (the drawer draws its thread with it: `sub` set, no `index`), `StickyList` (`follow` false = a subagent that
has ended opens at its top; B-SM-10), `Thread`, `useWhere`, `useOffWhy`, `usePrefixEnd`, `tildify`, `base`, `agentColours`, `alpha`, `Dots`, `Caret`,
`renameChat`, `NameInput`.

## Decisions
- `useWhere`, `useOffWhy`, `tildify` are here, not in a composer file: the composer (K3) and the fork parts (S8) import them from `screens/chat`. The warning's "Servers…" is core's `openServers` (S3 draws the dialog from the store).
- The permission card is a stand-in here (S6 owns B-PM and its answers). With S6 not merged a request cannot be answered from the app.
- No `.web`/`.native` split in the chat: the only platform branch is the list's scroller ids (`Platform.OS`).
- The ports leave what other packages draw to flags at the top of each check (SIDEBAR S1, COMPOSER K3, BOARD B4, MESSAGE_ACTIONS and TREE S8, PERMISSION S6,
  QUOTES K5) with the old check's body still in `web/dev/checks/`; each package sets its flag when its screen makes the part pass.
