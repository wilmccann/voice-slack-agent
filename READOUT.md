# From braindump to plan: a first agent, in one page

**Will McCann, Build with Claude meetup, 2026-09-05.** This is the process, not the product. The full plan is in `PLAN.md`; the technical detail is in `SPEC.md`.

## What I set out to plan

An agent that handles my voice memos. I record one on my phone, the app turns it into text, and an agent decides what kind of memo it is and what should happen next, then sends me a Slack message saying what it did. Five kinds: task, journal, health reflection, question, idea. A sixth outcome, "ask me", for anything it cannot place.

## How the plan got made

1. **Braindump, one paragraph.** "When I record a memo, something in the cloud logs a date, a one-line summary, and a type." I was not sure it was worth building.
2. **Claude asked me questions before writing anything.** Four rounds, four questions each, with a recommended answer marked on each. Which idea, how memos are captured, where it should run, where the output should land. Then: how much autonomy, which memo types, how much cloud detail, who the document is for. Answering took minutes. That is the whole discovery step.
3. **The reframe that mattered.** My idea was a pipeline: transcribe, summarize, log. Every memo takes the same path and nothing decides anything. Claude pointed out that adding one decision, "what should happen because of this memo", and giving the agent tools to act on it, is what makes it an agent. The loop is perceive, decide, act, report. Every agent is that loop.
4. **Two facts from research changed the shape.** The phone app has a text mode, so transcription dropped out of the plan entirely. And a Claude Code cloud routine can only use connectors set up on claude.ai and runs at most hourly, so version 0 starts as a scheduled job on my Mac instead.
5. **Four revisions in one day.** Revision 1 was the draft. Revision 2 added a fifth memo type and a summary. Revision 3 was fifteen numbered rules about what the agent must never do with my data, plus tooling that enforces them. Revision 4 fixed a rule that turned out to be impossible to satisfy as written. Almost every revision was about what the agent is allowed to do, not how to build it.

## What the plan says to build

- **Version 0 needs no infrastructure.** Phone app, a twenty-line Google Apps Script webhook that appends a row to a Google Sheet, and a scheduled Claude Code job that reads new rows and DMs me. The Sheet is both the queue and the audit log.
- **Version 0 only proposes.** It has read tools and one write tool, the DM. It earns the right to create tasks by being right for a week.
- **Version 1 adds write tools** with an ask-first rule for anything with a date. **Version 2 moves to a cloud function** so a memo is handled in seconds. The agent logic is the same file the whole way; only where it runs changes.
- **Ten test memos** were written before any code, with the expected route for each. Three more were added later to test what the agent must refuse to do.

## What I would tell a first-timer

- Tell Claude Code your braindump and ask it to interview you before it writes a plan. Pick from its recommendations; disagree where you know better.
- Ask for the plan as a file in a folder, with a revision log at the bottom. Every change gets one row: what changed and why. That log is the story you bring here.
- Add a `CLAUDE.md` to the folder saying what the project is and what the rules are. Every future session reads it first, so you stop repeating yourself.
- Start with a version that creates nothing. Give it read tools, watch its judgment, then let it act.
- Write down what it must never do with your data before you write down how it works. That was the revision I did not expect to need, and it was the most useful one.
