# Memo Router

Will records a voice memo to himself. His phone turns it into text and posts it to a
Google Sheet. Every fifteen minutes an agent takes whatever is new, decides what kind
of memo each one is and what should happen because of it, and sends one Slack DM per
memo saying what it did.

This is **version 0**, and version 0 creates nothing. It proposes, answers, logs and
asks. The only thing it changes outside its own audit Sheet is the DM. It earns write
tools by being right for a week.

- `PLAN.md` — why this shape, and the meetup handout. The source of truth.
- `SPEC.md` — how it works. Schemas, contracts, and the reasoning behind each hop.
- `CLAUDE.md` — the fifteen rules about data and secrets, cited by number everywhere.

## What is in here

| Path | What it is |
| --- | --- |
| `apps-script/Code.gs` | The webhook and the queue API. One Apps Script project bound to the Sheet. |
| `mcp/sheet-server.js` | The Sheet tools, as an MCP server the agent can call. Version 1 adds the journal write and the asked-rows read. |
| `mcp/slack-server.js` | A DM to one person, enforced at the tool boundary. Version 1 adds scheduled reminders into, and reading replies from, that same DM. |
| `prompts/process-new-memos.md` | **The agent.** Routing rules, run procedure, DM format, and the list of things it must never do. |
| `bin/process-memos.sh` | One run: take the lock, run the agent with exactly five tools, write one log line. |
| `bin/uninstall-launchagent.sh` | Remove the timer. The Sheet, the deployment and the logs are left alone. |
| `mcp/trello-server.js` | Version 1. One tool: create a card in one configured list. `--lists` prints your boards and lists so you can pick it. |
| `bin/install-launchagent.sh` | Installs the fifteen-minute timer. |
| `bin/check.sh` | Runs everything that can be checked without deploying. |
| `fixtures/test-set.json` | The twelve routing cases from `SPEC.md` section 7, synthetic. Case 13 tests the receiver instead. |
| `test/run-fixtures.mjs` | Checks the routing without touching the Sheet, Slack or the web. |
| `test/receiver-logic.test.mjs` | Runs `Code.gs` offline against a mock Sheet: field mapping and status machine. |
| `test/check-receiver.sh` | Checks the deployed receiver, including that an unsigned POST is dropped. |
| `receiver/capture.js` | A local tool for capturing one real POST from the phone app. |

## Setting it up

Roughly an hour, most of it in the Google and Slack consoles.

**1. Configure.** Copy `.env.example` to `.env` and fill in four values. That file is
gitignored and stays that way.

**2. Deploy the receiver.** Follow [`apps-script/README.md`](apps-script/README.md).
It ends with a check you can run.

```bash
bash test/check-receiver.sh
```

**3. Make the Slack app.** Create an app at api.slack.com, give it exactly the
`chat:write` and `im:write` bot scopes, install it to your workspace, and put the
`xoxb-` token and your own member id in `.env`. Two scopes is the whole point: the
agent cannot post anywhere but your DM even if something convinces it to try.

**4. Check it.** Neither suite needs anything deployed, so this works before steps 2
and 3 as well as after.

```bash
bin/check.sh --runs 2
```

The first suite runs the real `Code.gs` against a Sheet made of arrays and checks the
field mapping and the status machine, including that an unsigned POST appends nothing.
The second runs the real prompt against the twelve fixture memos with every tool
switched off and checks each routing decision. Two clean routing passes is the
acceptance bar in `SPEC.md` section 7. `bin/check.sh --fast` skips the second, which
is the half that calls the model and costs something.

**5. Run it by hand until you trust it.**

```bash
bin/process-memos.sh --verbose
```

**6. Start the timer.**

```bash
bin/install-launchagent.sh
```

It fires every 4 minutes (`--interval 60` for once a minute). Each firing asks the
Sheet, through the sheet server, whether any row is waiting, and only then launches
the agent, so an idle firing costs one small request and no tokens.
`bin/install-launchagent.sh --status` says whether it is loaded and shows the last few
runs. `bin/uninstall-launchagent.sh` stops it and touches nothing else.
`bin/process-memos.sh --force` runs the agent without the check.

