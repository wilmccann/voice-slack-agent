/**
 * Memo Router — receiver and queue API.  SPEC.md sections 3.1, 3.2, 3.3, 5.2.
 *
 * One web app, four actions, all on the same /exec URL:
 *
 *   POST  (no action)        the phone app posts a memo -> append row, status=new
 *                            (or answer with the existing row if it is a retry)
 *   GET   ?action=claim      return and claim new rows  -> status=processing
 *   GET   ?action=history    recent processed rows, for pattern and update checks
 *   POST  ?action=complete   write the outcome of one row
 *   POST  ?action=journal    version 1: append a journal entry or a filed idea
 *                            to the "journal" tab of the same Sheet
 *   GET   ?action=asked      version 1: rows waiting on Will's reply, with the
 *                            DM timestamp the reply thread hangs off
 *   GET   ?action=ping       liveness and counts by status, no memo content;
 *                            "pending" is what a claim would return right now
 *
 * Rules cited are CLAUDE.md rules 1 to 15.
 *
 *   Rule 1   the shared secret lives in Script Properties, never in this file.
 *   Rule 4   every action verifies the secret, in constant time, before it
 *            touches the Sheet.  A bad request appends nothing and logs one
 *            line with a reason and no body.
 *   Rule 11  Apps Script logs never contain transcript text.  Row ids only.
 *   Rule 12  purgeOldRows() is the retention boundary; see the bottom.
 *
 * Apps Script cannot set an HTTP status code from a web app, so every response
 * is 200 with {"ok": true|false} as the real signal.
 */

/* ------------------------------------------------------------------ config */

var SHEET_NAME = 'memo_inbox';

/**
 * Reported by ping, so `node mcp/sheet-server.js --pending` can say which
 * version of this file is actually deployed.  Bump it when an action is added
 * or a column changes, because "I redeployed" and "the new code is live" have
 * turned out to be different things.
 */
var SCRIPT_VERSION = '2026-09-08.v1b';

/**
 * Columns that must never be read back as numbers.  Sheets keeps 15
 * significant digits in a number and a Slack timestamp has 16, so a dm_ts
 * stored as a number loses its last digit for good (found 2026-09-08: every
 * reply lookup answered thread_not_found).  These cells get the plain-text
 * number format before anything is written into them.
 */
var TEXT_COLUMNS = ['id', 'dm_ts', 'action_ref', 'source_id'];

/**
 * Version 1 (2026-09-08): journal entries and filed ideas land in a second tab
 * of the same Sheet.  SPEC.md section 6 left the choice between a Google Doc
 * and a second tab open; a tab needs no new Google scope (rule 5) and keeps
 * the content inside the one audit Sheet that rule 8 already allows.  Health
 * memos are never written here (rule 10); handleJournal refuses them.
 */
var JOURNAL_SHEET_NAME = 'journal';
var JOURNAL_COLUMNS = [
  'entry_id',
  'memo_id',
  'received_at',
  'kind',
  'theme',
  'entry',
  'created_at'
];
var JOURNAL_KINDS = ['journal', 'idea'];
var MAX_ENTRY_CHARS = 4000;

/**
 * Column order in the Sheet.  Matches SPEC.md 3.3, plus three operational
 * columns the status machine needs and 3.3 did not name:
 *   claimed_at  when a run took the row, so a stale claim can be detected
 *   attempts    how many runs have tried it, so "max 3 times, then skipped"
 *               in the 3.3 status machine is countable
 *   source_id   the app's own id for the memo, so a retried upload of the
 *               same recording is answered from the row it already has
 *               instead of appending another (added 2026-09-08, after the
 *               phone app retried every POST that Apps Script answered
 *               with a 302 and left about seven rows per memo)
 *   action_ref  version 1: what the agent created for this memo, as a
 *               reference and never as content: a Trello card URL, a Slack
 *               scheduled message id, or a journal entry id.  Blank when the
 *               memo was only proposed.  This is how a later "cancel that"
 *               can find what to cancel.
 * New columns go at the end: setupSheet() adds any that are missing to a
 * sheet that already has data, and appendRow() maps by header name.
 */
