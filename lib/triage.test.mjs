import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage, classifyRegime, wilsonInterval } from './triage.mjs';

// A fake drawAndGate that yields a scripted sequence of gate verdicts (the injected model seam).
function scripted(verdicts) {
  let i = 0;
  return async (drawId) => {
    const gate = verdicts[i] ?? 'pruned';
    i += 1;
    return { gate, candidateId: `${drawId}:${gate}` };
  };
}
const repeat = (v, n) => Array.from({ length: n }, () => v);

test('wilsonInterval is well-behaved at the boundaries', () => {
  const z = wilsonInterval(0, 0);
  assert.deepEqual(z, { point: 0, lo: 0, hi: 1 });          // no draws -> no information
  const fail1 = wilsonInterval(0, 1);
  assert.equal(fail1.lo, 0);
  assert.ok(fail1.hi > 0.79 && fail1.hi < 0.80, `hi=${fail1.hi}`);  // 0 successes never pins hi to 0
  const pass1 = wilsonInterval(1, 1);
  assert.equal(pass1.hi, 1);
  assert.ok(pass1.lo > 0.20 && pass1.lo < 0.21, `lo=${pass1.lo}`);  // n successes never pins lo to 1
});

test('classifyRegime: confident bands only, else uncertain', () => {
  assert.equal(classifyRegime(0, 0).regime, 'uncertain');          // no decisive draws
  assert.equal(classifyRegime(1, 1).regime, 'uncertain');          // one green is not yet "too-easy"
  assert.equal(classifyRegime(16, 16).regime, 'too-easy');         // Wilson lo >= 0.8
  assert.equal(classifyRegime(0, 16).regime, 'too-hard');          // Wilson hi <= 0.2
  assert.equal(classifyRegime(20, 40).regime, 'informative');      // interval confined to (0.2, 0.8)
});

test('too-easy: first draw greens -> gate-only, costX=1 (N x NOT paid, == v0)', async () => {
  const r = await triage({ drawAndGate: scripted(['green']), maxDraws: 16 });
  assert.equal(r.decision, 'gate-only');
  assert.equal(r.draws, 1);
  assert.equal(r.costX, 1);
  assert.ok(r.shipped, 'a verified green must be shipped');
  assert.equal(r.stoppedBecause, 'got-greens');
});

test('informative: greens after retries -> fanned-out, ships the green', async () => {
  const r = await triage({ drawAndGate: scripted(['pruned', 'pruned', 'green']), maxDraws: 16 });
  assert.equal(r.decision, 'fanned-out');
  assert.equal(r.draws, 3);
  assert.ok(r.shipped, 'must ship the green found on the 3rd draw');
  assert.equal(r.stoppedBecause, 'got-greens');
});

test('too-hard: confident p~0 declines EARLY (before budget) and never ships', async () => {
  const r = await triage({ drawAndGate: scripted(repeat('pruned', 50)), maxDraws: 50 });
  assert.equal(r.decision, 'declined');
  assert.equal(r.shipped, null);                 // no false-green: a decline never ships
  assert.equal(r.stoppedBecause, 'too-hard');
  assert.equal(r.draws, 16);                      // Wilson hi <= 0.2 first holds at n=16 (< the 50 budget)
  assert.ok(r.draws < 50, 'must decline early, not burn the full budget confirming 0/N');
  assert.equal(r.regime, 'too-hard');
});

test('budget is a hard ceiling; an uncertain run declines as budget, not too-hard', async () => {
  // All non-green but few draws: never confidently too-hard within a tiny budget -> budget decline.
  const r = await triage({ drawAndGate: scripted(repeat('pruned', 5)), maxDraws: 5 });
  assert.equal(r.draws, 5);
  assert.equal(r.decision, 'declined');
  assert.equal(r.shipped, null);
  assert.equal(r.stoppedBecause, 'budget');
  assert.notEqual(r.regime, 'too-hard');         // 5 fails is not enough evidence for too-hard
});

