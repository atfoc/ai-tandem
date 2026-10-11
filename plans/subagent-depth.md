# Subagent depth and a cap on running subagents

A plan for two new settings of a chat, chosen in the composer and remembered as sticky defaults: how many
levels of subagents the chat may have, and how many of its subagents may run at once. Nothing in it is built
yet. It says what is built, what is expected at the end, and the decisions and bounds the work has to keep.
It does not say how to build it.

## How to read this

**Marks.** A decision or bound carries one mark:

- `[user]`: the user decided it.
- `[proposed]`: proposed while the plan was discussed; the user read it and did not change it.
- `[not verified]`: a stated risk or an assumption nobody has checked yet.

**Terms.**

- **Subagent**: an agent a chat's agent starts with `spawn_subagent`. Not a chat: a record inside the chat.
- **Level**: how far a subagent is from the chat. A subagent the chat's agent started is at level 1, a
  subagent that one started is at level 2.
- **Depth**: the chat's setting: the deepest level a subagent of the chat may be at.
- **Cap**: the chat's setting: the most subagents of the chat that may run at the same time.
- **Sticky default**: a value the app remembers from the last choice and gives to the next new chat, as it
  does today for the server, the agent, the folder, the model and the effort.
- **Waiting subagent**: a subagent whose own turn has ended while subagents it started are still running or
  their results have not reached it yet.

## 1. Goal

Today a chat's agent can start subagents and those subagents cannot start any: the depth is fixed at 1, and
nothing limits how many run at once. The person cannot change either.

The goal is that the person chooses both per chat, in the composer, before the first message, and that the
app remembers the choice for the next chat the way it remembers the other composer choices.

## 2. What the user gets

1. A "Subagents" chip in the composer's toolbar. It opens a popover with both settings.
2. **Depth**: Off, 1 level, 2 levels or 3 levels.
   - Off: the chat's agent has no subagent tools.
   - 1 level: today's behaviour.
   - 2 or 3 levels: a subagent may start subagents of its own, down to that level.
3. **Running at once**: the cap, with 100 as the default.
4. Both are fixed once the first message is sent, like the model and the effort.
5. Both are sticky: a new chat starts with what was chosen last, by the same rules as the other sticky
   defaults.
6. A subagent that started subagents gets their results and can work on with them before it reports to
   whoever started it.

## 3. What is expected at the end

- A new chat shows the Subagents chip with the sticky values, and both can be changed until the first
  message.
- After the first message the chip shows the chat's values and cannot be changed.
- A chat at depth Off: its agent is offered no subagent tools, and a call of one is refused.
- A chat at depth N: an agent at a level below N can start a subagent; a subagent at level N is offered no
  subagent tools, and a call of one is refused.
- A spawn that would take the chat over its cap is refused with a message that names the cap, and starts
  nothing. A spawn after a running subagent has ended goes through.
- A subagent that started subagents does not count as finished while any of them runs or while a result is
  still owed to it. It receives the results, and its own result goes to its parent after that.
- Stopping a subagent stops every subagent below it. Stopping the chat's agent stops all of them, as today.
- The subagent view shows a nested subagent under the one that started it, and opens its thread.
- The choice made in one new chat is what the next new chat in the same group on the same server starts
  with. A new group starts with the values a new group gets for the other defaults.
- A chat that existed before this feature behaves as it did: depth 1, and a cap of 100.
- Runs behave exactly as they do today.

## 4. Decisions