var COLUMNS = [
  'id',
  'received_at',
  'device_ts',
  'transcript',
  'label',
  'raw_json',
  'status',
  'run_id',
  'claimed_at',
  'attempts',
  'route',
  'confidence',
  'action_summary',
  'dm_ts',
  'processed_at',
  'error',
  'answer_to',
  'source_id',
  'action_ref'
];

/** Field mapping for the inbound POST (SPEC.md 3.1).  First key present wins. */
var TRANSCRIPT_KEYS = ['transcript', 'transcription', 'text', 'message', 'content', 'body'];
var DEVICE_TS_KEYS = ['timestamp', 'date', 'created_at', 'recorded_at'];
var LABEL_KEYS = ['title', 'name', 'filename'];

/**
 * The app's stable id for one memo.  The Webhook Voice Automation app sends
 * recording_id, which stays the same across its retries, and upload_attempt_id,
 * which does not; only the first is a dedupe key.  A client that sends none of
 * these gets a fingerprint of the content instead (see sourceIdFor).
 */
var SOURCE_ID_KEYS = ['recording_id', 'source_id', 'memo_id'];

/** Keys stripped from raw_json before the row is written (rule 4). */
var SECRET_KEYS = ['secret', 'k', 'token', 'key', 'auth'];

var MAX_CLAIM = 20;
var STALE_CLAIM_MINUTES = 30;
var MAX_ATTEMPTS = 3;
var MAX_TRANSCRIPT_CHARS = 20000;

/* ------------------------------------------------------------- entry points */

/**
 * The body is parsed once here and handed to the handler, so a caller can put
 * both the action and the secret in the body and keep the URL clean (SPEC.md
 * 3.2 transport A). A query parameter still works and wins if both are given.
 */