test('incomplete draws are evidence-free: never lower pSingle, never trigger too-hard', async () => {
  const r = await triage({ drawAndGate: scripted(repeat('incomplete', 20)), maxDraws: 20 });
  assert.equal(r.draws, 20);
  assert.equal(r.incompletes, 20);
  assert.equal(r.decision, 'declined');
  assert.equal(r.stoppedBecause, 'budget');      // ran to budget — NOT an early too-hard decline
  assert.notEqual(r.regime, 'too-hard');         // 20 no-evidence draws must not masquerade as p~0
  assert.equal(r.p.draws, 0);                    // zero decisive draws fed the posterior
});

test('targetGreens>1 collects a cohort for the diversity handoff', async () => {
  const r = await triage({ drawAndGate: scripted(repeat('green', 5)), maxDraws: 16, targetGreens: 3 });
  assert.equal(r.draws, 3);
  assert.equal(r.greens.length, 3);
  assert.equal(r.decision, 'fanned-out');        // >1 draw -> the N x was paid
  assert.ok(r.escalateForDispersion, 'a >=2 green cohort hints the fanoutSelect/dispersion pick');
  assert.equal(r.shipped, r.greens[0]);
});

test('a flaky author (mostly incomplete) still ships when one draw greens', async () => {
  const r = await triage({ drawAndGate: scripted(['incomplete', 'incomplete', 'green']), maxDraws: 16 });
  assert.equal(r.decision, 'fanned-out');
  assert.ok(r.shipped);
  assert.equal(r.incompletes, 2);
  assert.equal(r.draws, 3);
});

test('malformed/unknown gate verdicts are evidence-free, never decisive prunes (AR-high)', async () => {
  // A garbage gate value (infra failure, typo, unexpected enum) is NO evidence — not evidence-of-wrong.
  // 50 of them must NOT classify too-hard; they bucket as incomplete, like a flaky/no-acceptance result.
  const r = await triage({ drawAndGate: scripted(repeat('borked', 50)), maxDraws: 50 });
  assert.notEqual(r.regime, 'too-hard');
  assert.equal(r.decision, 'declined');
  assert.equal(r.stoppedBecause, 'budget');
  assert.equal(r.incompletes, 50);
  assert.equal(r.p.draws, 0);                  // zero DECISIVE draws fed the posterior
});

test('null/undefined gate is evidence-free too (AR-high)', async () => {
  const r = await triage({ drawAndGate: async (id) => ({ candidateId: id }), maxDraws: 20 });
  assert.notEqual(r.regime, 'too-hard');
  assert.equal(r.incompletes, 20);
  assert.equal(r.p.draws, 0);
});

test('targetGreens>1 NOT reached -> fanned-out-partial, not a clean cohort (AR-medium)', async () => {
  // one green then prunes: with targetGreens=3 the run stops on budget holding 1 green < 3.
  const r = await triage({ drawAndGate: scripted(['green', 'pruned', 'pruned', 'pruned']), maxDraws: 4, targetGreens: 3 });
  assert.ok(r.shipped, 'a verified green still ships — correctness is satisfied');
  assert.equal(r.targetGreensMet, false);
  assert.equal(r.decision, 'fanned-out-partial');
  assert.equal(r.stoppedBecause, 'budget');
});

test('targetGreens>1 reached -> clean fanned-out cohort, targetGreensMet true (AR-medium)', async () => {
  const r = await triage({ drawAndGate: scripted(repeat('green', 5)), maxDraws: 16, targetGreens: 3 });
  assert.equal(r.targetGreensMet, true);
  assert.equal(r.decision, 'fanned-out');
  assert.equal(r.greens.length, 3);
});

test('targetGreens>1 with a single-draw budget greens once -> fanned-out-partial, NOT gate-only (AR-medium-2)', async () => {
  // The cohort (3) is unmet; a 1-green/1-draw result must not masquerade as the v0 gate-only path.
  const r = await triage({ drawAndGate: scripted(['green']), maxDraws: 1, targetGreens: 3 });
  assert.equal(r.decision, 'fanned-out-partial');
  assert.equal(r.targetGreensMet, false);
  assert.equal(r.draws, 1);
  assert.ok(r.shipped, 'still a verified green — correctness holds');
  assert.equal(r.stoppedBecause, 'budget');
});

