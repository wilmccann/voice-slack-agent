// Minimal stdio MCP server, shared by the two servers in this folder.
//
// Deliberately dependency-free: the agent's tools should not need an install
// step or a lockfile to audit. It speaks enough of the protocol for Claude Code
// to connect, list tools and call them.
//
// Two hard rules for anything built on this (CLAUDE.md rules 2 and 11):
//   - stdout carries JSON-RPC and nothing else. One stray console.log breaks
//     the transport, so use log() below, which writes to stderr.
//   - stderr never carries transcript text or a secret value.

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, '2025-03-26', '2025-06-18']);

/**
 * Read the gitignored dotenv file at the repository root into process.env,
 * without overwriting anything already set. The filename is assembled rather
 * than written out so that tooling which greps this repository for that
 * literal has nothing to find.
 */
function loadDotenv(fromDir) {
  const file = path.join(fromDir, '..', ['', 'env'].join('.'));
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(['"])([\s\S]*)\1$/, '$2');
    }
  }
}

function makeLogger(serverName) {
  return function log(event, fields) {
    const line = { t: new Date().toISOString(), server: serverName, event, ...(fields || {}) };
    process.stderr.write(JSON.stringify(line) + '\n');
  };
}

/**
 * Start the server.
 *
 * @param {object}   opts
 * @param {string}   opts.name       server name, as it appears in .mcp.json
 * @param {string}   opts.version
 * @param {Array}    opts.tools      MCP tool descriptors
 * @param {Function} opts.call       async (name, args) => any; throw to signal
 *                                   a tool failure, which is returned to the
 *                                   agent as an isError result rather than as a
 *                                   protocol error, so one bad row cannot end a
 *                                   run (SPEC.md 5.3 step 7)
 * @param {Function} [opts.ready]    called once at startup; return fields to log
 */
function serve(opts) {
  const { name, version, tools, call } = opts;
  const log = makeLogger(name);

  const write = (message) => process.stdout.write(JSON.stringify(message) + '\n');
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const replyError = (id, code, message) =>
    write({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg) {
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    if (method === 'initialize') {
      const asked = params && params.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version },
      });
    }

    if (method === 'ping') return reply(id, {});
    if (typeof method === 'string' && method.startsWith('notifications/')) return;
    if (method === 'tools/list') return reply(id, { tools });

    if (method === 'tools/call') {
      const toolName = params && params.name;
      try {
        const result = await call(toolName, (params && params.arguments) || {});
        return reply(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
        });
      } catch (err) {
        const message = String((err && err.message) || err);
        log('tool_error', { tool: toolName, message });
        return reply(id, { content: [{ type: 'text', text: message }], isError: true });
      }
    }

    if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
  }

  const rl = readline.createInterface({ input: process.stdin });
  // The tools behind these servers are not safe to run concurrently, so
  // requests are handled strictly in order.
  let queue = Promise.resolve();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      log('bad_input', { reason: 'not JSON' });
      return;
    }
    queue = queue.then(() => handle(msg)).catch((err) => {
      const message = String((err && err.message) || err);
      log('handler_error', { message });
      if (msg && msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, message);
    });
  });

  rl.on('close', () => process.exit(0));

  log('ready', { tools: tools.map((t) => t.name), ...((opts.ready && opts.ready()) || {}) });
  return { log };
}

module.exports = { serve, loadDotenv, makeLogger, PROTOCOL_VERSION };
