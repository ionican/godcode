// dossier — the live HTML "source of truth" for ANY /godcode run.
//
// Every /godcode invocation opens a RunDossier. It anchors the VERBATIM original request, lays out
// the milestones, and records progress / discoveries / candidate verdicts / the final outcome as the
// run proceeds. It persists atomically as two files in a run directory:
//
//   run.json    — the machine state (the single source of truth; resume-able via RunDossier.load)
//   index.html  — a self-contained render of that state (no external deps, no build step)
//
// Served by the vault deck-server (0.0.0.0:8765, static-over-Tailscale), a run at
// `_godcode/runs/<id>/` is live at `http://<host>:8765/_godcode/runs/<id>/`. The page embeds the
// current state for first paint (works over file:// too) AND polls run.json — so a browser left open,
// or a manual refresh, shows live progress at any stage of delivery.
//
// This is DOMAIN-GENERAL on purpose: a run is "an objective + milestones + candidates + an outcome",
// whether the objective is code, a question, research, or a design. Nothing here assumes a language
// or a test runner — the verifier TIER the run reaches (A executable / B constructed-floor /
// C advisory-slate) is just an honesty label the renderer surfaces.
//
// Honesty is encoded in the vocabulary, never laundered: a candidate is `admitted` ONLY when an
// out-of-band verifier said so; everything else is `rejected` / `inconclusive` / `pending`. Status
// and verdict are shown by GLYPH + LABEL (colour is a secondary cue only — never the sole signal).
import { writeFileSync, renameSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'godcode/dossier@1';

// ── helpers ──────────────────────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function slugify(s, max = 48) {
  const base = String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (base || 'run').slice(0, max).replace(/-+$/g, '');
}

function londonStamp(iso) {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Europe/London', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return String(iso ?? ''); }
}

// Vocabularies — glyph + label so meaning never depends on colour alone (colour-blind safe).
const MILESTONE = {
  pending: { g: '◌', l: 'Pending', c: 'mPending' },
  active: { g: '▶', l: 'In progress', c: 'mActive' },
  done: { g: '✓', l: 'Done', c: 'mDone' },
  skipped: { g: '⊘', l: 'Skipped', c: 'mSkipped' },
  blocked: { g: '⚠', l: 'Blocked', c: 'mBlocked' },
};
const VERDICT = {
  pending: { g: '◌', l: 'Pending', c: 'vPending' },
  admitted: { g: '✓', l: 'Admitted', c: 'vAdmitted' },
  rejected: { g: '✗', l: 'Rejected', c: 'vRejected' },
  inconclusive: { g: '◷', l: 'Inconclusive', c: 'vInconclusive' },
};
// Typed confidence contract (Codex AR 2026-06-28, highest-leverage change): every shipped result
// carries exactly ONE of these, strictly ordered, with the artifact that justifies it — so advisory
// search can never be rendered as "verification".
const TIER = {
  'repo-verified': { g: '✓', l: "REPO-VERIFIED — passed the repo's own pre-existing suite" },
  'constructed-floor-pass': { g: '◆', l: 'CONSTRUCTED-FLOOR-PASS — passed a constructed, mutation+traceability-validated floor' },
  'factual-evidence-pass': { g: '◈', l: 'FACTUAL-EVIDENCE-PASS — primary-source / executable fact-check' },
  'proxy-ranked': { g: '⊞', l: 'PROXY-RANKED — admissible, ordered by pre-declared objective proxies' },
  'advisory-slate': { g: '?', l: 'ADVISORY-SLATE — no verifier; decorrelated breadth + ranking only' },
};
// Back-compat / ergonomic aliases for the old A/B/C/advisory labels.
const TIER_ALIAS = { A: 'repo-verified', B: 'constructed-floor-pass', C: 'proxy-ranked', advisory: 'advisory-slate' };

// The VERIFIED tiers (a real out-of-band pass). Used by the render guard that flags a page claiming one
// of these with NO supporting candidate evidence (display honesty — AR).
const VERIFIED_TIERS = new Set(['repo-verified', 'constructed-floor-pass', 'factual-evidence-pass']);

