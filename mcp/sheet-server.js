#!/usr/bin/env node
// Memo Router — the three Sheet tools, as a stdio MCP server.
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
      },
      required: ['id', 'status'],
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
    for (const f of ['route', 'confidence', 'action_summary', 'dm_ts', 'error', 'answer_to']) {
      if (a[f] !== undefined && a[f] !== null && a[f] !== '') body[f] = String(a[f]);
    }
    const data = await callWebApp('complete', { body });
    log('sheet_update_row', { id: a.id, status: a.status, route: a.route || '-' });
    return { ok: true, id: data.id, status: data.status };
  }

  throw new Error(`Unknown tool: ${name}`);
}

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
