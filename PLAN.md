# Memo Router: a first personal agent

**Owner:** Will McCann
**For:** Build with Claude meetup, Saturday 2026-09-05
**Status:** Revision 3, drafted 2026-09-04 with Claude Code
**Project folder:** ~/projects/voice-slack-agent
**Goal of this document:** a plan I could start building from Monday morning, and a story I can tell a room of first-time agent builders on Saturday.

---

## One-page summary

**What it is.** A personal agent that handles my voice memos. I record a memo on my phone; the app turns it into text and POSTs it to a webhook. An agent reads it, decides which of five kinds of memo it is, does the right thing for that kind, and sends me a Slack DM with the result.

**The five routes.** Task, journal, mindfulness or health reflection, question, idea. A sixth outcome, "ask me", is for anything it cannot place.

**What makes it an agent.** The original idea was a fixed pipeline that logged a summary. Adding one decision, "what should happen because of this memo", and giving the agent tools to carry that out is what turns it into an agent. Perceive, decide, act, report.

**Version 0 needs no infrastructure.** Phone app in text mode, a 20-line Apps Script webhook that appends to a Google Sheet, and a Claude Code scheduled task that processes new rows and DMs me. Version 0 creates nothing; it only proposes. It earns write access after a week of being right.

**Version 1** adds write tools (Trello card, journal doc, reminder) with an ask-first rule for anything with a date. **Version 2** replaces the hourly poll with an AWS Lambda so the memo is handled in seconds. The agent's logic does not change between versions; only where it runs does.

**Process.** Three revisions on 2026-09-04, driven by four rounds of questions in Claude Code. Revision 3 was entirely about privacy and secrets. Most of the revision was about what the agent is allowed to do, not how to build it.

---

## 1. The one-sentence version

Every time I record a voice memo to myself, an agent reads the transcript, decides what kind of memo it is and what should happen because of it, does that, and sends me a Slack DM saying what it did.

## 2. Why this one

I record memos to myself and then lose them. The memo is already a signal that I wanted something to happen. Today nothing happens.

It is a good first agent because:

- The trigger is unambiguous. A memo either arrived or it did not.
- The input is mine. No permissions, no other people's data.
- Every action is easy to undo. A bad DM costs nothing.
- The decision is real. "What should happen because of this memo" is a judgment call, and that judgment is the agent.

## 3. Pipeline versus agent (the teaching point)

My first draft of this idea was: transcribe, summarize, write a row with date, one line, and type. That is a pipeline. Every memo goes through the same steps in the same order and nothing decides anything.

The change that makes it an agent is small. Instead of labeling the memo, the agent chooses what to do with it, and it has tools to do those things.

| Memo sounds like | What the agent decides to do |
| --- | --- |
| "Remind me to call the vet Thursday" | Extract the task and a date. Propose it as a task. |
| "I keep putting off the website redesign" | Treat as reflection. Summarize the theme, no task. |
| "Slept badly, skipped the walk, felt foggy by noon" | Health reflection. Log it, note any pattern against recent entries, never make it a task. |
| "What was that Radix component for popovers?" | Look it up. Reply with the answer. |
| "Idea: agent that grooms my Trello board" | File as an idea. Link it to related ideas if any. |
| Unclear, half a sentence, background noise | Do not guess. Ask me one clarifying question. |

**The five routes, and how the agent tells them apart**

| Route | Signal | Action in version 0 |
| --- | --- | --- |
| Task | An imperative aimed at future me: remind, call, send, buy, fix. Often a day or time. | Extract the task and any date. Propose it in the DM. |
| Journal | Thinking out loud about work, plans, people, decisions. | One-paragraph summary and the theme. No task. |
| Mindfulness or health | Sleep, mood, energy, exercise, meditation, food, a symptom. | Log it with the date. Compare with the last two weeks of health entries and mention a pattern only if one is there. Never a task. |
| Question | Ends in a question mark, or starts with what, how, where, which. | Look it up and answer in the DM. |
| Idea | "Idea:", "what if", "someday". | File it. Mention earlier ideas that look related. |
| Ask me | Fragment, noise, or two routes fit equally well. | One clarifying question in the DM. Do not guess. |