function doPost(e) {
  var body = parseBody(e);
  var action = param(e, 'action') || String(body.data.action || '') || 'memo';
  try {
    if (action === 'memo') return handleMemo(e, body);
    if (action === 'complete') return handleComplete(e, body);
    if (action === 'journal') return handleJournal(e, body);
    if (action === 'claim') return handleClaim(e, body);
    if (action === 'history') return handleHistory(e, body);
    if (action === 'asked') return handleAsked(e, body);
    if (action === 'ping') return handlePing(e, body);
    return json({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error('action=' + action + ' failed: ' + err);
    return json({ ok: false, error: 'internal error' });
  }
}

function doGet(e) {
  var body = parseBody(e);
  var action = param(e, 'action') || 'ping';
  try {
    if (action === 'ping') return handlePing(e, body);
    if (action === 'claim') return handleClaim(e, body);
    if (action === 'history') return handleHistory(e, body);
    if (action === 'asked') return handleAsked(e, body);
    return json({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error('action=' + action + ' failed: ' + err);
    return json({ ok: false, error: 'internal error' });
  }
}

/* ---------------------------------------------------------------- handlers */

/**
 * The phone app's POST.  The Webhook Voice Automation app sends JSON with the
 * transcript under "text" (SPEC.md 3.1); the other candidate keys stay so a
 * different client works too, and anything unrecognised is kept in raw_json.
 *
 * Idempotent on source_id: the app retries a POST it thinks failed, so the
 * same recording can arrive several times.  The lookup and the append happen
 * under one lock, and a repeat gets {ok:true, duplicate:true} with the id of
 * the row it already has.  Nothing is appended and no log line names the text.
 */
function handleMemo(e, body) {
  if (!authorised(e, body.data)) return reject('memo');

  var transcript = firstString(body.data, TRANSCRIPT_KEYS);
  if (!transcript && body.kind === 'text') transcript = body.raw;
  if (!transcript) {
    console.warn('memo rejected: no transcript field; body kind=' + body.kind +
                 ' keys=' + Object.keys(body.data).join(','));
    return json({ ok: false, error: 'no transcript field' });
  }
  transcript = String(transcript).slice(0, MAX_TRANSCRIPT_CHARS);

  var row = {};
  row.id = Utilities.getUuid();
  row.received_at = nowIso();
  row.device_ts = firstString(body.data, DEVICE_TS_KEYS) || '';
  row.transcript = transcript;
  row.label = firstString(body.data, LABEL_KEYS) || '';
  var rawJson = JSON.stringify(withoutSecrets(body.data));
  if (rawJson.length > MAX_TRANSCRIPT_CHARS) {
    // Truncating JSON leaves something that cannot be read back, so record the
    // shape instead.  This column only exists to catch a field 3.1 missed.
    rawJson = JSON.stringify({
      _truncated: true,
      _bytes: rawJson.length,
      _keys: Object.keys(withoutSecrets(body.data))
    });
  }
  row.raw_json = rawJson;
  row.status = 'new';
  row.attempts = 0;
  row.source_id = sourceIdFor(body.data, row);

  var stored = storeMemo(row);
  if (stored.duplicate) {
    // Rule 11: the ids only.  The app treats ok:true as delivered and stops
    // retrying this recording.
    console.info('memo duplicate of id=' + stored.id + ' (retried upload, not stored)');
    return json({ ok: true, id: stored.id, duplicate: true });
  }

  // Rule 11: the id and the length, never the text.
  console.info('memo stored id=' + row.id + ' chars=' + transcript.length);
  return json({ ok: true, id: row.id });
}

/**
 * The dedupe key for a memo.  The app's own id when it sends one, otherwise a
 * digest of the device time and the text, so two identical uploads from a
 * client with no id still collapse to one row while two memos with the same
 * words minutes apart (it happens) stay separate.  The digest is one way; the
 * text cannot be read back out of the Sheet column.
 */
function sourceIdFor(data, row) {
  var given = firstString(data, SOURCE_ID_KEYS);
  if (given) return given;
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(row.device_ts || '') + '\n' + row.transcript,
    Utilities.Charset.UTF_8
  );
  return 'sha256:' + digest.map(function (b) {
    return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
  }).join('');
}

/**
 * Return new rows and claim them in the same locked section, so two overlapping
 * runs can never take the same row.  SPEC.md 5.3 claims each row with a
 * separate write; doing it here instead removes that race and one tool call
 * per row.
 *
 * Idempotent per run: rows already processing under the same run_id are
 * returned again, without touching attempts.  Added 2026-09-08 after a claim
 * finished here but timed out on the client, which then retried, got nothing
 * (the rows were "taken", by itself), and reported an empty run while the
 * rows sat in processing until the stale window passed.
 *
 * Also does the two housekeeping transitions from the 3.3 status machine:
 * a claim older than 30 minutes with no processed_at goes back to new, and an
 * errored row is retried until attempts reaches 3, then parked as skipped.
 */
function handleClaim(e, body) {
  if (!authorised(e, body.data)) return reject('claim');

  var runId = param(e, 'run_id') || String(body.data.run_id || '') || nowIso();
  var asked = Number(param(e, 'limit') || body.data.limit || MAX_CLAIM);
  var limit = Math.min(asked || MAX_CLAIM, MAX_CLAIM);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var t = table();
    var staleBefore = Date.now() - STALE_CLAIM_MINUTES * 60 * 1000;
    var claimed = [];
    var reclaimed = 0;
    var redelivered = 0;
    var skipped = 0;

    for (var i = 0; i < t.rows.length; i++) {
      var r = t.rows[i];
      var status = String(r.get('status') || '');

      if (status === 'processing' && !r.get('processed_at')) {
        if (String(r.get('run_id') || '') === String(runId) && claimed.length < limit) {
          // This run already holds it; the earlier answer was lost in transit.
          claimed.push(rowForAgent(r));
          redelivered++;
          continue;
        }
        var at = timeOf(r.get('claimed_at'));
        if (!at || at < staleBefore) {
          r.set('status', 'new');
          reclaimed++;
          status = 'new';
        }
      }

      if (status === 'error') {
        if (Number(r.get('attempts') || 0) >= MAX_ATTEMPTS) {
          r.set('status', 'skipped');
          skipped++;
          continue;
        }
        status = 'new';
      }

      if (status !== 'new' || claimed.length >= limit) continue;

      r.set('status', 'processing');
      r.set('run_id', runId);
      r.set('claimed_at', nowIso());
      r.set('attempts', Number(r.get('attempts') || 0) + 1);
      r.set('error', '');

      claimed.push(rowForAgent(r));
    }

    t.flush();
    console.info('claim run_id=' + runId + ' claimed=' + claimed.length +
                 ' redelivered=' + redelivered + ' reclaimed=' + reclaimed +
                 ' skipped=' + skipped);
    return json({ ok: true, run_id: runId, rows: claimed });
  } finally {
    lock.releaseLock();
  }
}

/** The fields a claimed row hands to the agent (SPEC.md 5.2). */
function rowForAgent(r) {
  return {
    id: r.get('id'),
    received_at: r.get('received_at'),
    device_ts: r.get('device_ts'),
    transcript: r.get('transcript'),
    label: r.get('label'),
    attempts: r.get('attempts')
  };
}

/**
 * Recent processed rows, for the health pattern check and for matching a memo
 * that updates an earlier task (SPEC.md 5.2).
 *
 * Returns the one-line action_summary, not the transcript, because that is what
 * both uses need.  Pass include_transcript=1 to get the text as well; it is off
 * by default so the agent handles the least personal content that still works.
 */
function handleHistory(e, body) {
  if (!authorised(e, body.data)) return reject('history');

  var days = Number(param(e, 'days') || 14) || 14;
  var wanted = String(param(e, 'route') || '').split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
  var withText = param(e, 'include_transcript') === '1';
  var since = Date.now() - days * 24 * 60 * 60 * 1000;
  var limit = Math.min(Number(param(e, 'limit') || 100) || 100, 500);

  var t = table();
  var out = [];
  for (var i = t.rows.length - 1; i >= 0 && out.length < limit; i--) {
    var r = t.rows[i];
    var route = String(r.get('route') || '');
    if (!route) continue;
    if (wanted.length && wanted.indexOf(route) === -1) continue;
    var when = timeOf(r.get('processed_at') || r.get('received_at'));
    if (!when || when < since) continue;

    var item = {
      id: r.get('id'),
      received_at: r.get('received_at'),
      route: route,
      confidence: r.get('confidence'),
      action_summary: r.get('action_summary'),
      action_ref: r.get('action_ref'),
      status: r.get('status')
    };
    if (withText) item.transcript = r.get('transcript');
    out.push(item);
  }

  console.info('history days=' + days + ' routes=' + (wanted.join('|') || 'all') +
               ' returned=' + out.length);
  return json({ ok: true, rows: out.reverse() });
}

/** Write the outcome of one row.  Terminal states only. */
function handleComplete(e, body) {
  if (!authorised(e, body.data)) return reject('complete');

  var d = body.data;
  var id = d.id || param(e, 'id');
  if (!id) return json({ ok: false, error: 'no id' });

  var status = String(d.status || 'done');
  if (['done', 'asked', 'error', 'skipped'].indexOf(status) === -1) {
    return json({ ok: false, error: 'bad status' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var t = table();
    var r = t.byId(id);
    if (!r) return json({ ok: false, error: 'unknown id' });

    r.set('status', status);
    r.set('processed_at', nowIso());
    ['route', 'confidence', 'action_summary', 'dm_ts', 'error', 'answer_to', 'action_ref']
      .forEach(function (f) {
        if (d[f] !== undefined && d[f] !== null) r.set(f, String(d[f]));
      });
    t.flush();

    console.info('complete id=' + id + ' status=' + status +
                 ' route=' + (d.route || '-'));
    return json({ ok: true, id: id, status: status });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Version 1: the rows waiting on Will.  A row is "asked" when the agent sent a
 * DM that proposes something and needs a reply (rule 15).  The reply arrives
 * as a Slack thread under that DM, so each row comes back with its dm_ts.
 *
 * The transcript is included by default, because a reply is resolved by
 * re-running the decision with the reply as context (SPEC.md section 6), and
 * that needs the memo.  Nothing here changes a row.
 */
function handleAsked(e, body) {
  if (!authorised(e, body.data)) return reject('asked');
  var days = Number(param(e, 'days') || 30) || 30;
  var withText = param(e, 'include_transcript') !== '0';
  var since = Date.now() - days * 24 * 60 * 60 * 1000;

  var t = table();
  var out = [];
  for (var i = 0; i < t.rows.length; i++) {
    var r = t.rows[i];
    if (String(r.get('status') || '') !== 'asked') continue;
    if (!r.get('dm_ts')) continue;
    var when = timeOf(r.get('processed_at') || r.get('received_at'));
    if (when && when < since) continue;
    var item = {
      id: r.get('id'),
      received_at: r.get('received_at'),
      asked_at: r.get('processed_at'),
      dm_ts: slackTs(r.get('dm_ts')),
      route: r.get('route'),
      confidence: r.get('confidence'),
      action_summary: r.get('action_summary'),
      action_ref: r.get('action_ref')
    };
    if (withText) item.transcript = r.get('transcript');
    out.push(item);
  }
  console.info('asked days=' + days + ' returned=' + out.length);
  return json({ ok: true, rows: out });
}

/**
 * Version 1: append one journal entry or filed idea.  Body: memo_id, kind
 * ("journal" or "idea"), theme (one line), entry (the summary).  The memo row
 * must exist and must not be a health memo (rule 10): a row already marked
 * route=health is refused, and so is a row whose transcript this run has not
 * yet routed if the caller says it is health.  The entry is the agent's
 * summary, not the transcript, which stays in memo_inbox.
 *
 * Returns {ok, entry_id}.  entry_id goes into the memo row's action_ref.
 */
function handleJournal(e, body) {
  if (!authorised(e, body.data)) return reject('journal');

  var d = body.data;
  var memoId = String(d.memo_id || '');
  var kind = String(d.kind || 'journal');
  var theme = String(d.theme || '').trim();
  var entry = String(d.entry || '').trim();

  if (!memoId) return json({ ok: false, error: 'no memo_id' });
  if (JOURNAL_KINDS.indexOf(kind) === -1) return json({ ok: false, error: 'bad kind' });
  if (!entry) return json({ ok: false, error: 'no entry' });
  entry = entry.slice(0, MAX_ENTRY_CHARS);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var t = table();
    var r = t.byId(memoId);
    if (!r) return json({ ok: false, error: 'unknown memo_id' });
    if (String(r.get('route') || '') === 'health') {
      console.warn('journal refused memo_id=' + memoId + ' reason=health (rule 10)');
      return json({ ok: false, error: 'health memos are never journaled' });
    }

    // One entry per memo: a retried call returns the entry it already made.
    var js = journalSheet();
    var existing = findJournalEntry(js, memoId);
    if (existing) {
      console.info('journal duplicate memo_id=' + memoId + ' entry_id=' + existing);
      return json({ ok: true, entry_id: existing, duplicate: true });
    }

    var row = {
      entry_id: Utilities.getUuid(),
      memo_id: memoId,
      received_at: r.get('received_at'),
      kind: kind,
      theme: theme,
      entry: entry,
      created_at: nowIso()
    };
    var header = js.getRange(1, 1, 1, js.getLastColumn()).getValues()[0];
    js.appendRow(header.map(function (name) {
      var v = row[String(name)];
      return v === undefined ? '' : v;
    }));
    SpreadsheetApp.flush();

    // Rule 11: ids and the kind, never the entry.
    console.info('journal stored memo_id=' + memoId + ' kind=' + kind + ' entry_id=' + row.entry_id);
    return json({ ok: true, entry_id: row.entry_id });
  } finally {
    lock.releaseLock();
  }
}

/** The journal tab, created with its header the first time it is needed. */
function journalSheet() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  var js = ss.getSheetByName(JOURNAL_SHEET_NAME);
  if (!js) {
    js = ss.insertSheet(JOURNAL_SHEET_NAME);
    js.getRange(1, 1, 1, JOURNAL_COLUMNS.length).setValues([JOURNAL_COLUMNS]).setFontWeight('bold');
    js.setFrozenRows(1);
  } else if (js.getLastColumn() === 0) {
    js.getRange(1, 1, 1, JOURNAL_COLUMNS.length).setValues([JOURNAL_COLUMNS]).setFontWeight('bold');
    js.setFrozenRows(1);
  }
  return js;
}

function findJournalEntry(js, memoId) {
  var lastRow = js.getLastRow();
  if (lastRow < 2) return null;
  var header = js.getRange(1, 1, 1, js.getLastColumn()).getValues()[0];
  var memoCol = header.indexOf('memo_id');
  var idCol = header.indexOf('entry_id');
  if (memoCol === -1 || idCol === -1) return null;
  var values = js.getRange(2, 1, lastRow - 1, header.length).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][memoCol]) === String(memoId)) return String(values[i][idCol]);
  }
  return null;
}

