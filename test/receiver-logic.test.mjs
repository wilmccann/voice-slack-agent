#!/usr/bin/env node
// Offline tests for apps-script/Code.gs.
//
// The receiver cannot be exercised without deploying it to Google, and the part
// most likely to be wrong is the part hardest to see there: the field mapping
// for a body shape nobody has captured yet, and the status machine in SPEC.md
// 3.3. Both are pure logic. This file runs the real Code.gs in a sandbox with
// the Apps Script globals stubbed and a Sheet made of arrays, so the logic is
// checked on every change instead of on the next deployment.
//
// It proves nothing about Google's own behaviour: not the 302 on POST, not the
// authorisation scopes, not LockService. test/check-receiver.sh covers what
// only a real deployment can show.
//
// Usage: node test/receiver-logic.test.mjs

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'test-secret-value';

/* ---------------------------------------------------------- a Sheet of arrays */

function makeSheet(header, rows = []) {
  const grid = [header.slice(), ...rows.map((r) => r.slice())];
  const formats = {};
  const api = {
    getLastRow: () => grid.length,
    getLastColumn: () => (grid[0] ? grid[0].length : 0),
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
        getValues: () =>
          Array.from({ length: numRows }, (_, r) =>
            Array.from({ length: numCols }, (_, c) => {
              const line = grid[row - 1 + r];
              const v = line ? line[col - 1 + c] : '';
              return v === undefined ? '' : v;
            }),
          ),
        setValues(values) {
          values.forEach((line, r) => {
            const target = row - 1 + r;
            if (!grid[target]) grid[target] = [];
            line.forEach((v, c) => { grid[target][col - 1 + c] = v; });
          });
          return this;
        },
        setFontWeight() { return this; },
        setNumberFormat(fmt) {
          for (let r = 0; r < numRows; r++) for (let c = 0; c < numCols; c++) {
            formats[`${row + r},${col + c}`] = fmt;
          }
          return this;
        },
      };
    },
    getMaxRows: () => Math.max(grid.length, 1000),
    _format: (row, col) => formats[`${row},${col}`],
    appendRow(line) { grid.push(line.slice()); },
    deleteRow(n) { grid.splice(n - 1, 1); },
    setFrozenRows() {},
    autoResizeColumns() {},
    _grid: grid,
    _rows: () => grid.slice(1).map((line) =>
      Object.fromEntries(grid[0].map((h, i) => [h, line[i]]))),
  };
  return api;
}

/* --------------------------------------------------- the Apps Script globals */

function loadScript({ properties = { WEBHOOK_SECRET: SECRET }, sheet, sheets = {} } = {}) {
  const logs = [];
  // A spreadsheet is a map of tabs by name. `sheet` is the memo_inbox tab.
  const tabs = { memo_inbox: sheet, ...sheets };
  const spreadsheet = {
    getSheetByName: (name) => tabs[name] || null,
    insertSheet: (name) => { tabs[name] = makeSheet([]); return tabs[name]; },
  };
  const sandbox = {
    console: {
      log: (...a) => logs.push(a.join(' ')),
      info: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' ')),
      error: (...a) => logs.push(a.join(' ')),
    },
    Utilities: {
      getUuid: () => `uuid-${Math.random().toString(16).slice(2, 10)}`,
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (_alg, value) => Array.from(createHash('sha256').update(String(value), 'utf8').digest()),
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => (k in properties ? properties[k] : null) }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      openById: () => spreadsheet,
      flush: () => {},
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }),
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (text) => ({ _text: text, setMimeType() { return this; } }),
    },
    Date,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    isNaN,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, 'apps-script/Code.gs'), 'utf8'), sandbox);
  return { sandbox, logs, tabs };
}

const parse = (response) => JSON.parse(response._text);

const postEvent = (body, contentType = 'application/json', parameter = {}) => ({
  parameter,
  postData: { contents: typeof body === 'string' ? body : JSON.stringify(body), type: contentType },
});
const getEvent = (parameter) => ({ parameter });