Health versus journal is the ambiguous pair. Rule: if the memo is mainly about my body or state of mind, it is health; if it is mainly about a thing in the world, it is journal. When it is both, the agent picks health and says so, since the pattern-tracking is the more valuable side effect.

Health memos stay in the DM and the Sheet only. They are never written anywhere shared, in any version.

The loop, in the words I will use on Saturday: **perceive** (a memo arrived), **decide** (what kind, what action), **act** (call a tool), **report** (DM me). Every agent is that loop. This is the smallest honest version of it.

## 4. Discovery: how I got here

1. **Braindump.** One idea: voice memo goes to a headless cloud function, which logs a summary. Not sure it was useful enough.
2. **First reframe.** Claude Code pointed out the idea was a pipeline, not an agent, and that adding a routing decision fixed it. Kept the idea.
3. **Capture.** I already use the Webhook Voice Automation app (Android; "Webhook Audio Recorder" on iOS). It has a text mode that runs on-device speech-to-text and POSTs the transcript to any URL. That removes transcription from the plan entirely.
4. **Routes.** Started with four kinds of memo. Revision 2 added a fifth, mindfulness or health reflection, because I record those and they are not journal entries: the useful action is spotting a pattern over weeks, not summarizing one memo.
5. **Runtime.** Chose to run version 0 as a Claude Code scheduled task rather than on a cloud function, so the first version needs no infrastructure. Cloud is phase 2.
6. **Output.** Chose a Slack DM to myself as the single place results land. One sink keeps version 0 small.

Questions still open are listed in section 9.

## 5. Architecture, version 0 (no infrastructure)

```
Phone: Webhook Voice Automation (text mode)
   |  HTTP POST, JSON with the transcript
   v
Google Apps Script web app (doPost, ~20 lines)
   |  appends a row: timestamp, transcript, status=new
   v
Google Sheet "memo_inbox"
   |
   |  (every hour, or on demand)
   v
Claude Code scheduled task: "process new memos"
   |  reads rows with status=new
   |  for each: decide type and action, use tools, mark processed
   v
Slack DM to me: one message per memo, or a digest
```

**Where the scheduled task runs.** Two options, same prompt either way: a Claude Code cloud routine (hourly at most, uses claude.ai connectors) or a local launchd job on my Mac running `claude -p` (any interval, uses the MCP servers already configured in Claude Code). Start local because it is faster to iterate on; move to the cloud routine once the prompt is stable.

**Why a Sheet in the middle.** The app pushes; a scheduled task pulls. Something has to hold the memo between the two. A Sheet is free, visible, and doubles as the audit log. Apps Script is the cheapest possible webhook receiver and stays inside Google, which is where the memo idea started.

**Alternative receivers** if Apps Script is annoying: a Make.com or n8n catch hook writing to the same Sheet. Same shape, no code.

**Tools the agent has in version 0**

| Tool | Read or write | Purpose |
| --- | --- | --- |
| Read memo_inbox rows | read | perceive |
| Web search | read | answer questions |
| Read Trello board | read | check whether a task already exists |
| Read calendar (if connected) | read | resolve "Thursday" to a date |
| Mark row processed | write | idempotency |
| Send Slack DM | write | report |

Version 0 has exactly one side-effecting output: the DM. Tasks and ideas are *proposed* in the DM, not created anywhere. That is deliberate. I want to watch its judgment for a week before I let it write to my task board.

## 6. Version 1: let it act

Once the routing looks right for a week:

- **Add write tools:** create a Trello card, append to a journal doc, create a reminder.
- **Add a confirmation rule:** the agent acts directly on high-confidence, low-cost routes (journal, idea) and asks in the DM before anything that creates a task with a date.
- **Add the "ask" path properly:** if I reply to the clarifying DM, the next run picks up my answer and finishes the memo.