/**
 * Counts by status, plus "pending": the rows a claim would take right now,
 * by the same rules handleClaim applies (new, or processing past the stale
 * window, or error with attempts left).  The run wrapper polls this once a
 * minute and only launches the agent when it is above zero, so a poll costs
 * one Sheet read and no model call.  Nothing here touches a row.
 */
function handlePing(e, body) {
  if (!authorised(e, body.data)) return reject('ping');
  var t = table();
  var counts = {};
  var pending = 0;
  var askedTs = [];
  var asked = [];
  var staleBefore = Date.now() - STALE_CLAIM_MINUTES * 60 * 1000;
  for (var i = 0; i < t.rows.length; i++) {
    var r = t.rows[i];
    var s = String(r.get('status') || 'blank');
    counts[s] = (counts[s] || 0) + 1;
    if (s === 'asked' && r.get('dm_ts')) {
      askedTs.push(slackTs(r.get('dm_ts')));
      asked.push({ id: String(r.get('id')), ts: slackTs(r.get('dm_ts')) });
    }
    if (s === 'new') pending++;
    else if (s === 'processing' && !r.get('processed_at')) {
      var at = timeOf(r.get('claimed_at'));
      if (!at || at < staleBefore) pending++;
    } else if (s === 'error' && Number(r.get('attempts') || 0) < MAX_ATTEMPTS) pending++;
  }
  // asked: the rows waiting on a reply, as {id, ts}, so the run wrapper can
  // ask Slack whether any thread has one before launching the agent.  The id
  // lets Slack find the DM again if the stored timestamp is wrong.  Ids and
  // timestamps only, no text.  asked_ts is the older shape, kept for a wrapper
  // that has not been updated.
  return json({ ok: true, version: SCRIPT_VERSION, sheet: SHEET_NAME, rows: t.rows.length,
                status: counts, pending: pending, asked_ts: askedTs, asked: asked });
}