// Per-process monotonic counter for unique persist() temp-file names (concurrent-writer safety — AR).
let TMP_SEQ = 0;
const normTier = (t) => (t && TIER_ALIAS[t]) || t;
const STATUS = {
  planning: 'Planning', running: 'Running', shipped: 'Shipped',
  slate: 'Slate — awaiting your pick', declined: 'Declined', advisory: 'Advisory', error: 'Error',
};
const EVENT_GLYPH = {
  info: '·', discovery: '✸', draw: '⊕', gate: '⟐', decision: '◎',
  escalation: '↑', outcome: '★', warn: '⚠',
};

// ── pure renderer ────────────────────────────────────────────────────────────
export function renderDossier(state) {
  const s = state || {};
  const ms = Array.isArray(s.milestones) ? s.milestones : [];
  const cands = Array.isArray(s.candidates) ? s.candidates : [];
  const finds = Array.isArray(s.findings) ? s.findings : [];
  const events = Array.isArray(s.events) ? s.events : [];
  const clars = Array.isArray(s.clarifications) ? s.clarifications : [];
  const decisions = Array.isArray(s.decisions) ? s.decisions : [];
  const done = ms.filter((m) => m.state === 'done').length;
  const total = ms.length || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const statusLabel = STATUS[s.status] || s.status || 'Running';
  const tierKey = normTier(s.tier);
  const tier = tierKey && TIER[tierKey] ? TIER[tierKey] : null;

  const milestoneRows = ms.map((m) => {
    const v = MILESTONE[m.state] || MILESTONE.pending;
    const when = m.endedAt ? `done ${londonStamp(m.endedAt)}` : m.startedAt ? `started ${londonStamp(m.startedAt)}` : '';
    return `<li class="m ${v.c}">
      <span class="mGlyph" title="${esc(v.l)}">${v.g}</span>
      <span class="mBody"><span class="mTitle">${esc(m.title)}</span>${m.detail ? `<span class="mDetail">${esc(m.detail)}</span>` : ''}</span>
      <span class="mState">${esc(v.l)}${when ? ` · <span class="muted">${esc(when)}</span>` : ''}</span>
    </li>`;
  }).join('\n');

  const candRows = cands.map((c) => {
    const v = VERDICT[c.verdict] || VERDICT.pending;
    const metrics = c.metrics && Object.keys(c.metrics).length
      ? `<div class="cMetrics">${Object.entries(c.metrics).map(([k, val]) => `<span class="metric"><span class="muted">${esc(k)}</span> ${esc(val)}</span>`).join('')}</div>` : '';
    // A verdict is only as honest as its gate artifact. Render the evidence; flag an `admitted`
    // candidate that carries none (AR finding 9 — the page must not assert more than the run proved).
    const e = c.evidence;
    const ev = e && (e.cmd || e.commit || e.exit !== undefined || e.digest || e.verifier)
      ? `<div class="cEvidence muted" title="gate artifact — the verdict is rendered from this">⟐ ${[
          e.cmd ? `cmd <code>${esc(String(e.cmd).slice(0, 70))}</code>` : '',
          e.commit ? `@${esc(String(e.commit).slice(0, 10))}` : '',
          e.exit !== undefined ? `exit ${esc(e.exit)}` : '',
          e.digest ? `digest ${esc(String(e.digest).slice(0, 12))}` : '',
          e.verifier ? `verifier ${esc(e.verifier)}` : '',
        ].filter(Boolean).join(' · ')}</div>`
      : (c.verdict === 'admitted' ? `<div class="cEvidence evWarn">⚠ admitted without a gate artifact — attach evidence</div>` : '');
    return `<tr class="${v.c}">
      <td class="cVerdict"><span class="vGlyph" title="${esc(v.l)}">${v.g}</span> ${esc(v.l)}</td>
      <td class="cId">${esc(c.id)}</td>
      <td class="cAngle">${esc(c.angle || '')}${c.detail ? `<div class="muted cDetail">${esc(c.detail)}</div>` : ''}${metrics}${ev}</td>
    </tr>`;
  }).join('\n');

  const findRows = finds.map((f) => `<li><span class="fGlyph">✸</span><span>${esc(f.text)}</span><span class="muted fWhen">${esc(londonStamp(f.ts))}</span></li>`).join('\n');

  const clarBlock = clars.length ? `<div class="clar"><span class="lab">Clarifications — the one upfront round (then autonomous)</span>
    <dl>${clars.map((c) => `<dt>${esc(c.q)}</dt><dd>${esc(c.a) || '<span class="muted">(unanswered — proceeding on documented assumption)</span>'}</dd>`).join('')}</dl></div>` : '';

  const decRows = decisions.map((d) => {
    const opts = d.options && d.options.length
      ? `<div class="dOpts">${d.options.map((o) => `<span class="dOpt${o === d.chosen ? ' chosen' : ''}">${o === d.chosen ? '◎ ' : ''}${esc(o)}</span>`).join('')}</div>` : '';
    const refs = d.references && d.references.length ? `<div class="muted dRefs">refs: ${d.references.map(esc).join(' · ')}</div>` : '';
    const board = d.board && d.board.length
      ? `<details class="dBoard"><summary>board of experts (${d.board.length})</summary><ul>${d.board.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></details>` : '';
    return `<div class="dec">
      <div class="dQ"><span class="decG">◎</span> ${esc(d.question)}</div>
      ${opts}
      <div class="dChosen"><b>Chosen:</b> ${esc(d.chosen)}${d.adjudicator ? ` <span class="muted">· adjudicator: ${esc(d.adjudicator)}</span>` : ''}</div>
      ${d.rationale ? `<div class="dRat">${esc(d.rationale)}</div>` : ''}
      ${refs}${board}
      <div class="muted dWhen">${esc(londonStamp(d.ts))}</div>
    </div>`;
  }).join('\n');

  const eventRows = events.slice().reverse().map((e) => {
    const g = EVENT_GLYPH[e.kind] || '·';
    return `<li class="ev ev-${esc(e.kind)}"><span class="evWhen muted">${esc(londonStamp(e.ts))}</span><span class="evGlyph" title="${esc(e.kind)}">${g}</span><span class="evText">${esc(e.text)}</span></li>`;
  }).join('\n');

  // DISPLAY-HONESTY GUARD (AR): if the page claims a VERIFIED tier (or 'shipped' status) but NO candidate
  // carries a green/admitted gate-evidence artifact, it must not read as a confirmed gate result. Flag it
  // conspicuously (glyph + text, colour-blind safe) — the same discipline as the per-candidate evidence flag.
  const hasEvidencedPass = Array.isArray(s.candidates) && s.candidates.some(
    (c) => (c.verdict === 'green' || c.verdict === 'admitted') && c.evidence && typeof c.evidence === 'object');
  const claimsVerified = VERIFIED_TIERS.has(s.tier) || s.status === 'shipped';
  const verifiedWarn = (claimsVerified && !hasEvidencedPass)
    ? `<div class="oWarn">⚠ Page claims a verified tier${s.tier ? ` (${esc(s.tier)})` : ''} but carries no candidate with a gate-evidence artifact — display only, not a confirmed gate result.</div>` : '';

  const outcome = s.outcome ? (() => {
    const o = s.outcome;
    const caveats = Array.isArray(o.caveats) && o.caveats.length
      ? `<ul class="caveats">${o.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '';
    const slate = Array.isArray(o.slate) && o.slate.length
      ? `<div class="slate"><div class="slateHead">Ranked slate — you choose:</div><ol>${o.slate.map((it) => `<li><b>${esc(it.id)}</b>${it.note ? ` — ${esc(it.note)}` : ''}</li>`).join('')}</ol></div>` : '';
    return `<div class="outcome">
      <div class="oDecision">${esc(o.decision || s.status)}</div>
      ${o.summary ? `<p class="oSummary">${esc(o.summary)}</p>` : ''}
      ${o.confidence ? `<div class="oConf"><span class="muted">Confidence ceiling:</span> ${esc(o.confidence)}</div>` : ''}
      ${slate}
      ${caveats ? `<div class="oCaveats"><span class="muted">Caveats / what is NOT claimed:</span>${caveats}</div>` : ''}
    </div>`;
  })() : `<p class="muted">No outcome yet — run in progress.</p>`;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>godcode · ${esc(s.objective || s.slug || s.id || 'run')}</title>
<style>
  :root{--bg:#0f1115;--panel:#171a21;--panel2:#1d212b;--ink:#e6e9ef;--mut:#8b93a4;--line:#2a2f3a;
        --ok:#3fb950;--bad:#f85149;--warn:#d29922;--inc:#58a6ff;--accent:#a371f7;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
  .wrap{max-width:1000px;margin:0 auto;padding:24px 20px 64px;}
  .brand{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--mut);letter-spacing:.04em;text-transform:uppercase;}
  .live{display:inline-flex;align-items:center;gap:6px;margin-left:auto;text-transform:none;letter-spacing:0;}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 0 rgba(63,185,80,.6);animation:pulse 2s infinite;}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(63,185,80,.5)}70%{box-shadow:0 0 0 7px rgba(63,185,80,0)}100%{box-shadow:0 0 0 0 rgba(63,185,80,0)}}
  h1{font-size:23px;margin:14px 0 2px;font-weight:650;}
  .sub{color:var(--mut);font-size:14px;margin-bottom:18px;}
  .request{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);
           border-radius:8px;padding:14px 16px;margin:0 0 20px;white-space:pre-wrap;font-size:14px;color:#d6dae3;}
  .request .lab,.clar .lab{display:block;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;}
  .clar{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--inc);border-radius:8px;padding:12px 16px;margin:0 0 20px;}
  .clar dl{margin:0;}.clar dt{font-weight:600;font-size:13.5px;}.clar dd{margin:2px 0 10px;color:#c9d1d9;font-size:13.5px;}.clar dd:last-child{margin-bottom:0;}
  .decisions{display:flex;flex-direction:column;gap:10px;}
  .dec{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:11px 14px;}
  .dQ{font-weight:600;margin-bottom:6px;}.decG{color:var(--accent);}
  .dOpts{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;}
  .dOpt{font-size:12.5px;padding:1px 9px;border-radius:999px;border:1px solid var(--line);color:var(--mut);background:var(--panel2);}
  .dOpt.chosen{color:var(--ink);border-color:var(--accent);font-weight:600;}
  .dChosen{font-size:13.5px;}.dRat{font-size:13.5px;color:#c9d1d9;margin-top:5px;}
  .dRefs,.dWhen{font-size:12px;margin-top:5px;}.dBoard{margin-top:6px;font-size:12.5px;}.dBoard summary{cursor:pointer;color:var(--mut);}
  .dBoard ul{margin:6px 0 0 16px;}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px;}
  @media(max-width:720px){.grid{grid-template-columns:1fr}}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;}
  .card h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:0 0 10px;font-weight:600;}
  .statusPill{display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid var(--line);background:var(--panel2);font-size:13px;}
  .tier{margin-top:10px;font-size:13px;}.tier .tg{font-weight:700;margin-right:6px;}
  .bar{height:8px;background:var(--panel2);border-radius:6px;overflow:hidden;margin:8px 0 4px;border:1px solid var(--line);}
  .bar>i{display:block;height:100%;background:var(--accent);width:${pct}%;}
  .muted{color:var(--mut);}
  ul.ms{list-style:none;margin:0;padding:0;}
  li.m{display:grid;grid-template-columns:24px 1fr auto;gap:10px;align-items:start;padding:9px 0;border-top:1px solid var(--line);}
  li.m:first-child{border-top:none;}
  .mGlyph{font-size:16px;text-align:center;line-height:1.4;}
  .mTitle{display:block;font-weight:550;}.mDetail{display:block;color:var(--mut);font-size:13px;}
  .mState{font-size:12.5px;color:var(--ink);white-space:nowrap;}
  .mDone .mGlyph{color:var(--ok);}.mActive .mGlyph{color:var(--inc);}.mBlocked .mGlyph{color:var(--warn);}
  .mPending .mGlyph,.mSkipped .mGlyph{color:var(--mut);}.mSkipped .mTitle{text-decoration:line-through;color:var(--mut);}
  table{width:100%;border-collapse:collapse;font-size:13.5px;}
  th{text-align:left;color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:0 8px 8px;}
  td{padding:9px 8px;border-top:1px solid var(--line);vertical-align:top;}
  .cVerdict{white-space:nowrap;font-weight:550;}.vGlyph{font-size:15px;}
  .vAdmitted .cVerdict{color:var(--ok);}.vRejected .cVerdict{color:var(--bad);}
  .vInconclusive .cVerdict{color:var(--inc);}.vPending .cVerdict{color:var(--mut);}
  .cId{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9d1d9;}
  .cMetrics{margin-top:5px;display:flex;flex-wrap:wrap;gap:4px 12px;}.metric{font-size:12px;}
  .cEvidence{font-size:12px;margin-top:5px;}.cEvidence code{font-size:11px;}.evWarn{color:var(--warn);}
  ul.finds{list-style:none;margin:0;padding:0;}
  ul.finds li{display:grid;grid-template-columns:20px 1fr auto;gap:8px;padding:7px 0;border-top:1px solid var(--line);font-size:13.5px;}
  ul.finds li:first-child{border-top:none;}.fGlyph{color:var(--accent);}.fWhen{font-size:12px;}
  ul.log{list-style:none;margin:0;padding:0;font-size:13px;}
  li.ev{display:grid;grid-template-columns:auto 18px 1fr;gap:8px;padding:5px 0;border-top:1px solid var(--line);}
  li.ev:first-child{border-top:none;}.evWhen{font-size:12px;white-space:nowrap;}.evGlyph{text-align:center;}
  .ev-discovery .evGlyph{color:var(--accent);}.ev-gate .evGlyph{color:var(--inc);}.ev-outcome .evGlyph{color:var(--warn);}
  .ev-warn .evGlyph{color:var(--warn);}.ev-decision .evGlyph,.ev-escalation .evGlyph{color:var(--accent);}
  .oWarn{background:#3a2a00;border:1px solid var(--warn);color:#ffe9b0;padding:9px 13px;border-radius:6px;margin-bottom:10px;font-weight:600;font-size:13px;}
  .outcome{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:14px 16px;}
  .oDecision{font-size:16px;font-weight:650;margin-bottom:4px;}
  .slate{margin-top:10px;}.slate .slateHead{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;}
  .caveats{margin:4px 0 0 18px;}.oCaveats,.oConf{margin-top:10px;font-size:13.5px;}
  .legend{margin-top:24px;font-size:12px;color:var(--mut);border-top:1px solid var(--line);padding-top:12px;}
  .legend b{color:var(--ink);font-weight:600;}
  footer{margin-top:18px;font-size:12px;color:var(--mut);}
  section{margin-bottom:20px;}h2.sec{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:0 0 10px;}
</style></head>
<body><div class="wrap">
  <div class="brand"><span>godcode · run dossier</span>
    <span class="live"><span class="dot"></span><span>live · rev ${esc(s.rev || 0)} · updated <span id="upd">${esc(londonStamp(s.updatedAt))}</span></span></span>
  </div>
  <h1>${esc(s.objective || '(objective pending)')}</h1>
  <div class="sub">run <code>${esc(s.id || s.slug || '')}</code> · opened ${esc(londonStamp(s.createdAt))}</div>

  <div class="request"><span class="lab">Original request — the anchor</span>${esc(s.request || '')}</div>
  ${clarBlock}

  <div class="grid">
    <div class="card">
      <h2>Status</h2>
      <span class="statusPill">${esc(statusLabel)}</span>
      ${tier ? `<div class="tier"><span class="tg">${tier.g}</span>${esc(tier.l)}</div>` : `<div class="tier muted">Verifier tier: not yet determined</div>`}
    </div>
    <div class="card">
      <h2>Progress</h2>
      <div><b>${done}</b> / ${total} milestones · ${pct}%</div>
      <div class="bar"><i></i></div>
    </div>
  </div>

  <section><h2 class="sec">Milestones</h2>
    <ul class="ms">${milestoneRows || '<li class="muted">No milestones set yet.</li>'}</ul>
  </section>

  ${decisions.length ? `<section><h2 class="sec">Decisions — autonomous, adjudicated (board of experts → adjudicator)</h2>
    <div class="decisions">${decRows}</div></section>` : ''}

  <section><h2 class="sec">Candidates — the fan-out</h2>
    ${cands.length ? `<table><thead><tr><th>Verdict</th><th>ID</th><th>Approach / detail</th></tr></thead><tbody>${candRows}</tbody></table>`
      : '<p class="muted">No candidates drawn yet.</p>'}
  </section>

  ${finds.length ? `<section><h2 class="sec">Discoveries</h2><ul class="finds">${findRows}</ul></section>` : ''}

  <section><h2 class="sec">Outcome</h2>${verifiedWarn}${outcome}</section>

  <section><h2 class="sec">Activity log</h2>
    <ul class="log">${eventRows || '<li class="muted">No events yet.</li>'}</ul>
  </section>

  <div class="legend">
    <b>Honesty key.</b> Verdicts: <b>✓ Admitted</b> = an out-of-band verifier passed it · <b>✗ Rejected</b> = it failed ·
    <b>◷ Inconclusive</b> = no decisive verdict (setup/flake) · <b>◌ Pending</b>. Tiers:
    <b>✓ repo-verified</b> › <b>◆ constructed-floor-pass</b> › <b>◈ factual-evidence-pass</b> › <b>⊞ proxy-ranked</b> ›
    <b>? advisory-slate</b> — the typed confidence contract: every result carries exactly one, with the artifact
    that justifies it (so advisory search is never rendered as "verification"). A candidate is never Admitted on a
    model's opinion — only on an executed verifier, and its verdict is rendered from that gate artifact (⟐).
    <b>◎ Decisions</b> are made autonomously after the single clarification round — by a board of experts + an
    adjudicator, bound to the request + clarifications. They resolve interpretation/approach, never code
    correctness (the executable gate owns that).
  </div>
  <footer>Single source of truth for this /godcode run. This page auto-refreshes; reload anytime to see the latest. Schema ${esc(s.schema || SCHEMA)}.</footer>
</div>
<script>
  // Live update: poll run.json; if updatedAt changed, reload (the server re-renders index.html on
  // every state mutation, so a reload always shows fresh, fully-rendered state). Fails silent over file://.
  (function(){
    var seen=${JSON.stringify(s.updatedAt || '')};
    function rel(iso){try{var d=(Date.now()-new Date(iso).getTime())/1000;if(d<60)return Math.max(0,Math.round(d))+'s ago';
      if(d<3600)return Math.round(d/60)+'m ago';return Math.round(d/3600)+'h ago';}catch(e){return '';}}
    var el=document.getElementById('upd');var base=seen;
    function tick(){if(el&&base){var r=rel(base);if(r)el.textContent=r;}}
    setInterval(tick,1000);tick();
    async function poll(){try{
      var res=await fetch('run.json?_='+Date.now(),{cache:'no-store'});
      if(res.ok){var j=await res.json();if(j&&j.updatedAt&&j.updatedAt!==seen){location.reload();}}
    }catch(e){/* file:// or offline — static state still shown */}}
    setInterval(poll,4000);
  })();
</script>
</body></html>`;
}

// ── the run dossier (stateful, persists on every mutation) ───────────────────
export class RunDossier {
  constructor({ dir, request = '', objective = '', id, slug } = {}) {
    if (!dir) throw new Error('RunDossier: dir is required');
    this.dir = dir;
    const sl = slug || slugify(objective || request);
    this.state = {
      schema: SCHEMA,
      id: id || sl,
      slug: sl,
      request: String(request),
      objective: String(objective),
      tier: null,
      status: 'planning',
      rev: 0,               // monotonic state revision (AR finding 10) — for display + stale-view detection
      createdAt: nowIso(),
      updatedAt: nowIso(),
      clarifications: [],   // the SINGLE upfront human round (q + a); immutable once answered
      milestones: [],
      decisions: [],        // autonomous adjudicated decisions made AFTER clarification (the audit trail)
      candidates: [],
      findings: [],
      events: [],
      outcome: null,
    };
    this.persist();
  }

  static load(dir) {
    const p = path.join(dir, 'run.json');
    if (!existsSync(p)) throw new Error(`RunDossier.load: no run.json in ${dir}`);
    const state = JSON.parse(readFileSync(p, 'utf8'));
    const d = Object.create(RunDossier.prototype);
    d.dir = dir; d.state = state;
    return d;
  }

  // Load the dossier at `dir` if it already exists (e.g. created by `dossier-cli init` at run start),
  // else create a fresh one. Lets the skill spin the page up immediately AND a later in-process driver
  // (orchestrateProse) continue the SAME page without clobbering the anchored request/objective.
  static open({ dir, request = '', objective = '', id, slug } = {}) {
    if (!dir) throw new Error('RunDossier.open: dir is required');
    if (existsSync(path.join(dir, 'run.json'))) {
      const d = RunDossier.load(dir);
      d.wasCreated = false;   // loaded an existing run — callers must NOT clobber its progress
      let changed = false;
      if (request && !d.state.request) { d.state.request = String(request); changed = true; }
      if (objective && !d.state.objective) { d.state.objective = String(objective); changed = true; }
      if (changed) { d._touch(); d.persist(); }
      return d;
    }
    const d = new RunDossier({ dir, request, objective, id, slug });
    d.wasCreated = true;
    return d;
  }

  // Strictly-monotonic updatedAt: the page's poll loop detects change by `updatedAt !== seen`, so two
  // mutations in the same millisecond must still produce distinct stamps or a live update is missed.
  _touch() {
    let t = nowIso();
    if (this.state.updatedAt && t <= this.state.updatedAt) {
      t = new Date(new Date(this.state.updatedAt).getTime() + 1).toISOString();
    }
    this.state.updatedAt = t;
  }

  persist() {
    this.state.rev = (this.state.rev || 0) + 1;
    mkdirSync(this.dir, { recursive: true });
    const json = path.join(this.dir, 'run.json');
    const html = path.join(this.dir, 'index.html');
    // PER-PROCESS temp names (AR): a shared `.tmp` collides under concurrent writers (rename race +
    // mismatched HTML). pid + a monotonic seq makes each writer's temp file unique.
    const sfx = `.tmp.${process.pid}.${TMP_SEQ++}`;
    const tj = json + sfx;
    const th = html + sfx;
    writeFileSync(tj, JSON.stringify(this.state, null, 2));
    renameSync(tj, json);
    writeFileSync(th, renderDossier(this.state));
    renameSync(th, html);
    return this;
  }

  setObjective(o) { this.state.objective = String(o); if (!this.state.slug) this.state.slug = slugify(o); this._touch(); return this.persist(); }
  setStatus(s) { this.state.status = s; this._touch(); return this.persist(); }

  // The ONE upfront clarification round — recorded first-class alongside the request. After this the
  // harness goes autonomous; further ambiguity is resolved by decide() (the board + adjudicator), never
  // by re-asking the human.
  setClarifications(list) {
    this.state.clarifications = (list || []).map((c) => ({ q: String(c.q ?? ''), a: String(c.a ?? '') }));
    this.log('info', `clarification round closed — ${this.state.clarifications.length} answered`);
    return this;
  }
  addClarification(q, a) {
    this.state.clarifications.push({ q: String(q), a: String(a ?? '') });
    return this.log('info', `clarified: ${q}`);
  }

  // Record an autonomous adjudicated decision (board-of-experts + adjudicator). Bound to the anchored
  // request + clarifications ONLY: it resolves interpretation/approach ambiguity, never invents scope,
  // and NEVER judges candidate correctness (that stays the executable gate). This is the documented
  // audit trail the protocol requires — visible on the source-of-truth page so any choice is auditable.
  decide(d = {}) {
    const dec = {
      ts: nowIso(),
      question: String(d.question ?? ''),
      options: Array.isArray(d.options) ? d.options.map(String) : [],
      chosen: String(d.chosen ?? ''),
      rationale: String(d.rationale ?? ''),
      references: Array.isArray(d.references) ? d.references.map(String) : [],
      board: Array.isArray(d.board) ? d.board.map(String) : [],
      adjudicator: String(d.adjudicator ?? ''),
    };
    this.state.decisions.push(dec);
    this.log('decision', `◎ ${dec.question} → ${dec.chosen}`);
    return dec;
  }

  setMilestones(list) {
    this.state.milestones = (list || []).map((m, i) => ({
      id: m.id || `m${i + 1}`,
      title: String(m.title ?? m.id ?? `Milestone ${i + 1}`),
      detail: m.detail ? String(m.detail) : '',
      state: m.state || 'pending',
      startedAt: m.startedAt || null,
      endedAt: m.endedAt || null,
    }));
    this._touch(); return this.persist();
  }

  _milestone(id) { return this.state.milestones.find((m) => m.id === id); }

  startMilestone(id) {
    const m = this._milestone(id);
    if (m) { m.state = 'active'; m.startedAt = m.startedAt || nowIso(); this.log('info', `▶ ${m.title}`); }
    return this.persist();
  }

  finishMilestone(id, state = 'done') {
    const m = this._milestone(id);
    if (m) { m.state = state; m.endedAt = nowIso(); this.log('info', `${(MILESTONE[state] || MILESTONE.done).g} ${m.title} — ${(MILESTONE[state] || MILESTONE.done).l}`); }
    return this.persist();
  }

  log(kind, text) {
    this.state.events.push({ ts: nowIso(), kind: kind || 'info', text: String(text) });
    this._touch(); return this.persist();
  }

  discovery(text) {
    this.state.findings.push({ ts: nowIso(), text: String(text) });
    return this.log('discovery', text);
  }

  addCandidate(c = {}) {
    const cand = {
      id: String(c.id ?? `cand-${this.state.candidates.length + 1}`),
      angle: c.angle ? String(c.angle) : '',
      verdict: c.verdict || 'pending',
      detail: c.detail ? String(c.detail) : '',
      metrics: c.metrics && typeof c.metrics === 'object' ? c.metrics : {},
      evidence: c.evidence && typeof c.evidence === 'object' ? c.evidence : null,  // the gate artifact (AR 9)
    };
    this.state.candidates.push(cand);
    this.log('draw', `candidate ${cand.id}${cand.angle ? ` (${cand.angle})` : ''}`);
    return cand.id;
  }

  updateCandidate(id, patch = {}) {
    const c = this.state.candidates.find((x) => x.id === id);
    if (c) {
      const prev = c.verdict;
      Object.assign(c, patch);
      if (patch.metrics) c.metrics = { ...c.metrics, ...patch.metrics };
      if (patch.verdict && patch.verdict !== prev) {
        const v = VERDICT[patch.verdict] || VERDICT.pending;
        this.log('gate', `${id}: ${v.g} ${v.l}${patch.detail ? ` — ${patch.detail}` : ''}`);
      } else { this._touch(); this.persist(); }
    }
    return this;
  }

  finish(outcome = {}) {
    this.state.outcome = {
      decision: outcome.decision || 'done',
      summary: outcome.summary || '',
      confidence: outcome.confidence || '',
      slate: Array.isArray(outcome.slate) ? outcome.slate : null,
      bestFailing: outcome.bestFailing || null,
      caveats: Array.isArray(outcome.caveats) ? outcome.caveats : [],
    };
    const t = normTier(outcome.tier);
    if (t) this.state.tier = t;
    const decision = outcome.decision || 'done';
    this.state.status = outcome.status || (
      decision === 'declined' ? 'declined'
        : (t === 'repo-verified' || t === 'constructed-floor-pass' || t === 'factual-evidence-pass') ? 'shipped'
          : t === 'proxy-ranked' ? 'slate'
            : t === 'advisory-slate' ? 'advisory'
              : 'shipped'
    );
    this.log('outcome', `★ ${this.state.outcome.decision}${this.state.outcome.summary ? ` — ${this.state.outcome.summary}` : ''}`);
    return this.persist();
  }

  // The HTTPS deck-server URL for this run (tailscale-fronted; valid cert, tailnet-only), given the
  // vault-relative dir (e.g. "_godcode/runs/<id>"). The page's poll uses a RELATIVE fetch, so it
  // inherits this scheme automatically — no mixed content. http base passable via opts for local use.
  url(vaultRelDir, { base = 'https://codepandas-mac-studio.tailf809db.ts.net:8766' } = {}) {
    const rel = String(vaultRelDir).replace(/^\/+|\/+$/g, '');
    return `${String(base).replace(/\/+$/, '')}/${rel}/`;
  }
}

export { slugify, esc as escapeHtml, SCHEMA };

// ── CLI: render a run.json to index.html (or demo) ───────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = process.argv[2];
  if (arg && existsSync(arg)) {
    const dir = arg.endsWith('.json') ? path.dirname(arg) : arg;
    const d = RunDossier.load(dir);
    d.persist();
    console.log(`rendered ${path.join(dir, 'index.html')}`);
  } else {
    console.error('usage: node dossier.mjs <run-dir|run.json>   (re-renders index.html from run.json)');
    process.exit(64);
  }
}
