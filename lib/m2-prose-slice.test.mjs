// m2-prose-slice.test — the M2 prose-QA FIRST SLICE proof, end-to-end and DETERMINISTIC.
//
// Runs runProseSlice over a real temp base repo + scripted candidate worktrees (no author
// agents, no LLM) and asserts the FULL chain the slice claims: the RED baseline is red (the
// wrong answer fails the constructed oracle), EVERY claim's anti-candidate is killed by its
// own checkId, the tier RE-DERIVES to 'factual-evidence-pass', and the GOOD candidate gates
// GREEN (the correct answer ships).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProseSlice } from './m2-prose-slice.mjs';
import { proseExample } from './prose-verifier.mjs';

test('M2 prose slice: red baseline red, all anti-candidates killed, factual-evidence-pass, good ships', async () => {
  const work = mkdtempSync(path.join(tmpdir(), 'gc-m2-prose-'));
  try {
    const r = await runProseSlice(work);

    // RED baseline discriminates — the wrong answer FAILS the constructed oracle.
    assert.equal(r.redBaselineRed, true, 'red baseline must be red (wrong answer fails the oracle)');

    // EVERY claim's anti-candidate is killed by its checkId — no undetected hole.
    const ex = proseExample();
    assert.equal(r.requirements.length, ex.claims.length, 'one requirement per claim');
    for (const req of r.requirements) {
      assert.equal(req.killed, true, `requirement ${req.id} must be killed by its anti-candidate`);
    }
    // The requirement ids match the example's claim ids exactly.
    assert.deepEqual(
      r.requirements.map((q) => q.id).sort(),
      ex.claims.map((c) => c.id).sort(),
      'requirement ids must be exactly the claim ids',
    );

    // Tier RE-DERIVED honestly from kills + red baseline + valid certificate.
    assert.equal(r.certified, true, 'a fully-killing, red-discriminating run must certify');
    assert.equal(r.tier, 'factual-evidence-pass', 'tier must be the constructed-prose ceiling');

    // The GOOD candidate gates GREEN — the correct answer ships against the same oracle.
    assert.equal(r.goodCandidateGreen, true, 'the correct answer must green the gate (ship)');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