/* --------------------------------------------------------------- auth (r4) */

/**
 * Transport A (preferred): a "secret" field in the JSON body.
 * Transport B (fallback): ?k=... on the URL, for GETs and for an app that
 * cannot add a body field.  SPEC.md 3.2 explains what each one exposes.
 */
function authorised(e, data) {
  var expected = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  if (!expected) {
    console.error('WEBHOOK_SECRET is not set in Script Properties; refusing every request (rule 4)');
    return false;
  }
  var given = (data && (data.secret || data.k)) || param(e, 'k') || '';
  return constantTimeEquals(String(given), expected);
}

/** Compare SHA-256 digests so the comparison is over two fixed-length values. */
function constantTimeEquals(given, expected) {
  if (!given) return false;
  var a = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, given, Utilities.Charset.UTF_8);
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, expected, Utilities.Charset.UTF_8);
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a[i] ^ b[i]);
  return diff === 0;
}

/** Rule 4 and rule 11: a reason and a timestamp, nothing from the request. */
function reject(action) {
  console.warn('rejected action=' + action + ' reason=secret missing or wrong');
  return json({ ok: false, error: 'unauthorized' });
}

/* ------------------------------------------------------------ body parsing */

/**
 * Normalise the three body shapes SPEC.md 3.1 allows into one object.
 * Apps Script folds form-encoded bodies into e.parameter for us.
 */
