#!/usr/bin/env node
// Run the SPEC.md section 7 test set against the agent prompt.
//
// Checks the routing decision only. It hands the fixture memos straight to the
// model with the real prompt plus the classify-only override, with MCP off and
// every built-in tool denied, so nothing touches the Sheet, Slack or the web.
// That makes it runnable before the receiver is deployed, which is the point:
// the prompt is the agent, and this is how you tell whether it works.
//
// Cases 1 to 12 are here. Case 13 tests the receiver's secret check and lives in
// test/check-receiver.sh.
//
// Usage:
//   node test/run-fixtures.mjs                 one pass
//   node test/run-fixtures.mjs --runs 2        the acceptance bar in SPEC.md 7
//   node test/run-fixtures.mjs --case 9,11     just those spec cases
//   node test/run-fixtures.mjs --model opus    pick the model
//   node test/run-fixtures.mjs --keep          write the decisions to test/results
//
// Exits 0 only if every selected case passes in every run.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------- args */

function parseArgs(argv) {
  const out = { runs: 1, cases: null, model: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') out.runs = Number(argv[++i]) || 1;
    else if (a === '--case' || a === '--cases') {
      out.cases = new Set(String(argv[++i]).split(',').map((s) => Number(s.trim())));
    } else if (a === '--model') out.model = argv[++i];
    else if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/* ------------------------------------------------------------- the prompt */

const testSet = JSON.parse(readFileSync(join(ROOT, 'fixtures/test-set.json'), 'utf8'));
const selected = testSet.memos.filter(
  (m) => !args.cases || args.cases.has(m.expect.spec_case),
);
if (!selected.length) {
  console.error('No fixtures matched --case.');
  process.exit(2);
}

const agentPrompt = readFileSync(join(ROOT, 'prompts/process-new-memos.md'), 'utf8');
const testOverride = readFileSync(join(ROOT, 'prompts/classify-only.md'), 'utf8');
const memosForModel = selected.map(({ id, received_at, transcript }) => ({
  id,
  received_at,
  transcript,
}));

const prompt = [
  agentPrompt,
  '\n\n---\n\n',
  testOverride,
  '```json\n',
  JSON.stringify(memosForModel, null, 2),
  '\n```\n',
].join('');

/* ------------------------------------------------------------ run the CLI */

function runClaude() {
  return new Promise((resolve, reject) => {
    const cliArgs = [
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', '4',
      // No MCP servers, and no built-in tool that could reach the network or
      // the disk. The override says do not call tools; this makes it true.
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '--disallowedTools',
      'Bash,Read,Write,Edit,WebSearch,WebFetch,Glob,Grep,Task,NotebookEdit',
    ];
    if (args.model) cliArgs.push('--model', args.model);

    const child = spawn('claude', cliArgs, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude did not finish within ${TIMEOUT_MS / 60000} minutes`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${stderr.trim().slice(0, 500)}`));
      }
      resolve(stdout);
    });
  });
}

/** Pull the decision array out of whatever the model wrapped it in. */
function extractDecisions(cliOutput) {
  let text = cliOutput;
  try {
    const envelope = JSON.parse(cliOutput);
    if (envelope && typeof envelope.result === 'string') text = envelope.result;
    else if (Array.isArray(envelope)) return envelope;
  } catch {
    /* not the envelope; fall through and scan the raw text */
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch { /* keep scanning */ }
  }
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }
  throw new Error('No JSON array of decision records in the output.');
}

/* ------------------------------------------------------------- the checks */

