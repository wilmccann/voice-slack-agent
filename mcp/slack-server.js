#!/usr/bin/env node
// Memo Router — the one write tool, as a stdio MCP server.
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
// Token scopes needed on the Slack app: chat:write and im:write. Nothing else.
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

async function slack(method, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
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
      missing_scope: `The token is missing a scope. This server needs chat:write and im:write; Slack said it needed "${data.needed || 'unknown'}".`,
      channel_not_found: 'SLACK_DM_USER_ID does not look like a user in this workspace. It should be a member id beginning with U.',
      cannot_dm_bot: 'SLACK_DM_USER_ID points at a bot, not a person.',
      ratelimited: 'Slack is rate limiting this token; the next run will retry the row.',
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
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

async function call(name, a) {
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
  const data = await slack('chat.postMessage', {
    channel,
    text,          // fallback for notifications
    blocks,
    mrkdwn: false,
    unfurl_links: false,  // rule 14: a URL in a memo is repeated, never fetched
    unfurl_media: false,
  });

  log('slack_dm', { memo_id: a.memo_id || '-', ts: data.ts, chars: text.length });
  return { ok: true, ts: data.ts };
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