function parseBody(e) {
  var empty = { kind: 'none', data: {}, raw: '' };
  if (!e) return empty;

  var raw = (e.postData && e.postData.contents) || '';
  var type = String((e.postData && e.postData.type) || '').toLowerCase();

  if (raw) {
    var trimmed = raw.replace(/^\s+/, '');
    if (type.indexOf('json') !== -1 || trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { kind: 'json', data: parsed, raw: raw };
        }
        return { kind: 'json-array', data: {}, raw: raw };
      } catch (err) {
        return { kind: 'invalid-json', data: {}, raw: raw };
      }
    }
    if (type.indexOf('x-www-form-urlencoded') !== -1) {
      return { kind: 'form', data: flatten(e.parameter), raw: raw };
    }
    return { kind: 'text', data: flatten(e.parameter), raw: raw };
  }

  return { kind: e.parameter && Object.keys(e.parameter).length ? 'query' : 'none',
           data: flatten(e.parameter), raw: '' };
}

function flatten(parameter) {
  var out = {};
  if (!parameter) return out;
  Object.keys(parameter).forEach(function (k) { out[k] = parameter[k]; });
  return out;
}

function param(e, name) {
  if (e && e.parameter && e.parameter[name] !== undefined) return String(e.parameter[name]);
  return '';
}