**7. Version 1: let it write (optional, `add-write-tools` branch).**

Three write tools. At high or medium confidence the agent creates the thing and the
DM says exactly what it made; at low confidence it asks and creates nothing. It never
archives, deletes or moves anything (`CLAUDE.md` rule 15, as amended 2026-09-08).
Journal entries and ideas file into a `journal` tab of the audit Sheet the same way.
To turn the rest on:

- **Slack:** add the `im:history` scope to the Memo Router app and reinstall it, so
  the agent can read your replies in the DM thread. That is the only new scope.
  Then, under **App Home**, turn on the **Messages Tab** and tick "Allow users to
  send Slash commands and messages from the messages tab"; without it Slack shows
  "Sending messages to this app has been turned off" and you cannot reply. No
  reinstall is needed for that one. Reminders need nothing new: they are messages
  scheduled into the same DM.
- **Trello:** create a Power-Up at https://trello.com/power-ups/admin, generate a
  token from its API key page, and put both in the dotenv file. Then find the list
  that should receive task cards:

  ```bash
  node mcp/trello-server.js --lists
  ```

  and put its id in `TRELLO_LIST_ID`. The token can write to every board you can;
  the narrowing to one list is done in `mcp/trello-server.js` (rule 5).
- **Apps Script:** paste the new `Code.gs`, run `setupSheet` again (it adds the
  `action_ref` column and the `journal` tab), and deploy a new version.

Until the Trello values are set, a task's DM says the card could not be created yet,
and the row is marked done.

## Watching it

`logs/runs.log` gets one line per agent run (an empty poll writes nothing): a timestamp, a run id, an exit code, a
duration, how many memos were done, asked about, errored or skipped, and what the run would
have cost at API rates (`cost_usd`, for deciding whether the agent can move off the
subscription). No memo text, ever
(rule 11). The Sheet is where the memos and the outcomes live.

```bash
tail -f logs/runs.log
```

## What it is allowed to do

Five tools, and that is the entire surface:

| Tool | Reads or writes |
| --- | --- |
| `sheet_read_new` | Takes the unhandled memos. |
| `sheet_history` | Recent memos, for health patterns and task updates. |
| `sheet_update_row` | Records the outcome of one memo. |
| `slack_dm` | Sends Will one DM. The only write. |
| `WebSearch` | Answers a question memo, with the question only. |

No shell, no file access, no other Slack destination, and no other MCP server on the
machine. Three flags in `bin/process-memos.sh` do that, and all three are needed:
`--strict-mcp-config` loads only the two servers in `.mcp.json`, `--allowedTools`
lets the five run without asking, and `--disallowedTools` takes the built-ins away
entirely. The allowlist alone governs approval, not availability, so without the last
one the agent would still be offered Bash and Write. Asking the agent to list its
tools returns those five and nothing else.

The narrowing is deliberate and it is structural, not advisory. `slack_dm` takes no
channel argument, so the destination is not something a memo can talk the agent into
changing. A memo that reads like an instruction is routed to "ask me" and quoted back
unchanged rather than obeyed. Health memos never leave the DM and the Sheet.

## What is not built

- **A receiver that can answer 200.** The phone app treats the 302 Apps Script sends
  on every POST as a failure and retries the upload every few minutes, even with
  retries set to zero. Since 2026-09-08 the receiver is idempotent on the app's
  `recording_id`, so the retries land on the row that already exists, but the app
  keeps re-sending until its queue is cleared by hand. Only a receiver that returns
  a real 200 stops that, which brings `SPEC.md` 4.3 (the Lambda) forward.
- **The retention period.** `purgeOldRows()` is written and not scheduled
  (`SPEC.md` section 9, rule 12).
- **Trello and calendar reads.** Optional in version 0. The prompt uses them only if
  they are present.
- **Version 1, on `main`.** The write tools and the reply loop are built on the
  `add-write-tools` branch (step 7 above, `SPEC.md` section 6) and wait for a week of
  version 0 being right before they merge.
- **Version 2:** the move to a Lambda. `SPEC.md` section 4.3.