**Built 2026-09-08**, on the `add-write-tools` branch, with three decisions the bullets above left open:

- The journal is a second tab of the audit Sheet, not a Google Doc. No new Google scope, and the content stays inside the one Sheet rule 8 already allows. Ideas are filed to the same tab with a kind column.
- A reminder is a Slack message scheduled into the same DM. No new Slack scope for that; the reply loop needs one, reading replies in that DM and nothing else.
- Rule 15 is stricter than the second bullet: a Trello card or a reminder is *always* proposed first, dated or not, and made only after I reply "yes" in the thread. Journal and idea entries file directly at high confidence because the audit Sheet is not "outside". The reply loop is what makes the write tools reachable at all.

**Sinks, for rule 8.** Memo content may land in: the audit Sheet (both tabs), my Slack DM (including scheduled messages in it), and a Trello card in one list holding the task as the agent phrased it. Nothing else.

**Rule 15 loosened, later the same evening.** Confirming every card by hand lasted one evening. The rule is now: at high or medium confidence the agent creates the card, reminder or journal entry and tells me exactly what it made, with the date it worked out; at low confidence it asks; it never deletes or moves anything. The confirmation was buying me nothing the DM could not show me, and it cost a reply per memo.

## 7. Version 2: make it event-driven

The hourly poll is the only thing about version 0 that feels like a toy. Version 2 replaces the poll with a function that runs the moment the memo arrives:

- **AWS Lambda behind a function URL** (my home turf), deployed with CDK. The app POSTs straight to the function URL with an auth header the app already supports.
- The function calls the Claude API with the same tool definitions the scheduled task used. The routing logic does not change; only where it runs does.
- Latency goes from "within the hour" to seconds.
- The Sheet stays as the audit log. Every run writes one row: input, decision, action, result.

This is the part of the talk where I say: the agent was the same the whole time. Version 0 ran it in Claude Code. Version 2 runs it in a function. Do not start with the function.

## 8. Test set

Ten memos I will use to check the router before trusting it. These get recorded as real memos once the receiver exists.

| # | Memo | Expected route |
| --- | --- | --- |
| 1 | "Remind me to call the vet Thursday" | task, date resolved |
| 2 | "Pick up the dry cleaning" | task, no date |
| 3 | "I keep putting off the website redesign and I think it's because I don't know what the first step is" | journal |
| 4 | "What's the Radix component for a popover?" | question, answered |
| 5 | "Idea: an agent that grooms my Trello board every Sunday" | idea |
| 6 | "Uh, the, the thing from earlier" | ask me |
| 7 | "Cancel the vet reminder" | task update, references memo 1 |
| 8 | "Note to self: the meetup went well, ten people had never built an agent" | journal |
| 9 | "Slept about five hours, skipped the walk, felt foggy by noon" | health, pattern check against recent entries |
| 10 | "Twenty minutes of meditation this morning, first time in a week, and I was less snappy in the standup" | health, not journal, even though it mentions work |

Memo 10 tests the health-versus-journal rule. Memo 7 is the other interesting one. It only works if the agent can see earlier memos, which is an argument for the Sheet being readable, not just a queue.

## 9. Open questions

- **Partly answered.** A Claude Code cloud routine can only use connectors attached on claude.ai, not the MCP servers configured in Claude Code on my Mac, and its minimum interval is one hour. So version 0 needs Slack and Google Sheets connected on claude.ai, which I must confirm before Saturday. Fallback if that is a hassle: a launchd job on my Mac that runs `claude -p "process new memos"` every 15 minutes with the local MCP servers.
- What is the exact JSON the app sends in text mode? Need one real POST captured before writing doPost.
- Should journal entries also land in a Google Doc, or is the DM enough for now?
- Hourly, or every 15 minutes? Cost is negligible either way; this is about how quickly I expect a reply.
- Does the app's text mode handle a two-minute rambling memo, or does it truncate?

## 10. What I will say on Saturday