function firstString(data, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = data[keys[i]];
    if (typeof v === 'string' && v.trim().length) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
}

/** Rule 4: the secret is stripped before anything is written to the Sheet. */
function withoutSecrets(data) {
  var out = {};
  Object.keys(data || {}).forEach(function (k) {
    if (SECRET_KEYS.indexOf(k.toLowerCase()) === -1) out[k] = data[k];
  });
  return out;
}

/* ------------------------------------------------------------- sheet access */

function sheet() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No spreadsheet: bind the script to the Sheet or set SPREADSHEET_ID');
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('No sheet named ' + SHEET_NAME + '; run setupSheet() once');
  if (sh.getLastColumn() === 0) {
    throw new Error('Sheet ' + SHEET_NAME + ' has no header row; run setupSheet() once');
  }
  return sh;
}

/**
 * Read the whole sheet once, edit in memory, write back the changed rows.
 * The Sheet is small by design, so this is cheaper and far less racy than
 * per-cell reads and writes.
 */
function table() {
  var sh = sheet();
  var lastRow = sh.getLastRow();
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var index = {};
  header.forEach(function (name, i) { if (name) index[String(name)] = i; });

  var values = lastRow > 1
    ? sh.getRange(2, 1, lastRow - 1, header.length).getValues()
    : [];

  var dirty = {};
  var rows = values.map(function (values_, i) {
    return {
      _i: i,
      get: function (field) {
        var c = index[field];
        return c === undefined ? '' : values_[c];
      },
      set: function (field, value) {
        var c = index[field];
        if (c === undefined) return;
        if (values_[c] === value) return;
        values_[c] = value;
        dirty[i] = true;
      }
    };
  });

  return {
    rows: rows,
    byId: function (id) {
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].get('id')) === String(id)) return rows[i];
      }
      return null;
    },
    flush: function () {
      var changed = Object.keys(dirty);
      if (!changed.length) return;
      changed.forEach(function (i) {
        var rowNumber = Number(i) + 2;
        forceTextFormat(sh, rowNumber, index);
        sh.getRange(rowNumber, 1, 1, header.length).setValues([values[Number(i)]]);
      });
      SpreadsheetApp.flush();
    }
  };
}

/**
 * Append the row unless one with the same source_id exists.  One lock covers
 * the lookup and the append, so two retries landing together cannot both pass
 * the lookup.  Returns {duplicate:true, id} for a repeat, {duplicate:false}
 * otherwise.  A sheet whose header predates the source_id column stores
 * nothing in it and never matches, so the old behaviour (append every time)
 * continues until setupSheet() is run again.
 */
function storeMemo(row) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (row.source_id) {
      var t = table();
      for (var i = 0; i < t.rows.length; i++) {
        if (String(t.rows[i].get('source_id') || '') === String(row.source_id)) {
          return { duplicate: true, id: t.rows[i].get('id') };
        }
      }
    }
    appendRow(row);
    return { duplicate: false, id: row.id };
  } finally {
    lock.releaseLock();
  }
}

/** Caller holds the lock. */
function appendRow(row) {
  var sh = sheet();
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var index = {};
  header.forEach(function (name, i) { if (name) index[String(name)] = i; });
  var line = header.map(function (name) {
    var v = row[String(name)];
    return v === undefined ? '' : v;
  });
  // Format the cells first, then write, so a numeric-looking id stays text.
  var rowNumber = sh.getLastRow() + 1;
  forceTextFormat(sh, rowNumber, index);
  sh.getRange(rowNumber, 1, 1, header.length).setValues([line]);
  SpreadsheetApp.flush();
}

/** Plain-text format on the TEXT_COLUMNS cells of one row (see the constant). */
function forceTextFormat(sh, rowNumber, index) {
  TEXT_COLUMNS.forEach(function (name) {
    var c = index[name];
    if (c === undefined) return;
    sh.getRange(rowNumber, c + 1).setNumberFormat('@');
  });
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * A Slack timestamp as the string Slack wants: digits, a dot, six digits.  A
 * cell written before TEXT_COLUMNS existed comes back as a number with its
 * trailing zero, or worse its last digit, gone; this restores the shape, and
 * the Slack server falls back to finding the DM by memo id when the value is
 * still wrong.
 */
function slackTs(value) {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value === 'number') return value.toFixed(6);
  var s = String(value).trim();
  var m = s.match(/^(\d+)\.(\d{1,6})$/);
  if (m) return m[1] + '.' + (m[2] + '000000').slice(0, 6);
  return s;
}