/* --------------------------------------------------------------- the runner */

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`\x1b[32mpass\x1b[0m  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`\x1b[31mFAIL\x1b[0m  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function eq(actual, expected, what) {
  if (String(actual) !== String(expected)) {
    throw new Error(`${what || 'value'}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}
function ok(cond, what) {
  if (!cond) throw new Error(what || 'expected true');
}

const HEADER = [
  'id', 'received_at', 'device_ts', 'transcript', 'label', 'raw_json', 'status',
  'run_id', 'claimed_at', 'attempts', 'route', 'confidence', 'action_summary',
  'dm_ts', 'processed_at', 'error', 'answer_to', 'source_id', 'action_ref',
];
// The header a sheet set up before 2026-09-08 has: no source_id or action_ref.
const OLD_HEADER = HEADER.slice(0, -2);

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

/* ------------------------------------------------------------------ rule 4 */

test('a POST with no secret appends nothing and answers ok:false (spec case 13)', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox } = loadScript({ sheet });
  const res = parse(sandbox.doPost(postEvent({ transcript: 'synthetic memo' })));
  eq(res.ok, false, 'ok');
  eq(res.error, 'unauthorized', 'error');
  eq(sheet._rows().length, 0, 'rows appended');
});

test('a POST with the wrong secret is refused too', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox } = loadScript({ sheet });
  const res = parse(sandbox.doPost(postEvent({ transcript: 'synthetic memo', secret: 'wrong' })));
  eq(res.ok, false, 'ok');
  eq(sheet._rows().length, 0, 'rows appended');
});

test('a secret of the right length but wrong value is refused', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox } = loadScript({ sheet });
  const nearly = SECRET.slice(0, -1) + 'X';
  const res = parse(sandbox.doPost(postEvent({ transcript: 'synthetic memo', secret: nearly })));
  eq(res.ok, false, 'ok');
});

test('every request is refused when WEBHOOK_SECRET is not configured', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox } = loadScript({ sheet, properties: {} });
  eq(parse(sandbox.doPost(postEvent({ transcript: 'x', secret: SECRET }))).ok, false, 'memo');
  eq(parse(sandbox.doGet(getEvent({ action: 'ping', k: SECRET }))).ok, false, 'ping');
});

test('a refused request logs a reason and nothing from the body (rules 4 and 11)', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox, logs } = loadScript({ sheet });
  sandbox.doPost(postEvent({ transcript: 'a distinctive synthetic phrase', secret: 'wrong' }));
  const joined = logs.join('\n');
  ok(/rejected/.test(joined), 'a rejection was logged');
  ok(!/distinctive synthetic phrase/.test(joined), 'the body must not be logged');
});

/* ---------------------------------------------------- 3.1, the field mapping */

test('the transcript is found under any of the six candidate keys', () => {
  for (const key of ['transcript', 'transcription', 'text', 'message', 'content', 'body']) {
    const sheet = makeSheet(HEADER);
    const { sandbox } = loadScript({ sheet });
    const res = parse(sandbox.doPost(postEvent({ [key]: `memo via ${key}`, secret: SECRET })));
    eq(res.ok, true, `ok for key ${key}`);
    eq(sheet._rows()[0].transcript, `memo via ${key}`, `transcript for key ${key}`);
  }
});

test('a form-encoded body maps the same way', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox } = loadScript({ sheet });
  const e = {
    parameter: { text: 'form encoded memo', secret: SECRET },
    postData: { contents: 'text=form+encoded+memo&secret=x', type: 'application/x-www-form-urlencoded' },
  };
  eq(parse(sandbox.doPost(e)).ok, true, 'ok');
  eq(sheet._rows()[0].transcript, 'form encoded memo', 'transcript');
});

test('a text/plain body is the transcript, with the secret on the query string', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox } = loadScript({ sheet });
  const e = {
    parameter: { k: SECRET },
    postData: { contents: 'the whole body is the memo', type: 'text/plain' },
  };
  eq(parse(sandbox.doPost(e)).ok, true, 'ok');
  eq(sheet._rows()[0].transcript, 'the whole body is the memo', 'transcript');
});

test('device_ts and label are picked up, and unknown fields are kept in raw_json', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox } = loadScript({ sheet });
  sandbox.doPost(postEvent({
    transcript: 'synthetic memo',
    recorded_at: '2026-09-05T10:00:00.000Z',
    filename: 'memo-004',
    battery: 72,
    secret: SECRET,
  }));
  const row = sheet._rows()[0];
  eq(row.device_ts, '2026-09-05T10:00:00.000Z', 'device_ts');
  eq(row.label, 'memo-004', 'label');
  eq(JSON.parse(row.raw_json).battery, 72, 'unknown field survives in raw_json');
});

test('the secret is stripped before the row is written (rule 4)', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox } = loadScript({ sheet });
  sandbox.doPost(postEvent({ transcript: 'synthetic memo', secret: SECRET, token: 'also-secret' }));
  const raw = sheet._rows()[0].raw_json;
  ok(!raw.includes(SECRET), 'the secret must not reach the Sheet');
  ok(!raw.includes('also-secret'), 'nothing secret-shaped reaches the Sheet');
});

test('a body with no recognisable transcript is refused, not stored empty', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox } = loadScript({ sheet });
  const res = parse(sandbox.doPost(postEvent({ audio_url: 'https://example.invalid/a.m4a', secret: SECRET })));
  eq(res.ok, false, 'ok');
  eq(sheet._rows().length, 0, 'rows appended');
});

/* ------------------------------------ 3.1, the real app, and idempotency */

// The shape the Webhook Voice Automation app was seen to send on 2026-09-06.
// Field names are real; every value is synthetic.
const appBody = (over = {}) => ({
  text: 'synthetic memo from the app',
  recording_id: 'rec-0001',
  upload_attempt_id: 'att-0001',
  created_at: '2026-09-06T14:00:00.000Z',
  entry_type: 'text',
  webhook_id: 'wh-1',
  webhook_name: 'Memo Router',
  text_length: 27,
  file_size_bytes: 0,
  duration_ms: 4200,
  secret: SECRET,
  ...over,
});

test('the real app body maps text, created_at and recording_id', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox } = loadScript({ sheet });
  const res = parse(sandbox.doPost(postEvent(appBody())));
  eq(res.ok, true, 'ok');
  const row = sheet._rows()[0];
  eq(row.transcript, 'synthetic memo from the app', 'transcript');
  eq(row.device_ts, '2026-09-06T14:00:00.000Z', 'device_ts');
  eq(row.source_id, 'rec-0001', 'source_id');
  ok(!JSON.parse(row.raw_json).secret, 'secret stripped');
});

test('a retried upload of the same recording appends nothing and returns the first id', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox, logs } = loadScript({ sheet });
  const first = parse(sandbox.doPost(postEvent(appBody())));
  const again = parse(sandbox.doPost(postEvent(appBody({ upload_attempt_id: 'att-0002' }))));
  const third = parse(sandbox.doPost(postEvent(appBody({ upload_attempt_id: 'att-0003' }))));
  eq(sheet._rows().length, 1, 'rows appended');
  eq(again.ok, true, 'the retry is told ok, so the app stops retrying');
  eq(again.duplicate, true, 'and told it was a duplicate');
  eq(again.id, first.id, 'with the id of the row it already has');
  eq(third.id, first.id, 'every later retry too');
  ok(!logs.join('\n').includes('synthetic memo'), 'no memo text in the logs');
});

test('two different recordings are two rows, even with the same words', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox } = loadScript({ sheet });
  sandbox.doPost(postEvent(appBody({ recording_id: 'rec-0001' })));
  sandbox.doPost(postEvent(appBody({ recording_id: 'rec-0002' })));
  eq(sheet._rows().length, 2, 'rows appended');
});

test('a client with no id is deduped on a fingerprint of time and text', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox } = loadScript({ sheet });
  const body = { transcript: 'synthetic memo', recorded_at: '2026-09-06T14:00:00.000Z', secret: SECRET };
  const a = parse(sandbox.doPost(postEvent(body)));
  const b = parse(sandbox.doPost(postEvent(body)));
  eq(sheet._rows().length, 1, 'identical upload collapses');
  eq(b.id, a.id, 'same id back');
  ok(/^sha256:[0-9a-f]{64}$/.test(sheet._rows()[0].source_id), 'source_id is a digest, not the text');

  sandbox.doPost(postEvent({ ...body, recorded_at: '2026-09-06T14:05:00.000Z' }));
  sandbox.doPost(postEvent({ ...body, transcript: 'a different synthetic memo' }));
  eq(sheet._rows().length, 3, 'a different time or different words is a new row');
});

test('a sheet without the source_id column still appends, so an old deployment keeps working', () => {
  const sheet = makeSheet(OLD_HEADER);
  const { sandbox } = loadScript({ sheet });
  sandbox.doPost(postEvent(appBody()));
  sandbox.doPost(postEvent(appBody({ upload_attempt_id: 'att-0002' })));
  eq(sheet._rows().length, 2, 'no dedupe without the column, and no crash');
  eq(sheet._rows()[0].source_id, undefined, 'nothing written where there is no column');
});

test('setupSheet adds the missing column to an existing sheet without touching its rows', () => {
  const sheet = makeSheet(OLD_HEADER, [
    OLD_HEADER.map((h) => (h === 'id' ? 'keep-me' : h === 'transcript' ? 'existing memo' : h === 'status' ? 'done' : '')),
  ]);
  const { sandbox, logs } = loadScript({ sheet });
  sandbox.setupSheet();
  eq(sheet._grid[0].length, HEADER.length, 'two columns added');
  eq(sheet._grid[0][HEADER.length - 2], 'source_id', 'source_id first');
  eq(sheet._grid[0][HEADER.length - 1], 'action_ref', 'action_ref last');
  eq(sheet._rows()[0].id, 'keep-me', 'existing row intact');
  eq(sheet._rows()[0].transcript, 'existing memo', 'existing data aligned');
  ok(logs.join('\n').includes('added source_id'), 'says what it added');

  sandbox.setupSheet();
  eq(sheet._grid[0].length, HEADER.length, 'a second run adds nothing');

  const fresh = makeSheet([]);
  loadScript({ sheet: fresh }).sandbox.setupSheet();
  eq(fresh._grid[0].length, HEADER.length, 'a fresh sheet gets the full header');
});

test('setupSheet backfills source_id from raw_json, so retries of old rows match', () => {
  // Two rows written before the column existed: one from the app, one with no id.
  const sheet = makeSheet(OLD_HEADER, [
    OLD_HEADER.map((h) => ({ id: 'old-1', transcript: 'x', status: 'done',
      raw_json: JSON.stringify({ text: 'x', recording_id: 'rec-old', upload_attempt_id: 'att-9' }) }[h] || '')),
    OLD_HEADER.map((h) => ({ id: 'old-2', transcript: 'y', status: 'done', raw_json: '{"text":"y"}' }[h] || '')),
  ]);
  const { sandbox } = loadScript({ sheet });
  sandbox.setupSheet();
  eq(sheet._rows()[0].source_id, 'rec-old', 'filled from raw_json');
  ok(!sheet._rows()[1].source_id, 'left blank when raw_json has no id');

  const res = parse(sandbox.doPost(postEvent(appBody({ recording_id: 'rec-old', upload_attempt_id: 'att-10' }))));
  eq(res.duplicate, true, 'a retry of the old recording is recognised');
  eq(res.id, 'old-1', 'and answered with the old row');
  eq(sheet._rows().length, 2, 'no row appended');
});

test('a new row starts at status=new with zero attempts', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox } = loadScript({ sheet });
  sandbox.doPost(postEvent({ transcript: 'synthetic memo', secret: SECRET }));
  const row = sheet._rows()[0];
  eq(row.status, 'new', 'status');
  eq(row.attempts, 0, 'attempts');
  ok(row.id && row.received_at, 'id and received_at are set');
});

/* ------------------------------------------------- 3.3, the status machine */

function sheetWithRows(rows) {
  return makeSheet(HEADER, rows.map((r) => HEADER.map((h) => (r[h] === undefined ? '' : r[h]))));
}

test('claim returns new rows oldest first and marks them processing', () => {
  const sheet = sheetWithRows([
    { id: 'a', received_at: iso(3000), transcript: 'first', status: 'new', attempts: 0 },
    { id: 'b', received_at: iso(2000), transcript: 'second', status: 'new', attempts: 0 },
  ]);
  const { sandbox } = loadScript({ sheet });
  const res = parse(sandbox.doGet(getEvent({ action: 'claim', k: SECRET, run_id: 'run-1' })));
  eq(res.ok, true, 'ok');
  eq(res.rows.length, 2, 'rows returned');
  eq(res.rows[0].id, 'a', 'oldest first');
  eq(sheet._rows()[0].status, 'processing', 'status');
  eq(sheet._rows()[0].run_id, 'run-1', 'run_id');
  eq(sheet._rows()[0].attempts, 1, 'attempts incremented');
});

test('a repeated claim by the same run gets its own rows back, without a new attempt', () => {
  const sheet = sheetWithRows([
    { id: 'a', received_at: iso(3000), transcript: 'x', status: 'new', attempts: 0 },
    { id: 'b', received_at: iso(2000), transcript: 'y', status: 'new', attempts: 0 },
  ]);
  const { sandbox } = loadScript({ sheet });
  const first = parse(sandbox.doGet(getEvent({ action: 'claim', k: SECRET, run_id: 'run-1' })));
  eq(first.rows.length, 2, 'first claim takes both');
  // The answer above is lost in transit; the same run asks again.
  const again = parse(sandbox.doGet(getEvent({ action: 'claim', k: SECRET, run_id: 'run-1' })));
  eq(again.rows.length, 2, 'the repeat returns the same rows');
  eq(again.rows.map((r) => r.id).join(','), 'a,b', 'same rows, same order');
  eq(sheet._rows()[0].attempts, 1, 'attempts not incremented by the repeat');
  eq(sheet._rows()[0].status, 'processing', 'still processing');
  // A different run still gets nothing.
  eq(parse(sandbox.doGet(getEvent({ action: 'claim', k: SECRET, run_id: 'run-2' }))).rows.length, 0, 'other run gets nothing');
});

test('claim never returns a row twice, so two overlapping runs cannot collide', () => {
  const sheet = sheetWithRows([{ id: 'a', received_at: iso(1000), transcript: 'x', status: 'new', attempts: 0 }]);
  const { sandbox } = loadScript({ sheet });
  const first = parse(sandbox.doGet(getEvent({ action: 'claim', k: SECRET, run_id: 'run-1' })));
  const second = parse(sandbox.doGet(getEvent({ action: 'claim', k: SECRET, run_id: 'run-2' })));
  eq(first.rows.length, 1, 'first run claims it');
  eq(second.rows.length, 0, 'second run gets nothing');
  eq(sheet._rows()[0].run_id, 'run-1', 'the first run keeps it');
});

test('claim respects the limit and its cap of 20', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `r${i}`, received_at: iso(30000 - i), transcript: 'x', status: 'new', attempts: 0,
  }));
  const { sandbox } = loadScript({ sheet: sheetWithRows(many) });
  eq(parse(sandbox.doGet(getEvent({ action: 'claim', k: SECRET, limit: '3' }))).rows.length, 3, 'limit 3');

  const { sandbox: s2 } = loadScript({ sheet: sheetWithRows(many) });
  eq(parse(s2.doGet(getEvent({ action: 'claim', k: SECRET, limit: '99' }))).rows.length, 20, 'capped at 20');
});

test('a claim older than 30 minutes is reclaimed', () => {
  const sheet = sheetWithRows([{
    id: 'a', received_at: iso(60 * 60 * 1000), transcript: 'x',
    status: 'processing', run_id: 'dead-run', claimed_at: iso(45 * 60 * 1000), attempts: 1,
  }]);
  const { sandbox } = loadScript({ sheet });
  const res = parse(sandbox.doGet(getEvent({ action: 'claim', k: SECRET, run_id: 'run-2' })));
  eq(res.rows.length, 1, 'reclaimed');
  eq(sheet._rows()[0].run_id, 'run-2', 'the new run owns it');
  eq(sheet._rows()[0].attempts, 2, 'attempts incremented');
});

test('a fresh claim by another run is left alone', () => {
  const sheet = sheetWithRows([{
    id: 'a', received_at: iso(60000), transcript: 'x',
    status: 'processing', run_id: 'live-run', claimed_at: iso(60 * 1000), attempts: 1,
  }]);
  const { sandbox } = loadScript({ sheet });
  eq(parse(sandbox.doGet(getEvent({ action: 'claim', k: SECRET, run_id: 'run-2' }))).rows.length, 0, 'not stolen');
  eq(sheet._rows()[0].run_id, 'live-run', 'owner unchanged');
});

test('an errored row is retried, and parked as skipped after three attempts', () => {
  const retryable = sheetWithRows([{ id: 'a', received_at: iso(1000), transcript: 'x', status: 'error', attempts: 2 }]);
  const { sandbox } = loadScript({ sheet: retryable });
  eq(parse(sandbox.doGet(getEvent({ action: 'claim', k: SECRET }))).rows.length, 1, 'retried at 2 attempts');
  eq(retryable._rows()[0].attempts, 3, 'attempts');

  const exhausted = sheetWithRows([{ id: 'a', received_at: iso(1000), transcript: 'x', status: 'error', attempts: 3 }]);
  const { sandbox: s2 } = loadScript({ sheet: exhausted });
  eq(parse(s2.doGet(getEvent({ action: 'claim', k: SECRET }))).rows.length, 0, 'not retried at 3');
  eq(exhausted._rows()[0].status, 'skipped', 'parked');
});

test('a done row is never claimed again', () => {
  const sheet = sheetWithRows([{
    id: 'a', received_at: iso(1000), transcript: 'x', status: 'done',
    processed_at: iso(500), attempts: 1,
  }]);
  const { sandbox } = loadScript({ sheet });
  eq(parse(sandbox.doGet(getEvent({ action: 'claim', k: SECRET }))).rows.length, 0, 'left alone');
});

/* ------------------------------------------------------------- 3.3, complete */

test('complete writes the outcome and releases the row', () => {
  const sheet = sheetWithRows([{
    id: 'a', received_at: iso(1000), transcript: 'x', status: 'processing', attempts: 1,
  }]);
  const { sandbox } = loadScript({ sheet });
  const res = parse(sandbox.doPost(postEvent({
    action: 'complete', secret: SECRET, id: 'a', status: 'done',
    route: 'health', confidence: 'high', action_summary: 'Sleep 5h, walk skipped', dm_ts: '1725.001',
  })));
  eq(res.ok, true, 'ok');
  const row = sheet._rows()[0];
  eq(row.status, 'done', 'status');
  eq(row.route, 'health', 'route');
  eq(row.action_summary, 'Sleep 5h, walk skipped', 'action_summary');
  eq(row.dm_ts, '1725.001', 'dm_ts');
  ok(row.processed_at, 'processed_at is set');
});

test('complete refuses a status outside the status machine', () => {
  const sheet = sheetWithRows([{ id: 'a', received_at: iso(1000), transcript: 'x', status: 'processing' }]);
  const { sandbox } = loadScript({ sheet });
  eq(parse(sandbox.doPost(postEvent({ action: 'complete', secret: SECRET, id: 'a', status: 'processing' }))).ok,
     false, 'ok');
  eq(parse(sandbox.doPost(postEvent({ action: 'complete', secret: SECRET, id: 'nope', status: 'done' }))).error,
     'unknown id', 'unknown id');
});

/* ------------------------------------------------------------- 3.3, history */

test('history filters by route and window, and withholds the transcript', () => {
  const sheet = sheetWithRows([
    { id: 'h1', received_at: iso(2 * 864e5), transcript: 'private health text', status: 'done',
      route: 'health', action_summary: 'Sleep 5h', processed_at: iso(2 * 864e5) },
    { id: 't1', received_at: iso(3 * 864e5), transcript: 'a task', status: 'done',
      route: 'task', action_summary: 'Call the vet', processed_at: iso(3 * 864e5) },
    { id: 'h2', received_at: iso(40 * 864e5), transcript: 'old', status: 'done',
      route: 'health', action_summary: 'Sleep 8h', processed_at: iso(40 * 864e5) },
  ]);
  const { sandbox } = loadScript({ sheet });
  const res = parse(sandbox.doGet(getEvent({ action: 'history', k: SECRET, route: 'health', days: '14' })));
  eq(res.rows.length, 1, 'one health row inside the window');
  eq(res.rows[0].id, 'h1', 'the right one');
  eq(res.rows[0].action_summary, 'Sleep 5h', 'action_summary is returned');
  eq(res.rows[0].transcript, undefined, 'the transcript is withheld by default');

  const withText = parse(sandbox.doGet(getEvent({
    action: 'history', k: SECRET, route: 'health', days: '14', include_transcript: '1',
  })));
  eq(withText.rows[0].transcript, 'private health text', 'returned only when asked');
});

test('history ignores rows that were never routed', () => {
  const sheet = sheetWithRows([{ id: 'n1', received_at: iso(864e5), transcript: 'x', status: 'new' }]);
  const { sandbox } = loadScript({ sheet });
  eq(parse(sandbox.doGet(getEvent({ action: 'history', k: SECRET }))).rows.length, 0, 'none');
});

/* --------------------------------------------------- version 1: journal tab */

test('journal appends an entry to the journal tab and hands back an entry_id', () => {
  const sheet = sheetWithRows([{ id: 'm1', received_at: iso(1000), transcript: 'x', status: 'processing' }]);
  const { sandbox, tabs, logs } = loadScript({ sheet });
  const res = parse(sandbox.doPost(postEvent({
    action: 'journal', secret: SECRET, memo_id: 'm1', kind: 'journal',
    theme: 'a synthetic theme', entry: 'a synthetic one-line summary',
  })));
  eq(res.ok, true, 'ok');
  ok(res.entry_id, 'entry_id returned');
  const journal = tabs.journal;
  ok(journal, 'the tab was created on first use');
  eq(journal._grid[0].join(','), 'entry_id,memo_id,received_at,kind,theme,entry,created_at', 'header');
  const row = journal._rows()[0];
  eq(row.memo_id, 'm1', 'memo_id');
  eq(row.kind, 'journal', 'kind');
  eq(row.entry, 'a synthetic one-line summary', 'entry');
  ok(!logs.join('\n').includes('synthetic one-line'), 'no entry text in the logs');
});

test('journal is idempotent per memo and files ideas too', () => {
  const sheet = sheetWithRows([
    { id: 'm1', received_at: iso(1000), transcript: 'x', status: 'processing' },
    { id: 'm2', received_at: iso(900), transcript: 'y', status: 'processing' },
  ]);
  const { sandbox, tabs } = loadScript({ sheet });
  const a = parse(sandbox.doPost(postEvent({ action: 'journal', secret: SECRET, memo_id: 'm1', entry: 'one' })));
  const b = parse(sandbox.doPost(postEvent({ action: 'journal', secret: SECRET, memo_id: 'm1', entry: 'one again' })));
  eq(b.entry_id, a.entry_id, 'the repeat returns the first entry');
  eq(b.duplicate, true, 'and says so');
  const c = parse(sandbox.doPost(postEvent({ action: 'journal', secret: SECRET, memo_id: 'm2', kind: 'idea', entry: 'an idea' })));
  eq(c.ok, true, 'idea filed');
  eq(tabs.journal._rows().length, 2, 'two entries, not three');
  eq(tabs.journal._rows()[1].kind, 'idea', 'kind idea');
});

test('journal refuses a health memo, an unknown memo, a bad kind and an empty entry', () => {
  const sheet = sheetWithRows([
    { id: 'h', received_at: iso(1000), transcript: 'private', status: 'done', route: 'health' },
    { id: 'j', received_at: iso(900), transcript: 'x', status: 'processing' },
  ]);
  const { sandbox, tabs, logs } = loadScript({ sheet });
  const health = parse(sandbox.doPost(postEvent({ action: 'journal', secret: SECRET, memo_id: 'h', entry: 'private summary' })));
  eq(health.ok, false, 'health refused (rule 10)');
  ok(!logs.join('\n').includes('private summary'), 'refusal logs nothing from the body');
  eq(parse(sandbox.doPost(postEvent({ action: 'journal', secret: SECRET, memo_id: 'nope', entry: 'x' }))).error, 'unknown memo_id', 'unknown memo');
  eq(parse(sandbox.doPost(postEvent({ action: 'journal', secret: SECRET, memo_id: 'j', kind: 'health', entry: 'x' }))).error, 'bad kind', 'bad kind');
  eq(parse(sandbox.doPost(postEvent({ action: 'journal', secret: SECRET, memo_id: 'j', entry: '   ' }))).error, 'no entry', 'empty entry');
  ok(!tabs.journal || tabs.journal._rows().length === 0, 'nothing appended by any refusal');
  eq(parse(sandbox.doPost(postEvent({ action: 'journal', memo_id: 'j', entry: 'x' }))).error, 'unauthorized', 'no secret, no entry (rule 4)');
});

test('a dm_ts the Sheet turned into a number comes back as a six-decimal string', () => {
  const sheet = sheetWithRows([
    { id: 'n1', received_at: iso(2000), transcript: 'x', status: 'asked', route: 'task',
      dm_ts: 1788904236.64639, processed_at: iso(1500) },
    { id: 'n2', received_at: iso(2000), transcript: 'x', status: 'asked', route: 'task',
      dm_ts: '1788908607.4', processed_at: iso(1500) },
  ]);
  const { sandbox } = loadScript({ sheet });
  const res = parse(sandbox.doGet(getEvent({ action: 'asked', k: SECRET })));
  eq(res.rows[0].dm_ts, '1788904236.646390', 'number padded to six decimals');
  eq(res.rows[1].dm_ts, '1788908607.400000', 'short string padded too');
  const ping = parse(sandbox.doGet(getEvent({ action: 'ping', k: SECRET })));
  eq(ping.asked.map((a) => `${a.id}:${a.ts}`).join(','), 'n1:1788904236.646390,n2:1788908607.400000', 'ping pairs id with ts');
});

test('id-like cells are written with the plain-text format so nothing is rounded', () => {
  const sheet = makeSheet(HEADER);
  const { sandbox } = loadScript({ sheet });
  sandbox.doPost(postEvent(appBody()));
  const dmCol = HEADER.indexOf('dm_ts') + 1;
  const idCol = HEADER.indexOf('id') + 1;
  eq(sheet._format(2, idCol), '@', 'id cell is text on append');
  eq(sheet._format(2, dmCol), '@', 'dm_ts cell is text on append');
  const id = sheet._rows()[0].id;
  parse(sandbox.doGet(getEvent({ action: 'claim', k: SECRET, run_id: 'r' })));
  parse(sandbox.doPost(postEvent({ action: 'complete', secret: SECRET, id, status: 'asked', dm_ts: '1788904236.646390' })));
  eq(sheet._rows()[0].dm_ts, '1788904236.646390', 'stored as the string given');
  eq(sheet._format(2, dmCol), '@', 'still text after the row was rewritten');

  const fresh = makeSheet([]);
  loadScript({ sheet: fresh }).sandbox.setupSheet();
  eq(fresh._format(500, dmCol), '@', 'setupSheet formats the whole dm_ts column');
});

test('asked lists rows waiting on a reply, with dm_ts, and ping carries the timestamps', () => {
  const sheet = sheetWithRows([
    { id: 'a1', received_at: iso(2000), transcript: 'the dated task', status: 'asked', route: 'task',
      dm_ts: '1725.100', processed_at: iso(1500), action_summary: 'Proposed a card' },
    { id: 'a2', received_at: iso(2000), transcript: 'x', status: 'asked', route: 'ask', processed_at: iso(1500) },
    { id: 'd', received_at: iso(2000), transcript: 'x', status: 'done', route: 'task', dm_ts: '1725.200' },
    { id: 'old', received_at: iso(60 * 864e5), transcript: 'x', status: 'asked', route: 'task',
      dm_ts: '1725.300', processed_at: iso(60 * 864e5) },
  ]);
  const { sandbox } = loadScript({ sheet });
  const res = parse(sandbox.doGet(getEvent({ action: 'asked', k: SECRET })));
  eq(res.rows.length, 1, 'only the asked row that has a dm_ts and is inside 30 days');
  eq(res.rows[0].id, 'a1', 'the right one');
  eq(res.rows[0].dm_ts, '1725.100000', 'dm_ts, padded to the Slack shape');
  eq(res.rows[0].transcript, 'the dated task', 'transcript included by default');
  const noText = parse(sandbox.doGet(getEvent({ action: 'asked', k: SECRET, include_transcript: '0' })));
  eq(noText.rows[0].transcript, undefined, 'withheld on request');
  eq(sheet._rows()[0].status, 'asked', 'nothing changed');

  const ping = parse(sandbox.doGet(getEvent({ action: 'ping', k: SECRET })));
  eq(ping.asked_ts.join(','), '1725.100000,1725.300000', 'ping lists asked dm_ts values, and nothing else about them');
  ok(/^\d{4}-\d{2}-\d{2}\./.test(ping.version), 'ping reports the script version');
  ok(!JSON.stringify(ping).includes('dated task'), 'no text in ping');
});

test('complete records action_ref and history returns it', () => {
  const sheet = sheetWithRows([{ id: 'a', received_at: iso(1000), transcript: 'x', status: 'processing', attempts: 1 }]);
  const { sandbox } = loadScript({ sheet });
  const res = parse(sandbox.doPost(postEvent({
    action: 'complete', secret: SECRET, id: 'a', status: 'done', route: 'task',
    action_summary: 'Created a card', action_ref: 'https://trello.com/c/synthetic',
  })));
  eq(res.ok, true, 'ok');
  eq(sheet._rows()[0].action_ref, 'https://trello.com/c/synthetic', 'action_ref stored');
  const hist = parse(sandbox.doGet(getEvent({ action: 'history', k: SECRET, route: 'task' })));
  eq(hist.rows[0].action_ref, 'https://trello.com/c/synthetic', 'history carries it');
});

test('setupSheet creates the journal tab alongside memo_inbox', () => {
  const fresh = makeSheet([]);
  const { sandbox, tabs } = loadScript({ sheet: fresh });
  sandbox.setupSheet();
  ok(tabs.journal, 'journal tab exists');
  eq(tabs.journal._grid[0][0], 'entry_id', 'with its header');
});

/* ----------------------------------------------------------------- rule 12 */

test('purgeOldRows keeps health rows for a shorter period', () => {
  const sheet = sheetWithRows([
    { id: 'old-health', received_at: iso(120 * 864e5), transcript: 'x', status: 'done', route: 'health' },
    { id: 'old-task', received_at: iso(120 * 864e5), transcript: 'x', status: 'done', route: 'task' },
    { id: 'recent', received_at: iso(10 * 864e5), transcript: 'x', status: 'done', route: 'task' },
  ]);
  const { sandbox } = loadScript({ sheet });
  sandbox.purgeOldRows();
  const left = sheet._rows().map((r) => r.id);
  ok(!left.includes('old-health'), 'the 120-day health row goes at 90 days');
  ok(left.includes('old-task'), 'the 120-day task row stays until 180 days');
  ok(left.includes('recent'), 'the recent row stays');
});

/* ------------------------------------------------------------------ helpers */

test('timeOf reads a stored time whether Sheets gives back a string or a Date', () => {
  const { sandbox } = loadScript({ sheet: makeSheet(HEADER) });
  const when = new Date('2026-09-05T12:00:00.000Z');
  eq(sandbox.timeOf(when.toISOString()), when.getTime(), 'from a string');
  eq(sandbox.timeOf(when), when.getTime(), 'from a Date');
  eq(sandbox.timeOf(''), 0, 'from blank');
  eq(sandbox.timeOf('not a time'), 0, 'from nonsense');
});

test('ping counts pending by the same rules claim uses', () => {
  const sheet = sheetWithRows([
    { id: 'n', received_at: iso(1000), transcript: 'x', status: 'new', attempts: 0 },
    { id: 'stale', received_at: iso(60 * 60 * 1000), transcript: 'x', status: 'processing',
      run_id: 'dead', claimed_at: iso(45 * 60 * 1000), attempts: 1 },
    { id: 'live', received_at: iso(60000), transcript: 'x', status: 'processing',
      run_id: 'alive', claimed_at: iso(60 * 1000), attempts: 1 },
    { id: 'retry', received_at: iso(1000), transcript: 'x', status: 'error', attempts: 2 },
    { id: 'spent', received_at: iso(1000), transcript: 'x', status: 'error', attempts: 3 },
    { id: 'd', received_at: iso(1000), transcript: 'x', status: 'done', processed_at: iso(500) },
    { id: 's', received_at: iso(1000), transcript: 'x', status: 'skipped' },
  ]);
  const { sandbox } = loadScript({ sheet });
  const res = parse(sandbox.doGet(getEvent({ action: 'ping', k: SECRET })));
  eq(res.pending, 3, 'new + stale processing + retryable error');
  eq(sheet._rows()[1].status, 'processing', 'ping changed nothing');
  // And claim agrees.
  const claim = parse(sandbox.doGet(getEvent({ action: 'claim', k: SECRET, run_id: 'r' })));
  eq(claim.rows.length, 3, 'claim takes exactly those three');
  eq(parse(sandbox.doGet(getEvent({ action: 'ping', k: SECRET }))).pending, 0, 'nothing pending after the claim');
});

test('ping reports counts by status and no memo content', () => {
  const sheet = sheetWithRows([
    { id: 'a', received_at: iso(1000), transcript: 'a distinctive synthetic phrase', status: 'new' },
    { id: 'b', received_at: iso(900), transcript: 'x', status: 'done' },
  ]);
  const { sandbox } = loadScript({ sheet });
  const res = parse(sandbox.doGet(getEvent({ action: 'ping', k: SECRET })));
  eq(res.ok, true, 'ok');
  eq(res.rows, 2, 'row count');
  eq(res.status.new, 1, 'new count');
  ok(!JSON.stringify(res).includes('distinctive'), 'no memo text in the response');
});

/* -------------------------------------------------------------------- done */

console.log();
if (failures.length === 0) {
  console.log(`\x1b[32mAll ${passed} receiver checks passed.\x1b[0m`);
  process.exit(0);
}
console.log(`\x1b[31m${failures.length} of ${passed + failures.length} receiver checks failed.\x1b[0m`);
process.exit(1);
