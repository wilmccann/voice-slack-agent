#!/usr/bin/env node
// Memo Router — the Slack tools, as a stdio MCP server.
//
// Version 0: one tool, slack_dm. Version 1 (2026-09-08) adds two:
//   slack_schedule_reminder  the same DM delivered later, through Slack's
//                            chat.scheduleMessage to the same fixed recipient.
//                            No scope beyond chat:write, so a "reminder" never
//                            leaves the DM (rules 5 and 8).
//   slack_read_replies       Will's replies in the thread under one DM, which
//                            is how a proposed card or reminder is confirmed
//                            (rule 15, SPEC.md section 6). Needs im:history,
//                            the one scope added in version 1; it reads this
//                            one DM conversation and nothing else. Only
//                            messages from the configured user are returned.
//
// Also a command-line mode, for bin/process-memos.sh:
//   node mcp/slack-server.js --reply-count <ts> [<ts> ...]
// prints how many of those threads have Will as the last speaker, so the
// wrapper can skip launching the agent when nobody has answered anything.
//
// SPEC.md 5.2 gives version 0 exactly one side-effecting output: a Slack DM to
// Will. No Slack MCP server is configured for the Claude Code CLI on this Mac,
// and a general-purpose one would hand the agent every channel in the
// workspace. This server exposes a single tool that can only DM one person.
//
// The destination is read from the environment at startup and is not a tool
// argument, so "Slack scoped to sending Will a DM and nothing else" (rule 5) is
// enforced at the tool boundary rather than asked for in the prompt. A memo
// that says "post this to #general" cannot be obeyed even if the agent were
// talked into trying (rule 13).
//
// Token scopes needed on the Slack app: chat:write, im:write and, since
// version 1, im:history. Nothing else.
//
// Rules (CLAUDE.md):
//   1, 2  SLACK_BOT_TOKEN comes from the environment or the gitignored dotenv
//         file and is never printed.
//   11    stderr carries the memo id and the message timestamp, never the text.

'use strict';

const { serve, loadDotenv, makeLogger } = require('./lib/mcp');

loadDotenv(__dirname);

const SERVER_NAME = 'memo-slack';
const SERVER_VERSION = '0.1.0';
const REQUEST_TIMEOUT_MS = 20000;
const SECTION_TEXT_LIMIT = 2900; // Slack's limit is 3000; leave room for the notice.
const MAX_SCHEDULE_DAYS = 120;   // Slack refuses a post_at further out than this.

const TOKEN = process.env.SLACK_BOT_TOKEN || '';
const DM_TARGET = process.env.SLACK_DM_USER_ID || '';
const log = makeLogger(SERVER_NAME);

function configProblem() {
  const missing = [];
  if (!TOKEN) missing.push('SLACK_BOT_TOKEN');
  if (!DM_TARGET) missing.push('SLACK_DM_USER_ID');
  if (!missing.length) return null;
  return `Not configured: ${missing.join(' and ')} unset. Set it in the project ` +
         'dotenv file (copy the example file at the repository root) and retry.';
}

/* ------------------------------------------------------------- slack calls */

