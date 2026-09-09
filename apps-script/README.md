# Deploying the receiver

`Code.gs` is the whole of steps 2 and 3 of the `SPEC.md` build order: the webhook the
phone app posts to, and the queue API the agent reads and writes. It is one Apps
Script project bound to one Google Sheet.

There is no build step and no `clasp` requirement. Copying two files into the editor
is the fastest path, and it is what these steps describe.

## 1. Make the Sheet and the script

1. Create a Google Sheet. Name it something you will recognise; the tab inside it must
   end up called `memo_inbox`, which step 3 does for you.
2. In that Sheet, choose **Extensions -> Apps Script**. This creates a script *bound*
   to the Sheet, which is what lets the narrow `spreadsheets.currentonly` scope in
   `appsscript.json` work. A standalone script would need access to all your
   spreadsheets, which rule 5 rules out.
3. Paste the contents of `Code.gs` over whatever is in `Code.gs` in the editor.
4. Turn on **Project Settings -> Show "appsscript.json" manifest file**, then paste the
   contents of `appsscript.json` over the manifest. Change `timeZone` if
   `America/New_York` is not yours; it decides how the Apps Script side reads dates.

## 2. Set the shared secret

Generate one:

```bash
openssl rand -hex 32
```

Put it in two places and nowhere else:

- **Apps Script:** Project Settings -> Script Properties -> Add script property.
  Name `WEBHOOK_SECRET`, value the string you generated. Rule 1: it never goes in
  `Code.gs`.
- **This checkout:** the `WEBHOOK_SECRET` line of your gitignored `.env` file. Copy
  `.env.example` to get the shape.

The script refuses every request until this property exists, including the ping. That
is deliberate: an unconfigured deployment is not an open one.

## 3. Create the sheet tab

In the Apps Script editor, select `setupSheet` from the function dropdown and press
**Run**. Approve the authorisation prompt. It creates the `memo_inbox` tab with the 19
columns in `SPEC.md` 3.3 and freezes the header, and, since version 1, the `journal`
tab beside it.

Run it again after any update that adds a column. On a sheet that already has data
it appends only the columns that are missing, at the end, and leaves every row alone.
It also sets the plain-text format on the `id`, `dm_ts`, `source_id` and `action_ref`
columns, so a Slack timestamp is never rounded: a number cell keeps 15 significant
digits and a Slack timestamp has 16.
The `source_id` column added on 2026-09-08 arrives this way; until it exists the
receiver appends every upload as before. The same run fills `source_id` on rows written
before the column existed, from the `recording_id` kept in their `raw_json`, so the
app's retries of those older recordings are recognised too.

Look at the Sheet: you should see the header row. Nothing else runs until you deploy.

## 4. Deploy the web app

**Deploy -> New deployment -> Web app.**

| Field | Value | Why |
| --- | --- | --- |
| Execute as | Me | The script needs your access to the Sheet. |
| Who has access | Anyone | The phone app cannot sign in to Google. The shared secret is what protects it, not this setting. |

Copy the `/exec` URL into `MEMO_WEBAPP_URL` in your `.env` file. Treat it as a secret
(rule 3): anyone holding it can attempt to write memos as you, and only the shared
secret stops them.

**Every time you edit `Code.gs`, deploy again** as **Manage deployments -> Edit -> New
version**. Editing the code alone changes nothing that is live, and the URL stays the
same when you version an existing deployment. If the update added a column, run
`setupSheet` again as well (step 3).

## 5. Check it

```bash
bash test/check-receiver.sh
```

That covers case 13 of the `SPEC.md` section 7 test set: a POST with no secret is
refused and appends no row. It prints neither the URL nor the secret. Add `--full` to
post one synthetic memo and walk it through claim and complete; that leaves one row in
the Sheet, which you can delete by hand.

## 6. Point the phone app at it

In the Webhook Voice Automation app, set the URL to your `/exec` URL and the method to
POST, with text mode on so the transcript is produced on the device. Settings that
worked on 2026-09-06:

| Setting | Value |
| --- | --- |
| Method | POST |
| Text field name | `text` |
| Additional Form Field | name `secret`, value your shared secret (transport A) |
| Custom headers | none; Apps Script cannot read them |
| Allow self-signed certificates | off |
| Max retries | 0 (see below; the app retries anyway) |

Two things `SPEC.md` 3.1 used to leave open are now known:

- **The body.** JSON with the transcript under `text`, plus `recording_id`,
  `upload_attempt_id`, `created_at`, `entry_type`, `webhook_id`, `webhook_name`,
  `text_length`, `file_size_bytes` and `duration_ms`. `recording_id` is stable for
  one memo across retries; `upload_attempt_id` changes each time. The receiver keys
  duplicates on `recording_id`.
- **The redirect.** Apps Script answers every POST with a 302. The row is written
  before the redirect, but the app reads the 302 as a failure, keeps the recording in
  its retry queue, and re-sends it every couple of minutes regardless of the retry
  setting. Before the receiver deduplicated, three memos became about twenty rows.
  Now each retry is answered from the existing row, but the app keeps trying until
  you delete the recording from its queue. The lasting fix is a receiver that
  returns 200, which is `SPEC.md` 4.3.

`receiver/capture.js` remains useful for a different client: run it on your Mac, point
the app at your LAN address, and read `capture.log`. It records the shape of the body,
not the text.

## What each action does

| Request | Does |
| --- | --- |
| `POST` with a transcript | Appends a row with `status=new`. Returns `{ok, id}`. A repeat of a `recording_id` already in the Sheet appends nothing and returns `{ok, id, duplicate: true}` with the existing row's id. |
| `GET ?action=claim` | Returns the oldest unhandled rows and marks them `processing` in the same locked step. A repeat with the same `run_id` returns the rows that run already holds, so a lost answer can be retried. Also returns stale claims to `new` and parks rows that have failed three times. |
| `GET ?action=history` | Recent processed rows, for health patterns and task updates. Returns `action_summary`, not the transcript, unless asked. |
| `POST ?action=complete` | Writes the outcome of one row, including `action_ref` (version 1). |
| `POST ?action=journal` | Version 1. Appends a journal entry or a filed idea to the `journal` tab. One per memo; a repeat returns the existing entry. Refuses a memo whose row is marked `health` (rule 10). |
| `GET ?action=asked` | Version 1. Rows waiting on a reply from Will, each with the `dm_ts` its thread hangs off. Changes nothing. |
| `GET ?action=ping` | Row counts by status, `pending` (the number a claim would take now) and `asked_ts` (the DM timestamps of rows waiting on a reply). No memo content. The run wrapper polls this every few minutes. |

The agent never calls these directly. `mcp/sheet-server.js` wraps them as the tools
`SPEC.md` 5.2 and section 6 name.

## Retention

`purgeOldRows()` is written but not scheduled, because the retention period is still
open (`SPEC.md` section 9, rule 12). It defaults to 180 days, and 90 for health rows.
When you have decided, set `RETENTION_DAYS` and `HEALTH_RETENTION_DAYS` in Script
Properties and add a daily time-driven trigger for it under **Triggers**.
