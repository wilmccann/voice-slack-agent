#!/usr/bin/env node
// Memo Router — the Sheet tools, as a stdio MCP server.
//
// Version 0 had three: read_new, history, update_row. Version 1 (2026-09-08)
// adds journal_append, the first write that is not the DM: it files a journal
// entry or an idea to the "journal" tab of the same Sheet through the web
// app's journal action. Health memos are refused on the Google side (rule 10).
//
// SPEC.md 5.2 names these tools and offers two backings: a Google Sheets MCP
// server, or extra Apps Script endpoints called with a fetch tool. There is no
// Sheets MCP server configured on this Mac, and the agent runs with no Bash and
// no file writes, so it has no way to make an HTTP call itself. This server is
// the missing piece: it exposes exactly three tools and calls the Apps Script
// endpoints on the agent's behalf.
//
// Everything stays inside Google and this Mac. No third party sits in the path
// of a health memo, which is the reason SPEC.md 3.2 rejected a Make or n8n
// receiver in the first place.
//
// Rules (CLAUDE.md):
//   1, 2  the web app URL and the shared secret come from the environment or
//         the gitignored dotenv file, and are never printed on either stream.
//   3     the URL is itself a secret, so failures say "the web app".
//   5     three tools, one Sheet, no other reach.
//   11    stderr carries ids, counts and outcomes, never transcript text.
//
// Also a command-line mode, for bin/process-memos.sh:
//   node mcp/sheet-server.js --pending
// prints one JSON line, {"pending": N, "asked_ts": [...]}: how many rows a
// claim would take right now, and the DM timestamps of rows waiting on a
// reply (version 1), so the wrapper can ask Slack about those threads. The
// wrapper cannot ask the web app itself without loading the dotenv file into
// a shell (rule 2), so it asks this process, which already holds the
// credentials and prints nothing but counts and timestamps.

'use strict';

const { serve, loadDotenv, makeLogger } = require('./lib/mcp');

loadDotenv(__dirname);

const SERVER_NAME = 'memo-sheet';
const SERVER_VERSION = '0.1.0';
// Apps Script answers most calls in a few seconds and some in over thirty:
// a cold start plus the lock plus the redirect.  On 2026-09-08 a claim that
// finished on Google's side timed out here at 30s, so the limit is now well
// above anything seen, and the claim below is idempotent for this process.
const REQUEST_TIMEOUT_MS = 120000;

// One run id for the life of this server process.  Every claim sends it, so
// a claim retried after a lost answer gets back the rows the first attempt
// took, instead of finding them "already claimed" by itself.
const RUN_ID = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

const WEBAPP_URL = process.env.MEMO_WEBAPP_URL || '';
const SECRET = process.env.WEBHOOK_SECRET || '';
const log = makeLogger(SERVER_NAME);

function configProblem() {
  const missing = [];
  if (!WEBAPP_URL) missing.push('MEMO_WEBAPP_URL');
  if (!SECRET) missing.push('WEBHOOK_SECRET');
  if (!missing.length) return null;
  return `Not configured: ${missing.join(' and ')} unset. Set it in the project ` +
         'dotenv file (copy the example file at the repository root) and retry.';
}

/* ----------------------------------------------------- the Apps Script hop */