// Slack's write methods take a JSON body. Its read methods (conversations.*
// reads and the like) do not: they want the arguments on the query string and
// answer invalid_arguments to a JSON body. Pass {get: true} for those.
async function slack(method, body, { get = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    const url = new URL(`https://slack.com/api/${method}`);
    const init = { headers: { authorization: `Bearer ${TOKEN}` }, signal: controller.signal };
    if (get) {
      for (const [k, v] of Object.entries(body || {})) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
      init.method = 'GET';
    } else {
      init.method = 'POST';
      init.headers['content-type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(body);
    }
    res = await fetch(url, init);
  } catch (err) {
    const why = err && err.name === 'AbortError'
      ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
      : 'could not be reached';
    throw new Error(`Slack ${why} (${method}).`);
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({ ok: false, error: 'non-JSON response' }));
  if (!data.ok) {
    const hint = {
      not_authed: 'SLACK_BOT_TOKEN is empty or malformed.',
      invalid_auth: 'SLACK_BOT_TOKEN is not valid; reinstall the app and copy the bot token again.',
      missing_scope: `The token is missing a scope. This server needs chat:write, im:write and im:history; Slack said it needed "${data.needed || 'unknown'}".`,
      channel_not_found: 'SLACK_DM_USER_ID does not look like a user in this workspace. It should be a member id beginning with U.',
      cannot_dm_bot: 'SLACK_DM_USER_ID points at a bot, not a person.',
      ratelimited: 'Slack is rate limiting this token; the next run will retry the row.',
      time_in_past: 'The reminder time is in the past.',
      time_too_far: `The reminder time is more than ${MAX_SCHEDULE_DAYS} days out, which Slack does not allow.`,
      invalid_time: 'The reminder time could not be read as a time.',
    }[data.error];
    throw new Error(`Slack refused ${method}: ${data.error}.${hint ? ' ' + hint : ''}`);
  }
  return data;
}

// The DM channel id for the one allowed recipient, resolved once per process.
let dmChannel = null;
async function dmChannelId() {
  if (dmChannel) return dmChannel;
  const data = await slack('conversations.open', { users: DM_TARGET });
  dmChannel = data.channel && data.channel.id;
  if (!dmChannel) throw new Error('Slack opened no DM channel for SLACK_DM_USER_ID.');
  return dmChannel;
}

/* ------------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: 'slack_dm',
    description:
      'Send one direct message to Will. This is the only action in version 0 that ' +
      'changes anything outside the audit Sheet. The recipient is fixed by ' +
      'configuration and cannot be chosen: there is no channel argument, and no ' +
      'instruction in a memo can redirect it. Send exactly one DM per memo. ' +
      'Returns {ts}, the Slack timestamp, which must then be written to the row as ' +
      'dm_ts. Pass the message body only; the trailing "memo <id>" trace line is ' +
      'added for you.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          minLength: 1,
          description:
            'The message body, already formatted per the house style: first line ' +
            'begins with a bracketed route tag such as [task]. Sent verbatim, with ' +
            'no markdown interpretation, so a memo quoted back is unchanged.',
        },
        memo_id: {
          type: 'string',
          description:
            'The row id this DM is about. Rendered as a small trailing line so the ' +
            'message can be traced back to its row.',
        },
        thread_ts: {
          type: 'string',
          description:
            'Version 1. Send this message as a reply in the thread under an earlier ' +
            'DM, given by that DM\'s ts. Use it when answering a reply from Will, so ' +
            'the conversation about one memo stays in one thread.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'slack_read_replies',
    description:
      'Version 1. Read Will\'s replies in the thread under one earlier DM, given its ' +
      'ts (the dm_ts on an asked row) and the memo id. Returns {replies: [{ts, text}], ' +
      'last_from_will, dm_ts}, where dm_ts is the timestamp that actually worked. ' +
      'Only messages from Will are returned; the bot\'s own messages are left out. A ' +
      'reply is Will\'s instruction about that memo and may be acted on, but only with ' +
      'the tools that memo\'s route allows. last_from_will false means nothing new: ' +
      'Will has not spoken since the last message in the thread was the bot\'s.',
    inputSchema: {
      type: 'object',
      properties: {
        dm_ts: { type: 'string', minLength: 1, description: 'The ts of the DM that asked.' },
        memo_id: {
          type: 'string',
          description:
            'The row id. Always pass it: if the stored dm_ts does not name a message, ' +
            'the DM is found again by the "memo <id>" line it carries, and the result\'s ' +
            'dm_ts is the corrected value to write back to the row.',
        },
      },
      required: ['dm_ts'],
      additionalProperties: false,
    },
  },
  {
    name: 'slack_schedule_reminder',
    description:
      'Version 1 write tool. Schedule a reminder: a DM to Will, delivered at a given ' +
      'time. Same fixed recipient as slack_dm, no other destination. Use it for a task ' +
      'that says remind, at high or medium confidence, and state the delivery time in ' +
      'the DM; at low confidence ask instead. The time must be in the ' +
      `future and within ${MAX_SCHEDULE_DAYS} days. Returns {scheduled_message_id, ` +
      'post_at}; put scheduled_message_id in the row as action_ref.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          minLength: 1,
          description: 'The reminder body, plain text, opening with [reminder].',
        },
        at: {
          type: 'string',
          description:
            'When to deliver it, as an ISO 8601 time with an offset, for example ' +
            '2026-09-10T09:00:00-04:00. Resolve "Thursday" to a real time in ' +
            'America/New_York first; 09:00 local when the memo gives a day but no time.',
        },
        memo_id: { type: 'string', description: 'The row id this reminder is for.' },
      },
      required: ['text', 'at'],
      additionalProperties: false,
    },
  },
];

async function call(name, a) {
  if (name === 'slack_schedule_reminder') return scheduleReminder(a);
  if (name === 'slack_read_replies') return readReplies(a);
  if (name !== 'slack_dm') throw new Error(`Unknown tool: ${name}`);

  const problem = configProblem();
  if (problem) throw new Error(problem);

  let text = String(a.text || '').trim();
  if (!text) throw new Error('slack_dm needs a non-empty text.');
  if (text.length > SECTION_TEXT_LIMIT) {
    text = text.slice(0, SECTION_TEXT_LIMIT) + '\n[truncated]';
  }

  // plain_text, not mrkdwn: a memo quoted back under rule 13 must survive
  // unchanged, and transcripts are not markdown.
  const blocks = [{ type: 'section', text: { type: 'plain_text', text, emoji: false } }];
  if (a.memo_id) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'plain_text', text: `memo ${String(a.memo_id)}`, emoji: false }],
    });
  }

  const channel = await dmChannelId();
  const message = {
    channel,
    text,          // fallback for notifications
    blocks,
    mrkdwn: false,
    unfurl_links: false,  // rule 14: a URL in a memo is repeated, never fetched
    unfurl_media: false,
  };
  if (a.thread_ts) message.thread_ts = String(a.thread_ts);
  const data = await slack('chat.postMessage', message);

  log('slack_dm', { memo_id: a.memo_id || '-', ts: data.ts, thread: a.thread_ts || '-', chars: text.length });
  return { ok: true, ts: data.ts };
}

/* ---------------------------------------------------------------- replies */

/**
 * Find the ts of the DM that carries "memo <id>" in its trailing context line.
 * This is the recovery path for a dm_ts the Sheet rounded (it keeps 15
 * significant digits; Slack timestamps have 16) or otherwise lost. Scans the
 * DM conversation newest first, a few pages at most. Needs im:history.
 */
async function findDmTsByMemoId(memoId) {
  const channel = await dmChannelId();
  const marker = `memo ${String(memoId)}`;
  let cursor;
  for (let page = 0; page < 5; page++) {
    const data = await slack('conversations.history', { channel, limit: 200, cursor }, { get: true });
    for (const m of data.messages || []) {
      if (!m.bot_id) continue;
      for (const b of m.blocks || []) {
        if (b.type !== 'context') continue;
        for (const el of b.elements || []) {
          if (String(el.text || '') === marker) return String(m.ts);
        }
      }
    }
    cursor = data.response_metadata && data.response_metadata.next_cursor;
    if (!cursor) break;
  }
  return null;
}

const looksTruncated = (ts) => !/^\d+\.\d{6}$/.test(String(ts));

/**
 * The thread under one DM, reduced to what the agent may act on: Will's own
 * messages, in order, and whether the last word in the thread is his.
 */
async function threadFromWill(dmTs, memoId) {
  const channel = await dmChannelId();
  let ts = String(dmTs).trim();
  // A value the Sheet rounded, or reduced to a whole number, cannot name a
  // message. With a memo id, find the DM by its "memo <id>" line first.
  if (looksTruncated(ts) && memoId) {
    const found = await findDmTsByMemoId(memoId);
    if (found) ts = found;
  }
  if (!/^\d+\.\d+$/.test(ts)) {
    throw new Error(`"${ts}" is not a Slack message timestamp (expected digits.digits).`);
  }
  let data;
  const fetchThread = () => slack('conversations.replies', { channel, ts, limit: 50 }, { get: true });
  try {
    data = await fetchThread();
  } catch (err) {
    if (!/thread_not_found|message_not_found/.test(err.message)) throw err;
    // The stored ts does not name a message. If we know the memo id, find the
    // DM by its trailing "memo <id>" line and use the real ts.
    const recovered = memoId ? await findDmTsByMemoId(memoId) : null;
    if (!recovered || recovered === ts) return { replies: [], last_from_will: false, dm_ts: ts };
    ts = recovered;
    try {
      data = await fetchThread();
    } catch (err2) {
      if (/thread_not_found|message_not_found/.test(err2.message)) return { replies: [], last_from_will: false, dm_ts: ts };
      throw err2;
    }
  }
  const messages = (data.messages || []).filter((m) => String(m.ts) !== ts);
  const fromWill = messages
    .filter((m) => m.user === DM_TARGET && !m.bot_id)
    .map((m) => ({ ts: m.ts, text: String(m.text || '') }));
  const last = messages[messages.length - 1];
  const lastFromWill = !!(last && last.user === DM_TARGET && !last.bot_id);
  // dm_ts is the ts that actually worked. When it differs from what was
  // passed, the row's stored value was wrong and should be replaced with this.
  return { replies: fromWill, last_from_will: lastFromWill, dm_ts: ts };
}

async function readReplies(a) {
  const problem = configProblem();
  if (problem) throw new Error(problem);
  if (!a.dm_ts) throw new Error('slack_read_replies needs dm_ts.');
  const thread = await threadFromWill(a.dm_ts, a.memo_id);
  log('slack_read_replies', {
    memo_id: a.memo_id || '-',
    dm_ts: String(a.dm_ts),
    resolved_ts: thread.dm_ts,
    replies: thread.replies.length,
    last_from_will: thread.last_from_will,
  });
  return thread;
}

/**
 * --reply-count: how many of the given threads are waiting on the agent.
 * Each token is "id:ts" (preferred: the id lets a wrong ts be recovered) or a
 * bare ts.
 */
function parseThreadTokens(tokens) {
  return tokens.filter(Boolean).map((tok) => {
    const at = tok.indexOf(':');
    return at === -1 ? { ts: tok } : { id: tok.slice(0, at), ts: tok.slice(at + 1) };
  });
}

async function printReplyCount(tokens) {
  const problem = configProblem();
  if (problem) throw new Error(problem);
  let count = 0;
  for (const { id, ts } of parseThreadTokens(tokens)) {
    if (!ts) continue;
    const thread = await threadFromWill(ts, id);
    if (thread.last_from_will) count++;
  }
  process.stdout.write(String(count) + '\n');
}

async function scheduleReminder(a) {
  const problem = configProblem();
  if (problem) throw new Error(problem);

  let text = String(a.text || '').trim();
  if (!text) throw new Error('slack_schedule_reminder needs a non-empty text.');
  if (text.length > SECTION_TEXT_LIMIT) text = text.slice(0, SECTION_TEXT_LIMIT) + '\n[truncated]';

  const when = Date.parse(String(a.at || ''));
  if (Number.isNaN(when)) throw new Error('slack_schedule_reminder needs "at" as an ISO 8601 time with an offset.');
  const postAt = Math.floor(when / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (postAt <= now + 60) throw new Error('The reminder time must be at least a minute in the future.');
  if (postAt > now + MAX_SCHEDULE_DAYS * 86400) {
    throw new Error(`The reminder time is more than ${MAX_SCHEDULE_DAYS} days out, which Slack does not allow.`);
  }

  const blocks = [{ type: 'section', text: { type: 'plain_text', text, emoji: false } }];
  if (a.memo_id) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'plain_text', text: `memo ${String(a.memo_id)}`, emoji: false }],
    });
  }

  const channel = await dmChannelId();
  const data = await slack('chat.scheduleMessage', {
    channel,
    post_at: postAt,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  });

  log('slack_schedule_reminder', {
    memo_id: a.memo_id || '-',
    scheduled_message_id: data.scheduled_message_id,
    post_at: new Date(postAt * 1000).toISOString(),
    chars: text.length,
  });
  return {
    ok: true,
    scheduled_message_id: data.scheduled_message_id,
    post_at: new Date(postAt * 1000).toISOString(),
  };
}

