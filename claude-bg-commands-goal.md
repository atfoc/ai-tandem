# Goal: a Claude agent's background commands keep it waiting, not finished

This document defines an outcome: what the app shows and does when a Claude agent, a subagent or a chat's own, starts a
command that keeps running after the agent's turn has ended. It says what exists at the end, the decisions already made,
the bounds the work must stay inside, and how to confirm that it is done. It is not an implementation plan and not an
order of work. It names no files, functions or steps; how to build it is for whoever builds it.

## 1. How to read this

**Marks.** A decision, bound or risk carries one mark. A statement with no mark is `[proposed]`.

- `[user]`: the user decided it.
- `[standing]`: decided before this goal and kept; it is in the architecture document or in the code.
- `[proposed]`: proposed while the work was planned. Not a decision of the user.
- `[not verified]`: a risk or an assumption nobody has checked yet.

**Terms.**

- **Background work**: a command the agent started that goes on running after the turn in which it was started has
  ended: a shell command run in the background, or a monitor that watches a command and reports each line it prints.
  Not a subagent started with the app's spawn tool, which the app already follows.
- **Notice**: what the Claude process says when a piece of background work reports back or ends.
- **Self-begun turn**: a turn the Claude process starts by itself because a notice arrived, with no message of the
  person or of the app. A monitor causes one for each line it reports and one for its end.
- **Waiting**: the state a subagent is already in when its own turn has ended but it is not finished, because
  subagents it started still run or a result is owed to it (architecture document, subagents). Its status stays
  running.
- **Report**: what a finished subagent gives to whoever started it.

## 2. Goal

Today the app takes the end of a Claude turn to mean that the agent is idle and done. For an agent with no background
work that is true. With background work it is not: the Claude process goes on, and every notice starts another turn.
The app does not look at the background work, so a subagent is marked finished, reports early, and has its process
closed while the command it waits for is still running; a chat looks as if it keeps finishing and starting again.

At the end, an agent that has background work running is waiting, in the same sense and with the same rules as a
subagent that waits for subagents, and it is finished only after a turn that ends with no background work left. The
real result is the one that is reported. No command the agent started is left running after the agent has been stopped
or finished.

The direction is decided: the chat gets a **waiting** state, as subagents have. `[user]` The other directions that were
considered, merging the self-begun turns into one visible run and fixing subagents only, are not part of this goal.

Chats and subagents are fixed together, by one solution. `[user]` What it means for an agent to be waiting on background
work, when it starts and when it ends, is decided once and holds for a chat's own agent and for a subagent at any depth.
The chat is not a second, lighter fix beside the subagent's; any difference between them is only in how the state is
shown and what is reported to whom.

### 2.1 What was observed

Two short captures of the real Claude process (version 2.1.296, a small model, one prompt that starts a background shell
command and a monitor) were made outside the app, with the process's own stream of events. They were made with the
process's permission mode set to bypass, not with the arguments the app uses, so they show what the process does, not
what the app's exact setup would do. They are not kept in the repository.

- **A clean turn end arrives while background work runs.** About 3 and 8 seconds in, the process announces two
  backgrounded tasks. At about 10 seconds a turn ends cleanly with the text "waiting", and both tasks are still running.
- **The process then goes on by itself.** About 13 seconds in, the first command ends, a notice arrives, and a new turn
  begins. Each line the monitor reports starts another turn, and its end another. One prompt gave four turn ends, and
  the text the model gave at the last one was the real answer.
- **The process does not exit when its input is closed.** In the second capture the input was closed right after the
  first turn end. The process kept working through the background work for several seconds regardless.
- **Stopping the process from outside leaves the command behind.** When the capture's own script killed the process
  after 10 seconds, the monitor's shell command was still running. It had to be killed by hand.
- **The announcements are available.** The process says when a background task starts, changes, and ends, and it
  reports the list of running background tasks when that list changes. The app reads none of this for background work
  today; it reads it for subagents only.

What the app does with this today, from reading it:

- A subagent whose turn ends with no spawned subagents running is finished, its result is owed to whoever started it,
  and its process is queued to close. That is the early report. `[standing]`
- Closing a process ends it after a short grace, and signals the process only, not what it started. The whole process
  group is signalled at server shutdown only. `[standing]`
- Notices for tasks the app does not know are counted, so that the empty results a resumed session sends for tasks it
  lost can be skipped. A notice of background work has no task kind, so it is counted too. `[not verified]` whether
  that can ever make the app skip a real result; it was not seen.