| # | Decision | Mark |
|---|---|---|
| D1 | Depth and cap are settings of a chat, chosen in the composer, and sticky like the other composer choices. | `[user]` |
| D2 | Both are locked at the first message, to keep the same experience as the model and the effort. | `[user]` |
| D3 | The cap's default is 100, and the cap is configurable next to the depth. | `[user]` |
| D4 | One "Subagents" chip opens a popover that holds both settings; no two separate chips. | `[user]` |
| D5 | Runs are out of scope. | `[user]` |
| D6 | Depth values are Off, 1, 2 and 3. The default is 1, which is today's behaviour. 3 is the most. | `[proposed]` |
| D7 | A spawn over the cap is refused, not queued. The calling agent reads why and can wait for a result, stop a subagent, or do the work itself. | `[proposed]` |
| D8 | The cap counts every running subagent of the chat, at every level, waiting subagents included. | `[proposed]` |
| D9 | The cap is a whole number from 1 to 100. 100 is both the default and the most. The popover offers 5, 10, 25, 50 and 100. | `[proposed]` |
| D10 | A branch and a fork carry their source's depth and cap and cannot change them. | `[proposed]` |
| D11 | The sticky default is kept per group and per server, and is the same for all agents, like the folder. Where a group has none, the ungrouped group's is used, then depth 1 and cap 100. | `[proposed]` |
| D12 | A chat made by an API client reads and feeds no sticky default, as for the other defaults: it gets depth 1 and cap 100 unless the client names values. | `[proposed]` |
| D13 | A subagent started by a subagent takes the model and effort of the subagent that started it where none is named, not the chat's. | `[proposed]` |
| D14 | A subagent can stop only the subagents it started itself. | `[proposed]` |
| D15 | A result that cannot be delivered to a waiting subagent fails that subagent, and its parent is told of the failure. | `[proposed]` |

### The popover

| # | Decision | Mark |
|---|---|---|
| P1 | Two sections: "Depth", then "Running at once". Each marks its current value. | `[proposed]` |
| P2 | With depth Off the "Running at once" section is greyed out. | `[proposed]` |
| P3 | A pick is saved at once and the popover stays open, so both can be set in one visit. A click outside or Esc closes it. Esc there does not stop the agent. | `[proposed]` |
| P4 | The chip's label always says the depth, and says the cap only when it is not 100. | `[proposed]` |
| P5 | Only one of the toolbar's menus is open at a time, this one included. | `[proposed]` |
| P6 | The chip is editable on a new chat only. On a started chat, a branch and a fork it is shown fixed. | `[proposed]` |

## 5. Bounds

- **Not queued.** No waiting list of spawns and no "queued" state of a subagent.
- **No value above the limits.** No depth above 3 and no cap above 100, from the composer or from an API
  client. A value outside the range is refused, not clamped.
- **No change after the first message.** No way to raise or lower either setting on a started chat.
- **Runs are not touched.** A run's agents keep depth 1 and get no cap. The run composer gets no chip, and
  a run's settings get no new field.
- **Existing chats are not migrated.** A chat without stored values reads as depth 1 and cap 100.
- **Native subagents stay off.** The agents' own subagent tools remain disabled in app chats, at every
  level. Nesting is done with `spawn_subagent` only.
- **The other sticky defaults do not change.** Server, agent, folder, model and effort keep their rules.
- **Tests follow `AGENTS.md`.** No paid test is run unless the user asks.

## 6. Order of work

Two steps, each usable by itself. `[proposed]`

1. **The settings.** The chip and popover, both settings on the chat, the lock, the sticky defaults, and
   enforcement of depth Off and 1 and of the cap. The Depth section offers only Off and 1 level.
2. **Nesting.** The waiting subagent, delivery of results to it, stopping what is below a subagent, and the
   nested view. The Depth section then offers 2 and 3 levels.

## 7. Risks and what is not verified

- **A remote server without this feature.** The settings have to reach the server a chat starts on. What a
  server that does not know them does with them has not been checked. `[not verified]`
- **Load at the cap.** Each running subagent is a live agent process. What a machine carries at 100 has not
  been measured; 100 is the user's number. `[not verified]`
- **A second turn in a subagent.** A subagent runs one turn today. That each agent (Claude, Cursor, pi)
  takes a further message as a subagent the way it does as a chat's agent has not been checked.
  `[not verified]`
- **Seven controls in the toolbar.** The one chip was chosen to keep the toolbar narrow; how it looks on a
  narrow board chat panel has not been tried. `[not verified]`

## 8. Not in this plan

- Subagent depth and a cap for runs. `[user]`
- A queue for spawns over the cap.
- A cap per level or per subagent; the cap is one number for the whole chat.
- Changing either setting on a started chat.