- I brought one idea and it was not an agent yet. Adding one decision made it one.
- I did not build any infrastructure. The first version is a scheduled task and a spreadsheet.
- I gave it read tools first and one write tool. It earns write tools by being right for a week.
- The plan took three revisions before Saturday (see log). The third was about what the agent must never do with my data, which is the revision I did not expect to need. The revisions were mostly about *what it should be allowed to do*, not how to build it.

---

## Revision log

| Rev | Date | What changed | Why |
| --- | --- | --- | --- |
| 1 | 2026-09-04 | First full draft | Discovery answered: memo router, webhook app in text mode, scheduled task v0, Slack DM output. Reframed from pipeline to agent. |
| 2 | 2026-09-04 | Added the health route, a one-page summary, two test memos, and the cloud-routine constraint | Second round of questions: confirmed propose-only autonomy for v0, five routes instead of four, cloud phase stays one section, and the file should double as the meetup handout. |
| 3 | 2026-09-04 | Data and secrets precautions added to CLAUDE.md (15 numbered rules) with enforcement: Read deny rules for .env, a Bash guard hook, and gitleaks on pre-commit | Memos are personal and some are health-related; the webhook is a public entry point. Guidance and enforcement are separated on purpose. |
| 4 | 2026-09-04 | Rule 4 amended: the shared secret is a header where the receiver can read one, a JSON body field where it cannot (Apps Script), a query parameter only as a last resort. `SPEC.md` added as the technical specification. | Apps Script `doPost` cannot read request headers, so the original wording could not be satisfied in version 0. Swapping to a receiver that can (Make, n8n) would put a third party in the path of health memos, which is not acceptable. |
| 9 | 2026-09-08 | Rule 15 loosened: confident rows (high or medium) create their card, reminder or journal entry on their own and the DM reports it; low asks; nothing is ever deleted or moved by the agent. | One evening of replying "yes" to every card showed the confirmation was pure friction: the DM already states the task and the resolved date, which is all a confirmation would check. Deletes stay gated because a wrong one is harder to notice than a wrong card. |
| 8 | 2026-09-08 | Version 1 built on a branch: three write tools (journal tab, Trello card, scheduled reminder), the confirmation rule, and the reply loop that reads my thread replies. Trello and the sinks list added under rule 8. | The plan said the agent earns write tools by being right for a week, and it has had one day, so this stays on a branch until the week is up. Building it now, while the version 0 decisions are fresh, was cheaper than building it later. Rule 15 turned out to decide the design: with "ask first, always" for anything outside the DM, the reply loop is not an extra, it is how the tools get used. |
| 7 | 2026-09-08 | The timer now fires every 4 minutes and only launches the agent when a cheap check of the Sheet finds a memo waiting. A separate uninstall script removes the timer. | The 15-minute wait was the cost of launching the agent blind on every firing. Checking first costs nothing in tokens, so a memo is now handled within a couple of minutes of landing rather than up to fifteen. |
| 6 | 2026-09-08 | First run of the agent: three DMs from four rows, the fourth a duplicate the agent parked on its own. The phone app turned out to retry every upload because Apps Script answers with a redirect, so the receiver is now idempotent on the app's recording id. The prompt gained a rule for duplicates. A second finding the same day: a slow Apps Script answer made a run report nothing while it had claimed two rows, so claiming is now safe to repeat. | The receiver was written against a guessed body and a guessed failure mode. The real failure was the opposite one: rows land, but many times. Idempotency is the cheap fix; a receiver that returns 200 (the version 2 Lambda) is the real one and moves up. |
| 5 | 2026-09-05 | Version 0 built from `SPEC.md`: the Apps Script receiver and queue API, two narrow local MCP servers for the Sheet and the DM, the agent prompt, the run wrapper and the launchd timer, and the thirteen test cases as something runnable. | The plan was the point up to here; the meetup is today. Three things the spec assumed turned out not to hold on this Mac, and the `SPEC.md` revision log records each one against the section it changed. |
