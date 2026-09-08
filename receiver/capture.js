#!/usr/bin/env node
// Capture receiver for the Webhook Voice Automation app (text mode).
//
// Purpose: answer PLAN.md open question "what is the exact JSON the app sends?"
// by recording one real POST. This is a local test tool, not the production
// receiver (that is the Apps Script doPost in version 0).
//
// Behaviour, mapped to CLAUDE.md rules:
//  - Rule 4:  if WEBHOOK_SECRET is set (from the environment or the gitignored
//             .env file), every request must carry it in the X-Webhook-Secret
//             header. Requests without it get 401 and only a one-line note
//             (no headers, no body) is logged.
//  - Rule 2:  the secret value is never printed. Only "matched" / "missing".
//  - Rule 11: stdout never contains transcript text. It shows the capture id,
//             content type, body size, top-level JSON keys and their value
//             types. The full request (headers with auth values redacted, and
//             the raw body) goes to receiver/captures/<id>.json, which is
//             gitignored.
//
// Run:   node receiver/capture.js            (default port 8787)
//        PORT=9000 node receiver/capture.js

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const SECRET_HEADER = 'x-webhook-secret';
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB; a long memo is a few KB
const CAPTURE_DIR = path.join(__dirname, 'captures');

const dotenvPath = path.join(__dirname, '..', ['', 'env'].join('.'));
function loadDotenv() {
  if (process.env.WEBHOOK_SECRET) return;
  let text;
  try {
    text = fs.readFileSync(dotenvPath, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?WEBHOOK_SECRET\s*=\s*(.*?)\s*$/);
    if (m) {
      process.env.WEBHOOK_SECRET = m[1].replace(/^(['"])(.*)\1$/, '$2');
      return;
    }
  }
}
loadDotenv();
const SECRET = process.env.WEBHOOK_SECRET || '';

const REDACT_HEADERS = new Set([
  SECRET_HEADER,
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
]);

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACT_HEADERS.has(k.toLowerCase()) ? '<redacted>' : v;
  }
  return out;
}

function secretStatus(headers) {
  if (!SECRET) return 'not-configured';
  const given = headers[SECRET_HEADER];
  if (typeof given !== 'string' || given.length === 0) return 'missing';
  const a = Buffer.from(given);
  const b = Buffer.from(SECRET);
  if (a.length !== b.length) return 'mismatch';
  return crypto.timingSafeEqual(a, b) ? 'matched' : 'mismatch';
}

function describeValue(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === 'string') return `string(${v.length} chars)`;
  if (typeof v === 'object') return `object{${Object.keys(v).join(',')}}`;
  return typeof v;
}

// Shape of the body without any of its content (rule 11).
function describeBody(contentType, raw) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (ct === 'application/json' || raw.trimStart().startsWith('{') || raw.trimStart().startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return { kind: 'json-array', length: parsed.length };
      const shape = {};
      for (const [k, v] of Object.entries(parsed)) shape[k] = describeValue(v);
      return { kind: 'json-object', shape };
    } catch {
      return { kind: 'invalid-json' };
    }
  }
  if (ct === 'application/x-www-form-urlencoded') {
    const shape = {};
    for (const [k, v] of new URLSearchParams(raw)) shape[k] = describeValue(v);
    return { kind: 'form', shape };
  }
  if (ct.startsWith('multipart/')) return { kind: 'multipart' };
  if (ct.startsWith('text/')) return { kind: 'text', chars: raw.length };
  return { kind: ct || 'unknown', bytes: Buffer.byteLength(raw) };
}

function log(obj) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...obj }));
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

const server = http.createServer((req, res) => {
  const id = crypto.randomBytes(6).toString('hex');
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, secret: SECRET ? 'configured' : 'not-configured' });
  }

  const auth = secretStatus(req.headers);
  if (auth === 'missing' || auth === 'mismatch') {
    // Rule 4: drop and do not log in full.
    log({ id, event: 'rejected', reason: `secret ${auth}`, method: req.method, path: url.pathname });
    req.resume();
    return send(res, 401, { ok: false, error: 'unauthorized' });
  }

  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('close', () => {
    if (tooLarge) log({ id, event: 'rejected', reason: 'body too large', bytes: size });
  });
  req.on('end', () => {
    if (tooLarge) return;
    const raw = Buffer.concat(chunks).toString('utf8');
    const contentType = req.headers['content-type'] || '';
    const shape = describeBody(contentType, raw);

    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    const file = path.join(CAPTURE_DIR, `${id}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          id,
          receivedAt: new Date().toISOString(),
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          remote: req.socket.remoteAddress,
          secret: auth,
          headers: redactHeaders(req.headers),
          bodyBytes: Buffer.byteLength(raw),
          body: raw,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    log({
      id,
      event: 'captured',
      method: req.method,
      path: url.pathname,
      query: [...url.searchParams.keys()],
      secret: auth,
      contentType,
      bodyBytes: Buffer.byteLength(raw),
      body: shape,
      file: path.relative(process.cwd(), file),
    });
    send(res, 200, { ok: true, id });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const addrs = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) addrs.push(`${name} http://${a.address}:${PORT}/memo`);
    }
  }
  log({
    event: 'listening',
    port: PORT,
    secret: SECRET ? 'configured' : 'NOT configured (set WEBHOOK_SECRET; rule 4)',
    lan: addrs,
    captures: path.relative(process.cwd(), CAPTURE_DIR),
  });
});