Not checked: what the app's stop-then-close sequence does to a process that has background work; whether a chat's own
agent can be handed a results message during a self-begun turn; a chain of subagents two levels deep with a monitor at
the bottom.

## 3. What exists when it is done

### 3.1 One rule for every agent

- The same rule decides, for the chat's own agent and for every subagent: an agent whose turn ended cleanly while it
  has background work running is waiting; it is working while a self-begun turn runs; it is done after a turn that ends
  with no background work running and nothing else it waits for. The two never differ in when they start waiting, when
  they stop, or what counts as background work.
- What differs is only what follows from being done: a subagent reports to whoever started it, a chat becomes idle.

### 3.2 A subagent with background work waits

- When a subagent's turn ends cleanly and it has background work running, it is **waiting**, with the rules it has for
  waiting on subagents: its status stays running, it counts against the chat's cap, it is shown as waiting, and it has
  not reported.
- The self-begun turns that follow are the subagent's own turns. Their text and tool use are shown in its transcript
  as they happen. While one runs it is working; when it ends with background work still running, it waits again.
- The subagent is finished only after a turn that ends with no background work running and nothing else it waits for.
  Then it reports once, and the report is the text of that last turn.
- A subagent that waits on background work and on subagents it started waits for both. A subagent two levels down
  that waits on background work keeps every level above it waiting for it, as a subagent that waits for subagents does.

### 3.3 A chat with background work waits

- When the chat's own agent has a clean turn end with background work running, the chat is shown as waiting for
  background work: not idle, and not as if the run had ended. It is a state the person can tell from working and from
  idle.
- A self-begun turn in a waiting chat is shown as the agent working, then the chat waits again. It is not shown as a
  new run by the person and does not look like the chat finishing and restarting.
- The chat is idle again after a turn that ends with no background work running.
- A subagent's report that reaches a waiting chat during a self-begun turn is not lost and is not taken for the end
  of that turn, as it is not for a waiting subagent. `[not verified]` that this can go wrong today; the delivery race
  was not tested.
- What the person can do in a waiting chat is what they can do in a working one. Stopping it is one of those things,
  and a message the person sends is taken as it is taken today for a working chat. `[proposed]`

### 3.4 Stopping and finishing leave nothing behind

- When a waiting subagent or chat is stopped by the person, by the chat being deleted, by a branch or a fork, by a
  limit, or by the server shutting down, the background work it started ends with it. After the process is gone, no
  command the agent started is left running.
- A subagent or chat that is closed because it finished has no background work left, by 3.2 and 3.3, so there is
  nothing for closing to leave behind. The same guarantee holds if the Claude process ends on its own while work runs.
- A Claude process that ends by itself while it has background work is treated as the process ending, as today: a
  subagent is stopped or failed as for any ending of its process, and the chat is told.

### 3.5 Notices do not hide results

- A notice of background work is never taken as a task the app lost. The empty results that a resumed or forked
  session sends for tasks it lost are still skipped, and a real result is never skipped because of them.

### 3.6 What is the same as before

- An agent with no background work: when its turn ends it is finished, idle, or waits for subagents exactly as today.
- A subagent that waits for subagents it started, and the results it is handed.
- Usage and turn accounting: every turn the process ends is counted as it is today, self-begun ones included. `[proposed]`
- Chats of the other agents (Cursor, pi): nothing changes for them.
- The app's own permission handling, the steering the agent is given, and the way a subagent is started.

## 4. Decisions and bounds

**4.1 Waiting is the existing state, and one solution serves chats and subagents.** `[user]` The chat gets the waiting
state subagents have. No new kind of state is invented for background work: a subagent waiting on background work is
waiting in the same sense, with the same cap and the same rule that it reports after its last turn. The knowledge that
an agent has background work running, and the decision that it therefore waits, live in one place that the chat's own
agent and every subagent go through. A second copy of the rule for the chat, or a fix that covers only one of the two,
does not meet this goal. A change to the rule changes both.

**4.2 The turn end is not the end of the agent.** `[standing]` Finished, idle and waiting are decided from what the
process says is still running, not from the turn end alone. The announcements the process already makes are the source;
the app does not guess from the agent's text or from timing.

**4.3 Turns are not merged.** `[user]` Self-begun turns are shown as the turns they are. Waiting is shown between them.
Merging them into one run is out of scope.

**4.4 One report.** `[standing]` A subagent reports once, after its last turn, and that report is the real result. The
early report of a turn that ended while work ran is never sent.

