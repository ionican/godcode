#!/usr/bin/env node
// dossier-cli — turnkey CLI for the live HTML status page (the "one source of truth" dossier).
//
// So `/godcode` can AUTOMATICALLY create + drive the status page on every invocation with one-line,
// fire-and-forget commands — no hand-written node scripts. Each subcommand is its own process: it
// loads run.json, applies one mutation, and re-renders index.html atomically (so a browser refresh
// shows live progress). Run from the vault root; `--dir` (or `--id`, which defaults the dir to
// `_godcode/runs/<id>`) is the run directory, which is ALSO the vault-relative path the HTTPS URL uses.
//
// Examples (the skill drives these):
//   node dossier-cli.mjs init --id <slug> --objective "<obj>" --request '/godcode "<req>"' \
//        --status clarifying --milestones '[{"id":"m1","title":"Clarify"},{"id":"m2","title":"Build"}]'
//        → prints the HTTPS URL to hand to the user
//   node dossier-cli.mjs start      --id <slug> --milestone m2
//   node dossier-cli.mjs discovery  --id <slug> --text "constructed verifier certified"
//   node dossier-cli.mjs candidate  --id <slug> --json '{"id":"author-1","angle":"minimal"}'
//   node dossier-cli.mjs candidate-update --id <slug> --candidate author-1 --json '{"verdict":"green","detail":"18/18"}'
//   node dossier-cli.mjs decide     --id <slug> --json '{"question":"…","chosen":"…","rationale":"…","adjudicator":"board"}'
//   node dossier-cli.mjs done       --id <slug> --milestone m2
//   node dossier-cli.mjs finish     --id <slug> --json '{"decision":"shipped-slate","tier":"factual-evidence-pass","summary":"…"}'
//   node dossier-cli.mjs url        --id <slug>
import path from 'node:path';
import { RunDossier } from './dossier.mjs';

const RUNS_BASE = '_godcode/runs';

// Value flags REQUIRE a value (`--k v` or `--k=v`); a bare `--k` (or one followed by another `--`) is an
// error for these, not a silent boolean `true` that gets written as the value (AR). Everything else is a
// boolean switch.
const VALUE_FLAGS = new Set(['dir', 'id', 'objective', 'request', 'status', 'milestones', 'clarify', 'json', 'milestone', 'state', 'kind', 'text', 'candidate']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) { out[body.slice(0, eq)] = body.slice(eq + 1); continue; }  // --k=value (value may start with -)
      const key = body;
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(key)) {
        if (next === undefined || next.startsWith('--')) fail(`--${key} requires a value`);
        out[key] = next; i++;
      } else {
        out[key] = true;  // boolean switch
      }
    } else out._.push(a);
  }
  return out;
}

function fail(msg) { process.stderr.write('dossier-cli: ' + msg + '\n'); process.exit(2); }
function reqStr(a, key) {
  if (typeof a[key] !== 'string' || a[key] === '') fail(`need --${key} <value>`);
  return a[key];
}
function reqJson(a, key) {
  if (typeof a[key] !== 'string') fail(`need --${key} '<json>'`);
  try { return JSON.parse(a[key]); } catch (e) { fail(`invalid --${key} JSON: ${e.message}`); }
}
// A run --id must be a SINGLE safe path segment (no separators, no dot-segments) so it cannot escape
// _godcode/runs/<id> (AR path-traversal).
function safeId(id) {
  // single path segment: starts alphanumeric or '_', then [A-Za-z0-9._-]; never a separator or dot-segment.
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(id) || id.includes('..') || id.includes('/') || id.includes('\\')) {
    fail(`--id ${JSON.stringify(id)} must be a single slug (letters/digits/._- , no separators or dot-segments)`);
  }
  return id;
}
// The vault-relative path the HTTPS URL needs — robust whether --dir is relative or absolute.
function vaultRel(dir) {
  const m = String(dir).match(/_godcode\/runs\/[^/]+/);
  return m ? m[0] : dir;
}

const [cmd, ...rest] = process.argv.slice(2);
const a = parseArgs(rest);
const dir = a.dir || (a.id ? path.join(RUNS_BASE, safeId(String(a.id))) : null);

if (!cmd || cmd === 'help') {
  process.stdout.write('usage: node dossier-cli.mjs <init|milestones|start|done|log|discovery|clarify|decide|candidate|candidate-update|finish|url|render> (--dir <run-dir> | --id <slug>) [opts]\n');
  process.exit(cmd ? 0 : 2);
}
if (!dir) fail('need --dir <run-dir> or --id <slug>');

try {
  switch (cmd) {
    case 'init': {
      const d = RunDossier.open({ dir, id: a.id, objective: a.objective || '', request: a.request || '' });
      // On a NEW run, apply all provided init metadata. On an EXISTING run, PRESERVE progress: only fill
      // an EMPTY objective/request; never reset status/milestones/clarifications (unless --replace) (AR).
      const apply = d.wasCreated || a.replace === true;
      if (a.objective && (apply || !d.state.objective)) d.state.objective = String(a.objective);
      if (a.request && (apply || !d.state.request)) d.state.request = String(a.request);
      if (a.status && apply) d.state.status = String(a.status);
      d.persist();
      if (a.milestones && apply) d.setMilestones(JSON.parse(a.milestones));
      if (a.clarify && apply) d.setClarifications(JSON.parse(a.clarify));
      process.stdout.write(d.url(vaultRel(dir)) + '\n');
      break;
    }
    case 'milestones': { RunDossier.load(dir).setMilestones(reqJson(a, 'json')); break; }
    case 'start': { RunDossier.load(dir).startMilestone(reqStr(a, 'milestone')); break; }
    case 'done': { RunDossier.load(dir).finishMilestone(reqStr(a, 'milestone'), a.state ? String(a.state) : 'done'); break; }
    case 'log': { RunDossier.load(dir).log(a.kind ? String(a.kind) : 'info', a.text ? String(a.text) : ''); break; }
    case 'discovery': { RunDossier.load(dir).discovery(reqStr(a, 'text')); break; }
    case 'clarify': { RunDossier.load(dir).setClarifications(reqJson(a, 'json')); break; }
    case 'decide': { RunDossier.load(dir).decide(reqJson(a, 'json')); break; }
    case 'candidate': { const id = RunDossier.load(dir).addCandidate(reqJson(a, 'json')); process.stdout.write(id + '\n'); break; }
    case 'candidate-update': { RunDossier.load(dir).updateCandidate(reqStr(a, 'candidate'), reqJson(a, 'json')); break; }
    case 'finish': { RunDossier.load(dir).finish(reqJson(a, 'json')); break; }
    case 'url': { process.stdout.write(RunDossier.load(dir).url(vaultRel(dir)) + '\n'); break; }
    case 'render': { RunDossier.load(dir).persist(); break; }
    default: fail(`unknown command ${JSON.stringify(cmd)}`);
  }
} catch (e) {
  fail(e && e.message ? e.message : String(e));
}