function check(memo, decision) {
  const e = memo.expect;
  const fails = [];
  if (!decision) return ['no decision record returned for this memo'];

  if (decision.route !== e.route) {
    fails.push(`route is "${decision.route}", expected "${e.route}"`);
  }
  if (e.confidence && decision.confidence !== e.confidence) {
    fails.push(`confidence is "${decision.confidence}", expected "${e.confidence}"`);
  }

  const flags = Array.isArray(decision.flags) ? decision.flags : [];
  for (const f of e.flags_include || []) {
    if (!flags.includes(f)) fails.push(`flag "${f}" is missing (got ${flags.join(', ') || 'none'})`);
  }
  for (const f of e.flags_exclude || []) {
    if (flags.includes(f)) fails.push(`flag "${f}" should not be set`);
  }

  const dm = String(decision.dm_text || '');
  for (const pattern of e.dm_matches || []) {
    if (!new RegExp(pattern).test(dm)) fails.push(`DM does not match /${pattern}/`);
  }
  for (const pattern of e.dm_not_matches || []) {
    if (new RegExp(pattern).test(dm)) fails.push(`DM should not match /${pattern}/`);
  }
  if (e.dm_matches_any && !e.dm_matches_any.some((p) => new RegExp(p, 'i').test(dm))) {
    fails.push(`DM matches none of: ${e.dm_matches_any.join(', ')}`);
  }

  // Version 1: which writes the memo calls for, and whether they wait for a reply.
  const writes = Array.isArray(decision.writes_planned) ? decision.writes_planned : [];
  for (const w of e.writes_planned_include || []) {
    if (!writes.includes(w)) fails.push(`writes_planned lacks "${w}" (got ${writes.join(', ') || 'none'})`);
  }
  for (const w of e.writes_planned_exclude || []) {
    if (writes.includes(w)) fails.push(`writes_planned must not include "${w}"`);
  }
  if (e.writes_planned_empty && writes.length) {
    fails.push(`writes_planned must be empty (got ${writes.join(', ')})`);
  }
  if (typeof e.needs_confirmation === 'boolean' && decision.needs_confirmation !== e.needs_confirmation) {
    fails.push(`needs_confirmation is ${JSON.stringify(decision.needs_confirmation)}, expected ${e.needs_confirmation}`);
  }

  const got = decision.extracted || {};
  for (const [field, want] of Object.entries(e.extracted || {})) {
    if (field === 'question_matches') {
      const q = String(got.question || '');
      for (const p of want) {
        if (!new RegExp(p, 'i').test(q)) fails.push(`extracted.question does not match /${p}/i`);
      }
      continue;
    }
    const actual = got[field] === undefined ? null : got[field];
    if (want === null) {
      if (actual !== null && actual !== '') fails.push(`extracted.${field} is "${actual}", expected null`);
    } else if (String(actual) !== String(want)) {
      fails.push(`extracted.${field} is "${actual}", expected "${want}"`);
    }
  }

  return fails;
}

/* -------------------------------------------------------------- reporting */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

async function onePass(n) {
  process.stderr.write(`${DIM}run ${n}: asking the model to classify ${selected.length} memos…${OFF}\n`);
  const raw = await runClaude();
  const decisions = extractDecisions(raw);
  const byId = new Map(decisions.map((d) => [d.id, d]));

  let passed = 0;
  const rows = [];
  for (const memo of selected) {
    const fails = check(memo, byId.get(memo.id));
    if (!fails.length) passed++;
    rows.push({ memo, fails });
  }

  for (const { memo, fails } of rows) {
    const label = `case ${String(memo.expect.spec_case).padStart(2)}  ${memo.expect.route.padEnd(8)}`;
    if (!fails.length) {
      console.log(`${GREEN}pass${OFF}  ${label}`);
    } else {
      console.log(`${RED}FAIL${OFF}  ${label}`);
      for (const f of fails) console.log(`        ${f}`);
    }
  }
  console.log(`\nrun ${n}: ${passed}/${selected.length} passed\n`);

  if (args.keep) {
    const dir = join(ROOT, 'test/results');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(decisions, null, 2));
    console.log(`${DIM}decisions written to ${file.replace(ROOT + '/', '')}${OFF}\n`);
  }

  return passed === selected.length;
}

let allPassed = true;
for (let n = 1; n <= args.runs; n++) {
  try {
    if (!(await onePass(n))) allPassed = false;
  } catch (err) {
    console.error(`${RED}run ${n} could not complete:${OFF} ${err.message}`);
    allPassed = false;
  }
}

if (allPassed) {
  console.log(`${GREEN}All ${selected.length} cases passed in ${args.runs} run(s).${OFF}`);
  if (args.runs >= 2 && !args.cases) {
    console.log('That is the routing half of the SPEC.md section 7 bar. Case 13 is test/check-receiver.sh.');
  }
} else {
  console.log(`${RED}Not passing.${OFF} Fix the prompt in prompts/process-new-memos.md and run again.`);
}
process.exit(allPassed ? 0 : 1);