test('duplicate green candidateIds do not satisfy a targetGreens cohort (AR-r3)', async () => {
  // a caller that retries/caches and returns the SAME id must not inflate the dispersion cohort.
  const dup = async () => ({ gate: 'green', candidateId: 'same-id' });
  const r = await triage({ drawAndGate: dup, maxDraws: 5, targetGreens: 3 });
  assert.equal(r.greens.length, 1);             // only one DISTINCT verified candidate
  assert.equal(r.targetGreensMet, false);
  assert.equal(r.decision, 'fanned-out-partial');
  assert.equal(r.stoppedBecause, 'budget');     // never reached the distinct cohort
  assert.equal(r.escalateForDispersion, false); // one candidate can't seed a dispersion pick
});

test('a drawAndGate rejection is isolated as evidence-free, never aborts the run (AR-r3)', async () => {
  // green, throw, green, green: the throw must not crash triage; it counts as evidence-free incomplete.
  let i = 0;
  const flaky = async (id) => {
    i += 1;
    if (i === 2) throw new Error('transient gate failure');
    return { gate: 'green', candidateId: id };
  };
  const r = await triage({ drawAndGate: flaky, maxDraws: 5, targetGreens: 3 });
  assert.ok(r.greens.length >= 1, 'accumulated greens survive a mid-run throw');
  assert.ok(r.incompletes >= 1, 'the throw is counted evidence-free, not decisive');
  assert.ok(r.shipped, 'a verified green still ships despite the transient failure');
});

test('a green with a missing/invalid candidateId is malformed -> evidence-free, never shipped (AR-r4)', async () => {
  const missing = await triage({ drawAndGate: async () => ({ gate: 'green' }), maxDraws: 5, targetGreens: 1 });
  assert.equal(missing.greens.length, 0);        // no resolvable verified candidate
  assert.equal(missing.shipped, null);
  assert.equal(missing.decision, 'declined');
  assert.ok(missing.incompletes >= 1);           // bucketed evidence-free, like a malformed verdict
  const nonString = await triage({ drawAndGate: async () => ({ gate: 'green', candidateId: 42 }), maxDraws: 3 });
  assert.equal(nonString.shipped, null);
  assert.equal(nonString.decision, 'declined');
});

test('a throwing onDraw callback never aborts the policy run (AR-r4)', async () => {
  const r = await triage({ drawAndGate: scripted(['green']), maxDraws: 1, onDraw: () => { throw new Error('telemetry down'); } });
  assert.equal(r.decision, 'gate-only');
  assert.ok(r.shipped, 'a verified green still ships despite a failing observability hook');
});

test('a mutating onDraw callback cannot corrupt the returned posterior/cohort (AR-r4)', async () => {
  const r = await triage({
    drawAndGate: scripted(['green']),
    maxDraws: 1,
    onDraw: (d, res, st) => { st.p.point = 999; st.greens.push('phantom'); },
  });
  assert.notEqual(r.p.point, 999);               // the live posterior is shielded from the callback
  assert.equal(r.greens.length, 1);              // the cohort is not polluted
});

test('an async onDraw rejection is isolated too — no unhandled rejection (AR-r5)', async () => {
  const rejections = [];
  const onUnhandled = (e) => rejections.push(e);
  process.on('unhandledRejection', onUnhandled);
  const r = await triage({ drawAndGate: scripted(['green']), maxDraws: 1, onDraw: async () => { throw new Error('async telemetry down'); } });
  await new Promise((res) => setTimeout(res, 15));   // let any escaped rejection surface
  process.removeListener('unhandledRejection', onUnhandled);
  assert.equal(r.decision, 'gate-only');
  assert.ok(r.shipped, 'a verified green still ships despite a failing async telemetry hook');
  assert.equal(rejections.length, 0, 'an async onDraw rejection must be isolated, not unhandled');
});

test('a never-settling onDraw promise does not wedge the policy (AR-r6)', { timeout: 3000 }, async () => {
  const r = await triage({ drawAndGate: scripted(['green']), maxDraws: 1, onDraw: () => new Promise(() => {}) });
  assert.equal(r.decision, 'gate-only');
  assert.ok(r.shipped, 'triage resolves immediately — observability is fire-and-forget, never awaited');
});

test('drawAndGate must be a function', async () => {
  await assert.rejects(() => triage({ maxDraws: 4 }), /drawAndGate must be a function/);
});
