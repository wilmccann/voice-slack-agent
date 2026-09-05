# voice-slack-agent

A personal agent that routes voice memos. Will records a memo on his phone with the Webhook Voice Automation app in text mode; the transcript is POSTed to a webhook; an agent decides which of five kinds of memo it is (task, journal, mindfulness or health, question, idea), acts, and sends a Slack DM.

- `PLAN.md` is the source of truth. It doubles as the handout for the Build with Claude meetup on 2026-09-05. Keep the revision log at the bottom current on every meaningful edit.
- Nothing is built yet. Version 0 in the plan is propose-only: no write tools except the Slack DM.
- Health memos are private. They never leave the DM and the audit Sheet, in any version.
- All artifacts for this work live in this folder.