async function callWebApp(action, { query = {}, body = null } = {}) {
  const problem = configProblem();
  if (problem) throw new Error(problem);

  const url = new URL(WEBAPP_URL);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  // GETs have no body to carry the secret, so they use transport B (SPEC.md 3.2).
  if (!body) url.searchParams.set('k', SECRET);

  const init = { method: body ? 'POST' : 'GET', redirect: 'follow' };
  if (body) {
    // Transport A: the secret rides in the body and never reaches a URL.
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify({ ...body, secret: SECRET });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  init.signal = controller.signal;

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const why = err && err.name === 'AbortError'
      ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
      : 'could not be reached';
    throw new Error(`The web app ${why} (action=${action}).`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Apps Script serves an HTML page when the deployment is wrong.
    const hint = /Google Drive|Sorry, unable|authoriz/i.test(text)
      ? ' The deployment is probably not set to "Anyone" access, or it needs ' +
        'redeploying as a new version after the last edit.'
      : '';
    throw new Error(
      `The web app returned HTTP ${res.status} and a non-JSON body (action=${action}).${hint}`,
    );
  }

  if (!data.ok) {
    const reason = data.error === 'unauthorized'
      ? 'the shared secret was rejected; check WEBHOOK_SECRET against the value in Script Properties'
      : String(data.error || 'unknown error');
    throw new Error(`The web app refused action=${action}: ${reason}.`);
  }
  return data;
}

/* ------------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: 'sheet_read_new',
    description:
      'Claim the oldest unprocessed memos from the memo_inbox Sheet and return them. ' +
      'Claiming and reading happen in one locked step, so two overlapping runs can ' +
      'never take the same row; every row that comes back is already status=processing ' +
      'and belongs to this run. Call this once, at the start of a run. Returns ' +
      '{run_id, rows:[{id, received_at, device_ts, transcript, label, attempts}]}. ' +
      'An empty rows array means there is nothing to do: stop the run. If the call ' +
      'fails, call it once more; the rows it claimed the first time come back.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Most rows to claim. The server caps this at 20.',
        },
        run_id: {
          type: 'string',
          description:
            'Identifier for this run, recorded on each row it claims. Leave it out: the ' +
            'server supplies one per run, and a repeated call with the same id returns ' +
            'the rows this run already holds.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sheet_history',
    description:
      'Read recently processed memos. This is for the two decisions that need the ' +
      'past: whether a health memo continues a pattern, and whether a task memo ' +
      'updates an earlier task. Returns one line per memo, oldest first: ' +
      '{id, received_at, route, confidence, action_summary, status}. The memo text is ' +
      'withheld unless include_transcript is set, because action_summary is enough ' +
      'for both decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description:
            'Restrict to one route, or several separated by commas: task, journal, ' +
            'health, question, idea, ask.',
        },
        days: {
          type: 'integer',
          minimum: 1,
          maximum: 365,
          description: 'How far back to look. Defaults to 14.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        include_transcript: {
          type: 'boolean',
          description:
            'Also return the memo text. Leave unset unless action_summary is ' +
            'genuinely not enough to decide.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sheet_update_row',
    description:
      'Record the outcome of one memo and release it. Call exactly once per claimed ' +
      'row, after its DM has been sent, with a terminal status. A row left unwritten ' +
      'is reclaimed by a later run after 30 minutes, which may repeat its DM once.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The row id from sheet_read_new.' },
        status: {
          type: 'string',
          enum: ['done', 'asked', 'error', 'skipped'],
          description:
            'done: handled. asked: a clarifying question went out and a reply is ' +
            'expected. error: something failed; later runs retry it until three ' +
            'attempts, then park it. skipped: never try again.',
        },
        route: {
          type: 'string',
          enum: ['task', 'journal', 'health', 'question', 'idea', 'ask'],
        },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        action_summary: {
          type: 'string',
          description: 'One line: what was proposed, answered or logged.',
        },
        dm_ts: { type: 'string', description: 'Slack timestamp of the DM that was sent.' },
        error: {
          type: 'string',
          description: 'Failure text, when status is error. Never put memo text here.',
        },
        answer_to: {
          type: 'string',
          description: 'Row id this memo resolves, when it answers an earlier asked row.',
        },
        action_ref: {
          type: 'string',
          description:
            'A reference to what was created for this memo: the Trello card URL, the ' +
            'Slack scheduled_message_id, or the journal entry_id. Leave it out when ' +
            'nothing was created. Never memo text.',
        },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'sheet_read_asked',
    description:
      'Version 1. The rows that are waiting on a reply from Will: status asked, each ' +
      'with the dm_ts of the DM that asked, its transcript, and the action_summary ' +
      'that says what was proposed. Call once per run, after the new rows. Then call ' +
      'slack_read_replies with each dm_ts to see whether Will has answered. Nothing ' +
      'is claimed or changed by this call.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 90, description: 'How far back to look. Default 30.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'journal_append',
    description:
      'Version 1 write tool. File a journal entry or an idea to the journal tab of the ' +
      'audit Sheet. Allowed only for route journal (kind "journal") and route idea ' +
      '(kind "idea") at high or medium confidence; the receiver refuses a memo marked ' +
      'health. ' +
      'Pass your one- or two-sentence summary as entry, not the transcript. Call at ' +
      'most once per memo; a repeat returns the entry already made. Returns ' +
      '{entry_id}, which goes into the row as action_ref.',
    inputSchema: {
      type: 'object',
      properties: {
        memo_id: { type: 'string', description: 'The row id from sheet_read_new.' },
        kind: { type: 'string', enum: ['journal', 'idea'] },
        theme: { type: 'string', description: 'One line: the theme, or the idea in a few words.' },
        entry: { type: 'string', minLength: 1, description: 'The summary to file. One or two sentences.' },
      },
      required: ['memo_id', 'kind', 'entry'],
      additionalProperties: false,
    },
  },
];

async function call(name, a) {
  if (name === 'sheet_read_new') {
    const data = await callWebApp('claim', { query: { limit: a.limit, run_id: a.run_id || RUN_ID } });
    log('sheet_read_new', { run_id: data.run_id, rows: (data.rows || []).length });
    return { run_id: data.run_id, rows: data.rows || [] };
  }

  if (name === 'sheet_history') {
    const data = await callWebApp('history', {
      query: {
        route: a.route,
        days: a.days,
        limit: a.limit,
        include_transcript: a.include_transcript ? '1' : '',
      },
    });
    log('sheet_history', {
      route: a.route || 'all',
      days: a.days || 14,
      rows: (data.rows || []).length,
    });
    return { rows: data.rows || [] };
  }

  if (name === 'sheet_update_row') {
    if (!a.id) throw new Error('sheet_update_row needs an id.');
    if (!a.status) throw new Error('sheet_update_row needs a status.');
    const body = { id: a.id, status: a.status };
    for (const f of ['route', 'confidence', 'action_summary', 'dm_ts', 'error', 'answer_to', 'action_ref']) {
      if (a[f] !== undefined && a[f] !== null && a[f] !== '') body[f] = String(a[f]);
    }
    const data = await callWebApp('complete', { body });
    log('sheet_update_row', { id: a.id, status: a.status, route: a.route || '-', ref: a.action_ref ? 'yes' : '-' });
    return { ok: true, id: data.id, status: data.status };
  }

  if (name === 'sheet_read_asked') {
    const data = await callWebApp('asked', { query: { days: a.days } });
    log('sheet_read_asked', { rows: (data.rows || []).length });
    return { rows: data.rows || [] };
  }

  if (name === 'journal_append') {
    if (!a.memo_id) throw new Error('journal_append needs a memo_id.');
    if (!a.entry || !String(a.entry).trim()) throw new Error('journal_append needs an entry.');
    const body = {
      memo_id: String(a.memo_id),
      kind: a.kind || 'journal',
      theme: a.theme ? String(a.theme) : '',
      entry: String(a.entry),
    };
    const data = await callWebApp('journal', { body });
    log('journal_append', { memo_id: a.memo_id, kind: body.kind, entry_id: data.entry_id, duplicate: !!data.duplicate });
    return { ok: true, entry_id: data.entry_id, duplicate: !!data.duplicate };
  }

  throw new Error(`Unknown tool: ${name}`);
}

/* ---------------------------------------------------------- --pending mode */

async function printPending() {
  const data = await callWebApp('ping');
  let pending = data.pending;
  if (typeof pending !== 'number') {
    // A deployment from before ping reported it: count what claim might take,
    // erring towards a run. A processing row that is not yet stale costs one
    // agent launch that finds nothing, which is the price of the older script.
    const s = data.status || {};
    pending = (s.new || 0) + (s.error || 0) + (s.processing || 0);
  }
  const askedTs = Array.isArray(data.asked_ts) ? data.asked_ts.map(String) : [];
  // asked: [{id, ts}] from a v1b deployment; built from asked_ts (no ids) for
  // an older one. The wrapper hands these to the Slack server as id:ts.
  const asked = Array.isArray(data.asked)
    ? data.asked.map((a) => ({ id: String(a.id), ts: String(a.ts) }))
    : askedTs.map((ts) => ({ ts }));
  // deployed: the SCRIPT_VERSION the live web app reports, or "pre-v1" for a
  // deployment older than the field. The wrapper ignores it; a person does not.
  const deployed = typeof data.version === 'string' ? data.version : 'pre-v1';
  process.stdout.write(JSON.stringify({ pending, asked, asked_ts: askedTs, deployed }) + '\n');
}

if (process.argv.includes('--pending')) {
  printPending().then(
    () => process.exit(0),
    (err) => {
      // Rule 3: the message names "the web app", never the URL.
      process.stderr.write(`pending check failed: ${err.message}\n`);
      process.exit(1);
    },
  );
} else {
  serve({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools: TOOLS,
    call,
    ready: () => {
      const problem = configProblem();
      return problem ? { configured: false, problem } : { configured: true };
    },
  });
}
