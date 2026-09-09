#!/usr/bin/env node
// Memo Router — the Trello write tool, as a stdio MCP server. Version 1.
//
// SPEC.md section 6 names trello_create_card as the first write tool outside
// the DM. Trello's own MCP server would hand the agent every board and every
// verb; this one exposes a single tool that creates a card in one list, fixed
// by configuration, and nothing else. A memo cannot name a board or a list,
// and there is no read, move, archive or delete here.
//
// Trello's API token cannot be narrowed to one list on Trello's side, so the
// narrowing is done here, at the tool boundary (rule 5), the same way the
// Slack server fixes its recipient.
//
// What reaches Trello (rule 8, sink added to PLAN.md on 2026-09-08): the task
// as the agent phrased it, an optional description, and a due date. Never a
// health memo: the prompt does not allow the task route for one, and the
// Sheet refuses to journal one; this tool is only reachable from a task.
//
// Rules (CLAUDE.md):
//   1, 2  TRELLO_API_KEY and TRELLO_TOKEN come from the environment or the
//         gitignored dotenv file and are never printed on either stream.
//   11    stderr carries the memo id and the card's short id, never the text.
//
// Also a command-line mode, for setup:
//   node mcp/trello-server.js --lists
// prints the boards and lists the token can see, with their ids, so
// TRELLO_LIST_ID can be chosen. Names only; no secret appears.

'use strict';

const { serve, loadDotenv, makeLogger } = require('./lib/mcp');

loadDotenv(__dirname);

const SERVER_NAME = 'memo-trello';
const SERVER_VERSION = '0.1.0';
const REQUEST_TIMEOUT_MS = 20000;
const API = 'https://api.trello.com/1';
const NAME_LIMIT = 200;
const DESC_LIMIT = 4000;

const KEY = process.env.TRELLO_API_KEY || '';
const TOKEN = process.env.TRELLO_TOKEN || '';
const LIST_ID = process.env.TRELLO_LIST_ID || '';
const log = makeLogger(SERVER_NAME);

function configProblem({ needList = true } = {}) {
  const missing = [];
  if (!KEY) missing.push('TRELLO_API_KEY');
  if (!TOKEN) missing.push('TRELLO_TOKEN');
  if (needList && !LIST_ID) missing.push('TRELLO_LIST_ID');
  if (!missing.length) return null;
  return `Not configured: ${missing.join(', ')} unset. Set it in the project dotenv ` +
         'file (copy the example file at the repository root) and retry.';
}

/* ------------------------------------------------------------ trello calls */

async function trello(method, path, params) {
  const url = new URL(API + path);
  url.searchParams.set('key', KEY);
  url.searchParams.set('token', TOKEN);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method, signal: controller.signal });
  } catch (err) {
    const why = err && err.name === 'AbortError'
      ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
      : 'could not be reached';
    throw new Error(`Trello ${why} (${method} ${path}).`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Trello answers errors with a short plain-text body. It can name the
    // list id, never the key or token, so it is safe to relay.
    const body = (await res.text().catch(() => '')).slice(0, 200);
    const hint = {
      401: 'TRELLO_API_KEY or TRELLO_TOKEN is not valid.',
      404: 'TRELLO_LIST_ID does not name a list this token can see.',
      429: 'Trello is rate limiting this token; the next run will retry the row.',
    }[res.status];
    throw new Error(`Trello refused ${method} ${path}: HTTP ${res.status} ${body}.${hint ? ' ' + hint : ''}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: 'trello_create_card',
    description:
      'Version 1 write tool. Create one Trello card for a task, in the one list fixed ' +
      'by configuration; there is no list or board argument. Use it for a task at high ' +
      'confidence with no date, or for a dated task after Will has confirmed it. Never ' +
      'for a health memo. Call at most once per memo. Returns {id, url, short_url}; ' +
      'put short_url in the row as action_ref.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          description: 'The task as a short imperative line, e.g. "Call the vet".',
        },
        desc: {
          type: 'string',
          description: 'Optional context for the card. Your phrasing, not the transcript.',
        },
        due: {
          type: 'string',
          description: 'Optional due date, YYYY-MM-DD or ISO 8601 with an offset.',
        },
        memo_id: { type: 'string', description: 'The row id this card is for.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

async function call(name, a) {
  if (name !== 'trello_create_card') throw new Error(`Unknown tool: ${name}`);

  const problem = configProblem();
  if (problem) throw new Error(problem);

  const cardName = String(a.name || '').trim().slice(0, NAME_LIMIT);
  if (!cardName) throw new Error('trello_create_card needs a non-empty name.');
  const desc = a.desc ? String(a.desc).slice(0, DESC_LIMIT) : '';

  let due;
  if (a.due) {
    const when = Date.parse(String(a.due));
    if (Number.isNaN(when)) throw new Error('trello_create_card: "due" is not a date.');
    due = new Date(when).toISOString();
  }

  const card = await trello('POST', '/cards', {
    idList: LIST_ID,
    name: cardName,
    desc,
    due,
    pos: 'top',
  });

  log('trello_create_card', { memo_id: a.memo_id || '-', card: card.shortLink, due: due || '-' });
  return { ok: true, id: card.id, url: card.url, short_url: card.shortUrl };
}

/* ------------------------------------------------------------- --lists mode */

async function printLists() {
  const problem = configProblem({ needList: false });
  if (problem) throw new Error(problem);
  const boards = await trello('GET', '/members/me/boards', { fields: 'name', filter: 'open' });
  for (const b of boards) {
    process.stdout.write(`${b.name}\n`);
    const lists = await trello('GET', `/boards/${b.id}/lists`, { fields: 'name', filter: 'open' });
    for (const l of lists) process.stdout.write(`  ${l.id}  ${l.name}\n`);
  }
  process.stdout.write('\nPut the id of the list that should receive task cards in TRELLO_LIST_ID.\n');
}

if (process.argv.includes('--lists')) {
  printLists().then(
    () => process.exit(0),
    (err) => { process.stderr.write(`${err.message}\n`); process.exit(1); },
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
