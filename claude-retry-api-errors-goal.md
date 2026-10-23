# Goal: agents survive temporary API and login errors

## What this is

When an agent's turn fails for a reason that is temporary (the provider is overloaded, the network drops,
a login token is being refreshed), the agent is tried again by itself, a few times, with a pause that grows.
When that does not help, the agent is not ended: it is **paused**, with everything it was doing and
everything it was owed kept, and the agent that started it can **resume** it, in the same session, where it
stopped. A person gets all of this by writing "continue" to the main agent.

Nothing is lost to a temporary error that has passed: no work, no subagent, no result.

## Why

About twenty Claude sessions (leads and the chunks they started) failed with a login error within two
minutes of each other, because they share one login token that expires and is refreshed by whichever process
notices first. Each lead's turn ended with the error and was recorded as finished. Finishing a lead stopped
every chunk it still had running. Nothing tried again, nothing said what to do, and the stopped
subagents could not be started again because the app did not keep the session they ran in.

## Terms

- **Main agent**: the agent of the chat itself.
- **Subagent**: an agent the app starts for another agent (a lead started by the main agent, a chunk started by a lead).
  Native subagents of a provider's own (the ones its CLI runs inside its process) are not part of this goal.
- **Parent**: the agent that started a subagent.
- **Temporary error**: an error of a turn that the provider or the network reports as one that can pass: a login
  failure, a rate limit, an overloaded or failing server, a lost connection. A billing error, a refused
  request and any error that is not clearly temporary are **not** temporary; they end a turn as they do today.
- **Retry**: the app starts the agent again on the same session and tells it to carry on. It is not a message
  from the person.
- **Paused**: a subagent whose retries ran out. It has no process, keeps its session, and is neither running nor finished.
- **Resume**: the parent starts a paused or stopped subagent again on its session.

## Outcomes

### 1. A temporary error is told from the others

1.1 For Claude, a turn that ends with an error is classified as temporary or not from what the CLI
reports about it, not from guessing at free text where the CLI gives a reason.
1.2 A login failure ("Not logged in", authentication failed) is a temporary error.
1.3 An error that is not temporary behaves exactly as it does today: for a subagent, it is finished with the
error and its result goes to its parent; for the main agent, the chat holds with the error note.
1.4 The same classification serves Cursor and pi where they report enough to tell. Where an agent kind
cannot be told apart or cannot reopen a session in a new process, it behaves as it does today and the
difference is written down as a deviation.

### 2. A temporary error is retried

2.1 The main agent and every subagent are retried on a temporary error, by the same rule.
2.2 A retry closes the agent's process and starts a new one on the same session, then sends it one message:
carry on, the last turn failed with a temporary error. A new process also reads the current login, which is
how a login failure heals.
2.3 There are four attempts. The pauses before them are about 20 seconds, 1 minute, 3 minutes and 8 minutes, each
with random jitter, so that agents that failed together do not retry together. The values are in one place and
a test can make them short; the production values stay what they are.
2.4 An attempt that gets a reply from the model ends the retrying: the agent is working again and its next
temporary error starts the count again at the first attempt.
2.5 After a login failure, the agents that failed do not restart all at the same moment: the number of retries
starting at once is limited, and the next one starts once the previous one has had a reply or failed.
2.6 While a subagent is waiting between attempts it is still running: it counts against the chat's cap on
running subagents, the subagents it started keep running, and the results owed to it stay owed. Its record
says that it is retrying, which attempt, and when the next one is.
2.7 A retrying main agent shows as working. The thread says in a note what happened and when it tries next.
2.8 What the person does ends a retry: Stop and Interrupt on the main agent cancel the main agent's pending
retry and those of its subagents; stopping a subagent cancels its retry. A message the person sends to a main
agent that is between attempts is taken at once as a new turn on the session, and the pending retry is
cancelled.
2.9 Every attempt, and the end of the retrying, is written to the server's log with the chat, the subagent and the error.

### 3. When retrying does not help, the agent is paused, not ended

3.1 After the last attempt fails, a subagent becomes **paused**, with the reason (the error text) on its
record. Its process is closed. It is not finished: its parent is not handed a result for it.
3.2 Pausing a subagent does **not** stop the subagents it started. They keep running, and their own temporary
errors are retried and paused by the same rules.
3.3 The results owed to a paused subagent (from subagents that finish after it paused, or that had finished
before) stay owed. They are not given up because it is paused.
3.4 A paused subagent does not count against the chat's cap on running subagents.
3.5 After the last attempt fails, the main agent holds with the error note, as a failed turn does today.
The session is kept, and the person's next message resumes it.
3.6 A subagent that is paused or retrying when the server stops is **paused** when the chat is loaded again
(not stopped), with its session and reason intact.

### 4. A parent resumes what was paused or stopped