/**
 * Milliseconds for a cell we wrote as an ISO string.  Sheets sometimes coerces
 * a date-like string into a real Date on the way in, so a bare Date.parse()
 * would return NaN for exactly the rows that matter.  Returns 0 when there is
 * no usable time, which every caller treats as "unknown, do not act on it".
 */
function timeOf(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  var t = Date.parse(String(value));
  return isNaN(t) ? 0 : t;
}

/* ---------------------------------------------------------------- one-offs */

/**
 * Run from the editor before the first deployment, and again after any update
 * that adds a column.  Creates the sheet if it is missing; on a sheet that
 * already has a header it appends only the columns that are not there yet, so
 * existing rows keep their alignment and their data.
 */
function setupSheet() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

  var existing = sh.getLastColumn() > 0
    ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
        .map(function (v) { return String(v || ''); })
        .filter(function (v) { return v.length > 0; })
    : [];
  var missing = COLUMNS.filter(function (c) { return existing.indexOf(c) === -1; });

  if (!existing.length) {
    sh.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]).setFontWeight('bold');
  } else if (missing.length) {
    sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, existing.length + missing.length || COLUMNS.length);

  // Plain text on the id-like columns, for every row the sheet has, so
  // nothing written later is rounded (see TEXT_COLUMNS).
  var headerNow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  TEXT_COLUMNS.forEach(function (name) {
    var c = headerNow.indexOf(name);
    if (c === -1 || sh.getMaxRows() < 2) return;
    sh.getRange(2, c + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  });

  var filled = backfillSourceIds();
  journalSheet();
  console.info('setupSheet: ' + SHEET_NAME + ' has ' + (existing.length + missing.length) +
               ' columns; added ' + (missing.length ? missing.join(',') : 'none') +
               '; source_id backfilled on ' + filled + ' rows; ' +
               JOURNAL_SHEET_NAME + ' tab ready');
}

/**
 * Rows written before source_id existed have the app's recording_id inside
 * raw_json and nothing in source_id.  Without this, the app's retries of those
 * recordings would not match and would append fresh rows.  Fills the column
 * from raw_json where it is blank; rows with no id in raw_json are left blank,
 * which never matches anything.
 */
function backfillSourceIds() {
  var t = table();
  var filled = 0;
  for (var i = 0; i < t.rows.length; i++) {
    var r = t.rows[i];
    if (String(r.get('source_id') || '')) continue;
    var raw = String(r.get('raw_json') || '');
    if (!raw) continue;
    var data;
    try { data = JSON.parse(raw); } catch (err) { continue; }
    var id = firstString(data || {}, SOURCE_ID_KEYS);
    if (!id) continue;
    r.set('source_id', id);
    filled++;
  }
  t.flush();
  return filled;
}

/**
 * Rule 12, the retention boundary.  Not installed by default: add a daily
 * time-driven trigger for it once the retention period is agreed.  SPEC.md
 * section 9 proposes 180 days for everything and 90 for health.
 */
function purgeOldRows() {
  var props = PropertiesService.getScriptProperties();
  var keepDays = Number(props.getProperty('RETENTION_DAYS') || 180);
  var keepHealthDays = Number(props.getProperty('HEALTH_RETENTION_DAYS') || 90);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet();
    var t = table();
    var now = Date.now();
    var doomed = [];
    for (var i = 0; i < t.rows.length; i++) {
      var r = t.rows[i];
      var when = timeOf(r.get('received_at'));
      if (!when) continue;
      var limit = String(r.get('route')) === 'health' ? keepHealthDays : keepDays;
      if (now - when > limit * 24 * 60 * 60 * 1000) doomed.push(i);
    }
    doomed.reverse().forEach(function (i) { sh.deleteRow(i + 2); });
    console.info('purgeOldRows deleted=' + doomed.length +
                 ' keepDays=' + keepDays + ' keepHealthDays=' + keepHealthDays);
  } finally {
    lock.releaseLock();
  }
}
