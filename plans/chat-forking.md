# Chat forking

A chat can branch. Go back to an earlier point, send something different, and the chat splits: the
new branch goes on from there, and the branch you left stays in the chat, whole, to come back to.
A chat is a tree of messages; the thread on screen is one path through it, from the first message
to where the chat is now.

This is what the prototype on the branch `fork-chat-feature` settled on (variant 1, run with
`scripts/proto-fork.sh`).

## Where a branch can start

Only between turns. A turn is one of your messages and everything the agent does in answer to it,
tool calls and replies, until it stops.

- At the end of a turn: after its last reply.
- At a message of yours: the branch starts after the turn before it, and the message comes back
  into the composer to be edited.

Never partway through a turn: not at a tool call, and not at a reply the agent wrote before it ran
a tool.

## In the chat

Hovering a message shows its actions. They are hidden while the agent is replying.

| On | Actions |
|---|---|
| Your message | Branch and edit · Fork and edit · Label |
| The end of a turn | Branch · Fork to new · Label |
| A reply partway through a turn | Label |

- **Branch**: your next message starts a new branch after this reply. It works on the last reply
  too: the branch you're on then stays in the chat, ending there, and you can go back to it later.
- **Branch and edit**: the chat goes back to the end of the turn before your message, and the
  message comes back into the composer. Sending it starts a new branch.
- **Fork to new**, **Fork and edit**: the same, into a new chat. The new chat gets a copy of this
  one up to that point, and its own agent session. From your message, the copy goes up to the turn
  before it, and the message is the new chat's draft. The new chat says what it was forked from,
  with a link back.
- **Label**: a small box at the message to name it. An empty label removes it.

Where the thread passes a point that splits, a "Branch n of m" marker shows; clicking it opens the
tree there.

While your next message will start a new branch, a banner above the composer says so: "New branch
after '…': your message starts it. '…' stays in the tree." After moving to the end of another
branch it says "Now on '…', where it ended." Its Back undoes the move until you send.

Once a chat has split, the header shows the name of the branch you're on, and the Tree button the
number of branches.
The sidebar shows the number of branches next to a chat that has more than one.

## The tree

Tree in the chat header, or ⌘⇧B, opens a popup with the whole chat as a tree. Each branch is drawn
off the point it splits from, the path to where you are stands out, "● here" marks where the chat
is and "end" marks where a branch ends.

- **Double-click** a message: the chat opens at that point. What you send next branches off there;
  at the end of a branch, it carries that branch on. Double-clicking your message is Branch and
  edit.
- **Right-click** a message: Branch and edit, Fork and edit and Label on your messages; Fork to new
  chat and Label on replies. A reply partway through a turn only has Label, with a note to branch
  from the turn's last reply.
- Filters: **Messages** (your messages and the replies; no tool calls) and **Labeled**. A search
  box.
- No keyboard shortcuts in the popup other than Esc, and no details panel.
- Nothing moves while the agent is replying; the popup says so.

## Branch names

A branch is named by a label on its own part, after the last point where it split off. A label
higher up is shared with the branches below it, so it names none of them. Without a label, a branch
is named by your first message after that point. A chat that has never split has one branch,
"main".

## Agent sessions

Each branch runs in its own agent session.

- Sending at the end of a branch carries its session on.
- Sending from a point that already has something after it forks the session at that point, and
  the new branch runs in the fork. For Claude Code, that is resuming the session at that message
  with fork-session.
- Branching at the end of a branch forks too, and the branch left keeps its session. Going back to
  its end and sending carries that session on.
- A chat forked to a new chat runs in one new session, forked from the source's session at the
  last message copied.

## Left out

- **Summaries of the branch left** when moving to another (pi's /tree offers them): moving just
  goes there.
- **Retry**: Branch and edit, then send the same text.
- **Folding, keyboard navigation, and the Yours and All filters** in the tree: left out for now.

## Open

The prototype runs on demo chats kept in the browser tab and answered by a fake agent; the server
never sees them. It doesn't settle what a real chat needs:

- Keeping the tree on the server, next to the transcript.
- Forking a session with Cursor.
