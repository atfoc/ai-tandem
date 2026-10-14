# Prompt library

The prompt library: what it is, how the popups work, the rules, where it is kept, how it works with several servers, and the routes of its API.

The **prompt library** keeps texts you type often and puts one into a message with a few keys.
A *prompt* is a name and a text; *groups* hold prompts and other groups.

- **The library popup.** The book button at the foot of the sidebar, between **Servers** and
  the theme picker, opens it: a search box, the tree, and an editor for the chosen prompt (its
  name and its text). In a group, groups come before prompts and both are sorted by name; there
  is no manual order. A prompt at the top level stands at the tree's left edge; what is in a
  group is set in, beside a line that runs down from the group. Nothing is saved while you
  type: **Save** (or ⌘↵, Ctrl+↵) saves, and leaving unsaved changes asks first. Deleting asks
  first too, and for a group the question says how many prompts go with it. A save the server
  refuses (a name that is taken, a prompt deleted meanwhile) shows why and keeps what you
  typed. Esc and a click beside the popup close it.
- **Where a prompt is.** The group of a prompt or of a group is set in the tree; the editor
  only says where the item is. A right click in the tree offers **New prompt** and **New
  group** for the place that was clicked: in the group that was clicked, beside the prompt that
  was clicked, at the top level on the space under the rows. The buttons under the tree make
  the new item in the chosen group, beside the chosen prompt, or at the top level with nothing
  chosen. While you type its name, the tree shows the new item's row where it will be. To move
  a prompt or a group, drag it onto a group (onto a prompt: it lands beside that prompt), or to
  the top level: the space under the rows, a server's entry, or the **Move to the top level**
  bar that stands in the buttons' place during a move. The place is lit before you let go, and
  nothing is lit where the item cannot go: where it already is, a group's own contents,
  another server's library. **Move…** of the right-click menu does the same with the keys: the
  arrows choose the place, Enter moves the item there, Esc cancels. A move is saved at once and
  leaves what is typed in the editor as it is; one the server refuses (a name that is taken
  there, groups too deep) says why under the tree, and nothing has moved.
- **Inserting.** ⌘P on a Mac, Ctrl+P elsewhere, in the text box of a chat
  opens the insert popup: a search box and the list of prompts with their paths, nothing else.
  The arrow keys move the highlight, Enter or a click inserts, Esc closes with the box as it
  was. The prompt's text goes in at the cursor, in place of a selection if there is one, as
  plain text with its line breaks; references and mentions in the box stay as they are. What
  was inserted is from then on text you typed: it is saved with the draft, and a later change
  to the prompt does not change it. In a text box ⌘P does not print the page; anywhere else it
  is the system's, as before. The composer's toolbar has an **Insert a prompt** button that
  does the same, where its row has room left, or as an entry of its **…** popup when the row
  has that chip.
- **Search.** Both popups search the same way, by path and name (`git/commit message`); the
  text of a prompt is not searched. The typed words must all be there, as parts of words, in the
  typed order; upper and lower case are the same (the matching of the model picker). First come
  the prompts with the first words in the path and the rest in the name, then those with all
  words in the name, then those with all words in the path. A search for a group's name lists
  its prompts.
- **Rules.** A name has 1 to 80 characters, no `/` and no line break, and is unique in its
  group whatever the case: two groups, or a group and a prompt, cannot share one either. A
  text has at most 100,000 characters. A library holds at most 5,000 groups and prompts and
  4 MB of names and texts, and groups nest at most 16 deep. A group cannot be moved into itself
  or below itself, and deleting a group deletes everything in it. The library's own server
  checks all of this, whoever calls. Two windows that save the same prompt at about the same
  time: the later save wins.
- **Where it is kept.** In `~/.ai-whiteboard/prompt-library.json` (a file with a version). A
  file that cannot be read is set aside as `prompt-library.json.unreadable-<UTC time>`, never
  deleted, and the library starts empty; the popup says so.
- **Several servers.** Every server has its own library, and the app shows this computer's
  together with those of the servers in the [server list](remote-servers.md#use-a-server-on-another-machine).
  With a remote server's library there, the tree has one top entry per server, this computer
  first (it is the first section of the sidebar), and a path starts with the server's name, which a search finds too. A remote library
  is the one its owner sees in their own app, and whoever can connect to the server can change
  it: a new prompt belongs to the library it is made in, and nothing is moved or copied between
  servers. Changes arrive by themselves in every open window, here and there. When a server
  drops, its prompts stay in both popups from the copy last received, marked **not connected**:
  they can be inserted, and changed once it is back. That copy is kept in the page's memory only,
  never in a file and never in this computer's library: after the window is closed and the app
  opened again, a server that is still unreachable shows no prompts until it connects. A server removed from the list
  takes its prompts with it, and a server that is [too old](remote-servers.md#a-server-that-is-too-old) shows
  none, and no error.
- **Agents get nothing of it.** No tool reads the library, and no prompt reaches an agent
  unless you inserted it into a message. The instructions the app gives its agents are another
  thing and are not in the library.

The routes of the client API, on every server's client port (the popups use them):

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/library` | | `{"libraries": [...]}`, this server's library alone |
| `POST /api/library/{server}/groups` | `name`, `parent` | `{"group": {id, name, parent}}` |
| `PATCH /api/library/{server}/groups/{id}` | `name`, `parent` | `{"group": ...}` |
| `DELETE /api/library/{server}/groups/{id}` | | `{"ok": true}` |
| `POST /api/library/{server}/prompts` | `name`, `parent`, `text` | `{"prompt": {id, name, parent, text}}` |
| `PATCH /api/library/{server}/prompts/{id}` | `name`, `parent`, `text` | `{"prompt": ...}` |
| `DELETE /api/library/{server}/prompts/{id}` | | `{"ok": true}` |

`{server}` is `local`, a server's own library: the page calls the library of every server as
`local`, naming the server it means as the argument of the call, which the app's main process
makes on the connection it holds to that server. That server checks the rules. `parent` is the id of a group, `""` for the top of the library; in a `PATCH`
a field that is left out keeps its value. Each library of the list has `server`, `name`,
`connected`, `groups` and `prompts` (flat lists: the tree is in the `parent` fields). A call
that breaks a rule is refused with `{"error": <a sentence>, "code": <code>}`: `bad_name` and
`bad_text` (400), `not_found` and `no_group` (404), `name_taken`, `bad_move`, `library_full` and
`too_deep` (409), `text_too_long` (413), and `no_server` (404) for a `{server}` other than
`local`. A call for a server that is not connected can also end with `server_unreachable` (503:
nothing was sent), `no_answer` (504) or `bad_answer` (502); these are the app's answers (see
[The answer of a call](remote-servers.md#chats-on-a-remote-server)). Every server
gives its library to a client as `library` (`groups` and `prompts`) in its snapshot, with
`libraryNotice` when its file was set aside, and after every change, whoever made it, the client
gets it whole in an `own_library` event; no window polls. The library is level 3 of the
[feature levels](remote-servers.md#a-server-that-is-too-old) a server reports, so every server the
app connects to has one. The app holds what it gets to the rules above before it keeps or shows it.
