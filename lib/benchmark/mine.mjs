// Mine Felt.AgentService for small, self-contained, SWE-bench-shaped ablation candidates:
// a commit that changes BOTH a *.test.ts (the verifier) AND 1-2 source files, with small source
// churn, headless node:test. Emit a ranked candidate table + author/Claude-trailer info.
import { spawnSync } from 'node:child_process';
const REPO = '/Users/codepanda/Felt';
const PFX = 'src/Felt.AgentService/';
const sh = (args) => spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout;

const isTest = (p) => /\.test\.ts$/.test(p) && p.includes('/tests/');
const isSrc = (p) => p.startsWith(PFX + 'src/') && p.endsWith('.ts') && !p.endsWith('.test.ts');

const raw = sh(['log', '--no-merges', '--format=__C__%H|%an|%cI|%s', '--numstat', '--', PFX]);
const commits = [];
let cur = null;
for (const line of raw.split('\n')) {
  if (line.startsWith('__C__')) {
    if (cur) commits.push(cur);
    const [sha, an, ci, ...subj] = line.slice(5).split('|');
    cur = { sha, an, ci, subj: subj.join('|'), files: [] };
  } else if (cur && /\t/.test(line)) {
    const [add, del, path] = line.split('\t');
    cur.files.push({ add: Number(add) || 0, del: Number(del) || 0, path });
  }
}
if (cur) commits.push(cur);

const cands = [];
for (const c of commits) {
  const tests = c.files.filter((f) => isTest(f.path));
  const srcs = c.files.filter((f) => isSrc(f.path));
  const other = c.files.filter((f) => !isTest(f.path) && !isSrc(f.path) && f.path.startsWith(PFX));
  if (tests.length < 1 || srcs.length < 1) continue;          // SWE-bench shape: fix + its tests
  if (srcs.length > 2) continue;                               // small: 1-2 source files
  const srcChurn = srcs.reduce((n, f) => n + f.add + f.del, 0);
  const testAdds = tests.reduce((n, f) => n + f.add, 0);
  if (srcChurn > 120) continue;                               // small source diff
  if (other.length > 0) continue;                             // no non-test/non-src AgentService files
  cands.push({ sha: c.sha, an: c.an, date: c.ci.slice(0, 10), srcChurn, nSrc: srcs.length, nTest: tests.length, testAdds, subj: c.subj, srcs: srcs.map((f) => f.path.replace(PFX + 'src/', '')), tests: tests.map((f) => f.path.replace(PFX + 'tests/', '')) });
}

// Claude-trailer check on the filtered set (so we can prefer human-authored verifiers).
for (const c of cands) {
  const body = sh(['show', '-s', '--format=%b', c.sha]);
  c.claude = /Co-Authored-By:\s*Claude|Generated with \[Claude/i.test(body) || /Claude/i.test(c.an);
}

cands.sort((a, b) => a.srcChurn - b.srcChurn);
console.log(`candidates: ${cands.length} (of ${commits.length} AgentService commits)\n`);
console.log('sha       date       churn src/test  authorTrailer  subject');
for (const c of cands.slice(0, 35)) {
  console.log(`${c.sha.slice(0, 8)}  ${c.date}  ${String(c.srcChurn).padStart(4)}  ${c.nSrc}/${c.nTest} +${c.testAdds}t  ${c.claude ? 'CLAUDE' : 'human '}  ${c.subj.slice(0, 78)}`);
}
console.log('\n--- non-Claude (human-authored verifier), churn<=80, sorted ---');
for (const c of cands.filter((c) => !c.claude && c.srcChurn <= 80).slice(0, 20)) {
  console.log(`${c.sha.slice(0, 8)}  churn ${c.srcChurn}  src[${c.srcs.join(',')}]  test[${c.tests.join(',')}]\n   ${c.subj.slice(0, 100)}`);
}