4.1 Agents get a tool to resume a subagent, in the family of the tools that start and stop subagents, offered
to the same agents, under the same limits on who may use it.
4.2 It resumes only a subagent that is **paused** or **stopped**, and only one the caller started itself.
Anything else is refused with a sentence that says why: it is running, it is finished, it was not started by
the caller, or its session was not recorded.
4.3 A resume starts the subagent on its recorded session with its recorded agent kind, model and effort,
with the credentials of a new subagent, and sends it "carry on" together with every result owed to it. It
answers at once with a receipt, as starting a subagent does, and the subagent runs in the background.
4.4 A resume is held to the same limits as starting a subagent: the cap on running subagents, the depth, the
chat being archived or the server shutting down. A refusal for one of them says which.
4.5 A resumed subagent is running again: its end time and the mark that its result was owed are cleared, and it
finishes, retries and pauses by every rule above.
4.6 Resuming a subagent does not start the subagents below it that were stopped with it. Its "carry on"
message lists them, and it resumes the ones it still needs.
4.7 The session of every subagent the app starts is recorded on its record when it is started, whatever the
agent kind. A subagent started before this was built has none, and cannot be resumed.

### 5. The agent is told, and "continue" is enough

5.1 A message that goes to an agent carries a list of the subagents it started that are paused, or stopped by
anything other than its own request to stop them. For each: its name, its state, and why. A message that
carries nothing of the kind is unchanged.
5.2 The list goes on every message of the person to the main agent, and on every "carry on" message to a
subagent, for as long as the list is not empty.
5.3 The person writing "continue" to the main agent therefore gets the main agent to resume its paused leads,
which resume the chunks they need. A message that says something else is not turned into a resume by the app:
the agent decides.
5.4 There is no new button, banner or screen. A retrying subagent and a paused one show in the rows that
subagents already have, with a sentence that says it ("Retrying in 40 s · 2 of 4", "Paused · login failed").

### 6. Results are not lost

6.1 A result owed to the main agent is carried by the person's next message, as it is today.
6.2 A result owed to a paused subagent is carried by the message that resumes it. It is not carried to a
subagent that is paused, and is not given up while it is paused.
6.3 A result owed to a subagent that is stopped is given up as it is today. This goal does not change it.
6.4 A subagent's turn that fails with a temporary error does not produce a result for its parent while it is
being retried. Its parent hears from it when it finishes, or is told that it is paused.

## Restrictions and decisions already made

- **Retry is a resume.** There is one way to start an agent again on a session, and retrying, resuming a
subagent and the person's next message all use it. No second mechanism that keeps a process alive and talks
to it after an error.
- **No new place for the person to act.** The person's way to continue is a message to the main agent. The
app does not resume subagents because a message arrived.
- **A parent resumes only what it started.** The main agent resumes its leads; a lead resumes its chunks.
- **Only paused and stopped subagents are resumed.** Not running, not finished, not failed to start.
- **Paused is a status of its own**, not "stopped": stopping a subagent stops what it started, pausing one does not.
- **Delivery of results keeps its rules.** The states of a result (owed, owed again, sent, given up) and the
rule that a result that failed once is not put on the person's message stay as they are. A retry or a
resume is a turn that carries results like any other.
- **The cap, the depth, shutdown and archive apply** to a retry and a resume as to starting a subagent.
- **Clients are older than servers and servers than clients.** The new status and the retry fields are
additions. A client that does not know a status shows the subagent without breaking, and a server answers a
client that does not know the new fields as before.
- **Tests follow the repository's rules** (`AGENTS.md`): the default set stays fast and passes on a loaded
machine, the waits of the retry are made short for tests the way the other production waits are, no test calls a paid
model, and what is too slow for the default set goes to the full set with the default-set test that covers the same behaviour named.
- **Wait values stay as the production ones** in a built server; only a test lowers them.

## How it is known to be built

Each of these is a scenario a test runs against stand-in agents, with the waits lowered, and passes.

1. A subagent's turn ends with a login failure and the next attempt gets a reply: the subagent finishes
normally, its chunks were never stopped, its result reaches its parent once.
2. It fails on all four attempts: it is paused with the reason, its process is closed, its running chunks keep
running, a chunk that finishes afterwards leaves its result owed to the paused lead, and the lead is not
counted in the cap.
3. The parent's next message lists the paused lead; the parent resumes it; the lead starts on its recorded
session, receives the owed result with "carry on", and finishes.
4. A resume of a running, completed, failed, other-parent's, or session-less subagent is refused, each with its
own sentence; a resume that would pass the cap is refused with the cap's sentence.
5. Twenty subagents fail with a login failure in the same second: their retries do not start together, all
of them are retried, and none is lost.
6. A non-temporary error ends a subagent as it does today: finished with the error, chunks stopped, result owed to the parent.
7. The main agent fails with a temporary error: it retries, the person sees the notes, and a person's message
between attempts cancels the retry and is the next turn.
8. Stop on the main agent during a backoff cancels it and the retries of its subagents; nothing starts later.
9. The server stops while a subagent waits between attempts: after the next load it is paused, resumable, with its owed results still owed.
10. A subagent started by this build has its session in its record; one from before has none and says so when a resume is asked.
11. A message to an agent with nothing paused or stopped is byte for byte what it was.
12. The rows of a retrying and a paused subagent say so in the clients, and a client that has never heard
of the new status still draws the list.

## Not in this goal

- Recovering the subagents stopped before this was built.
- Refreshing the login token ahead of its expiry, or any way to keep many processes from refreshing it at once other than retrying.
- Resuming a subagent because the app thinks it should; resuming a finished or failed one.
- Keeping the results owed to a stopped subagent (6.3).
- Native subagents of a provider's own CLI.
- A new screen, button or setting for any of this.