**4.5 Nothing left running.** `[proposed]` Ending an agent ends what it started, in all the ways an agent ends (3.4). It
is not left to the agent's own wish to clean up, and it does not depend on how long a grace was waited.

**4.6 The process is not closed as finished while it waits.** `[proposed]` Closing a process that still has background
work is an act of stopping, never of finishing.

**4.7 Only Claude.** `[proposed]` The change is for the Claude agent. Whatever it adds to the common description of an
agent's events must be harmless to the others, and their behaviour is unchanged.

**4.8 No change to the model's instructions as the fix.** `[proposed]` The behaviour must be right whatever the model
does after it starts background work: end its turn at once, or go on. A change to the steering text, which is written
about subagents and may push a model to end its turn early after starting a command of its own, is a separate decision
and is not needed for this goal. `[not verified]` that it does push models that way.

**4.9 A wait that never ends is the person's to end.** `[proposed]` A monitor can run for as long as the agent likes.
A subagent or chat that waits on one stays waiting, and counts against the cap, until the work ends or the person stops
it. No time limit is added by this goal. `[not verified]` whether that is enough in practice.

**4.10 The tests spend nothing.** `[standing]` The tests of this work use a stand-in agent that plays recorded streams
of the real process. No paid model is called to confirm it. Following `AGENTS.md`, the default set of the packages
changed while working, the full set of them and the whole default run before finishing, and the checks of what a screen
shows if the waiting state is shown by a screen.

## 5. Out of scope

- Merging self-begun turns into one visible run, and any change to how turns are counted.
- Fixing subagents only and leaving the chat as it is.
- A time limit, or a count limit, on background work.
- Changes to the steering text or to how an agent is told to wait for subagents (4.8).
- The other agents' own background mechanisms.
- Showing the person the individual background commands, their output, or a list of them. The state of waiting is
  shown; what is being waited for is not.
- Anything about the app's permission handling.

## 6. How it is confirmed

Using a stand-in agent that plays streams recorded from the real process, covering the sequence of 2.1, and the real
manager of the server:

### 6.1 A subagent with background work

- The subagent's first turn end, with two background tasks running, leaves it running and waiting. It has not reported,
  its process has not been closed, and the chat's own agent has been handed nothing for it.
- The notice of the first task starts a self-begun turn. While it runs the subagent is working; when it ends with the
  monitor still running it is waiting again.
- Each monitor line is a turn, and between turns the subagent is waiting.
- After the last notice and a turn that ends with no background work, it is finished, and the chat's agent is handed
  one report that holds the text of that last turn.
- A subagent that waits on a subagent it started and on background work finishes only when both are over, in either
  order.
- A chain two levels deep with the monitor at the bottom keeps both levels waiting, then finishes the lower one and then
  the upper one with its own report.

### 6.2 A chat with background work

- The same recorded stream that 6.1 plays to a subagent is played to a chat's own agent. The sequence of states, working
  and waiting and then done, is the same at each step; only the way it is shown and what follows (a report, or idle)
  differ. One check covers both, so that the two cannot drift apart.
- The chat's turn end with background work running shows the chat as waiting, and it is not idle.
- The turns that follow show as the agent working, and the chat waits between them.
- The chat is idle after the turn that ends with none running, and its transcript holds every turn's text.
- What the screen shows is confirmed by the browser checks that cover the chat's states.

### 6.3 Nothing left behind

With a stand-in that starts a real, harmless long-running command, the check looks at the machine's process list
afterwards:

- Stopping a waiting subagent, stopping a waiting chat, deleting the chat while it waits, and shutting the server down
  each leave no such command running.
- The stand-in process ending by itself while its command runs does not leave it either.

### 6.4 Notices and results

- The notices of background work do not raise the count of lost tasks.
- The empty results of a resumed session are still skipped, with and without background work around them.
- A real result that comes after notices is delivered, not skipped.

### 6.5 What does not change

- A subagent and a chat with no background work end exactly as before: the turn end finishes the subagent, and the chat
  becomes idle.
- A subagent that waits only for subagents behaves as before.
- The usual counts of turns, tokens and cost are the same as for any other turn.
- Cursor and pi chats and subagents are not changed.

### 6.6 Not confirmed by tests

One run of the real Claude process through the app, to see the waiting state with a real model, costs money. It is run
only when the person asks. Until then the behaviour of the process is known from the recorded captures, of one version of
it (2.1), and not from the app's exact arguments. `[not verified]`

### 6.7 The documents

The architecture document says that an agent with background work waits and when it is finished, in the place where it
says that a subagent that started subagents waits, and says what ending an agent does to what it started.