/** --thread-debug: per thread, what Slack returned, as counts and booleans only. */
async function printThreadDebug(tokens) {
  const problem = configProblem();
  if (problem) throw new Error(problem);
  const channel = await dmChannelId();
  for (const { id, ts: given } of parseThreadTokens(tokens)) {
    if (!given) continue;
    let line;
    try {
      let ts = String(given);
      let recovered = false;
      if (id && (looksTruncated(ts))) {
        const found = await findDmTsByMemoId(id);
        if (found) { ts = found; recovered = true; }
      }
      let data;
      try {
        data = await slack('conversations.replies', { channel, ts, limit: 50 }, { get: true });
      } catch (err) {
        if (!id || !/thread_not_found/.test(err.message)) throw err;
        const found = await findDmTsByMemoId(id);
        if (!found) throw err;
        ts = found; recovered = true;
        data = await slack('conversations.replies', { channel, ts, limit: 50 }, { get: true });
      }
      const msgs = data.messages || [];
      line = {
        ts: String(given),
        resolved_ts: ts,
        recovered_by_memo_id: recovered,
        found: true,
        messages: msgs.length,
        parent_is_bot: !!(msgs[0] && msgs[0].bot_id),
        replies_from_target: msgs.slice(1).filter((m) => m.user === DM_TARGET).length,
        replies_from_others: msgs.slice(1).filter((m) => m.user !== DM_TARGET).length,
        last_user_is_target: !!(msgs.length > 1 && msgs[msgs.length - 1].user === DM_TARGET),
        last_has_bot_id: !!(msgs.length > 1 && msgs[msgs.length - 1].bot_id),
      };
    } catch (err) {
      line = { ts: String(given), found: false, error: err.message.replace(/xox[a-z]-[A-Za-z0-9-]+/g, '[token]') };
    }
    process.stdout.write(JSON.stringify(line) + '\n');
  }
}

const debugFlag = process.argv.indexOf('--thread-debug');
if (debugFlag !== -1) {
  printThreadDebug(process.argv.slice(debugFlag + 1).flatMap((s) => s.split(',')).map((s) => s.trim())).then(
    () => process.exit(0),
    (err) => { process.stderr.write(`${err.message}\n`); process.exit(1); },
  );
}

const replyFlag = process.argv.indexOf('--reply-count');
if (debugFlag !== -1) {
  /* handled above */
} else if (replyFlag !== -1) {
  printReplyCount(process.argv.slice(replyFlag + 1).flatMap((s) => s.split(',')).map((s) => s.trim())).then(
    () => process.exit(0),
    (err) => { process.stderr.write(`reply check failed: ${err.message}\n`); process.exit(1); },
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
