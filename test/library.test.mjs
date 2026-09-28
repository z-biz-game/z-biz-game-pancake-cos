// The shipped table against the graph, and against itself.
//
// `node tools/bake.mjs --check` runs checkRows() in CI; this suite runs the same function over the
// file that is actually in the repo, and adds the two things the check does not: that rebuilding
// from js/engine/tiers.js reproduces the file byte-for-byte in content (so nobody hand-edited a
// par), and that the ladder is monotone in the measurements it claims to be monotone in.

import { suite } from '../tools/harness.mjs';
import { checkRows, buildRows, sampleLevel, SEED_BASE } from '../js/engine/library.js';
import { TIERS, tierIdOf, tierSpecs } from '../js/engine/tiers.js';
import { LOTS, MEASURED_DIAMETER } from '../js/data/lots.js';
import { field } from '../js/engine/graph.js';

const t = suite('library');

t.where('the file on disk');
{
  const problems = checkRows(LOTS);
  t.eq(`${LOTS.length} rows re-derived from a fresh BFS: ${problems.slice(0, 3).join(' | ')}`, problems.length, 0);
  t.ok('more than a dozen levels ship', LOTS.length >= 20);
  t.eq('every id is unique', new Set(LOTS.map((r) => r.id)).size, LOTS.length);
  t.ok('no level ships already solved', LOTS.every((r) => r.par > 0));
  // starts is a count over legal flips: between 1 (the brutal rungs) and n-minFlip+1 (the wide
  // ones). detour 0 is legal and means the opposite of a trap: every first move shortens the stack.
  t.ok('every row reports a sane opening count and detour',
    LOTS.every((r) => r.starts >= 1 && r.starts <= r.n - (r.mode === 'burnt' ? 1 : 2) + 1 && r.detour >= 0));
  t.eq('tier ids on rows all resolve', LOTS.every((r) => tierIdOf(r.id) === r.tier), true);
  t.ok('burnt rows carry a side per pancake, plain rows carry none',
    LOTS.every((r) => r.burnt.length === (r.mode === 'burnt' ? r.n : 0)));
}

t.where('the baked file is what the generator produces');
{
  const fresh = buildRows();
  t.eq('same row count', fresh.length, LOTS.length);
  const a = JSON.stringify(fresh);
  const b = JSON.stringify(LOTS);
  t.eq('and every field of every row (SEED_BASE ' + SEED_BASE + ')', a === b ? 'identical' : firstDiff(a, b), 'identical');
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `row content diverges at char ${i}: generated …${a.slice(i, i + 60)} vs disk …${b.slice(i, i + 60)}`;
}

t.where('the ladder is measured, not adjectived');
{
  const byTier = new Map();
  for (const r of LOTS) {
    if (!byTier.has(r.tier)) byTier.set(r.tier, []);
    byTier.get(r.tier).push(r);
  }
  for (const tier of TIERS) {
    const rows = byTier.get(tier.id) || [];
    const want = tier.specs.reduce((a, s) => a + s.want, 0);
    t.eq(`${tier.id}: ${want} rows promised`, rows.length, want);
    // Every row must satisfy its own tier's predicate — the check does this too, but only for the
    // spec whose (n, mode) matches; here a row in the wrong tier would slip past silently.
    for (const r of rows) {
      const spec = tier.specs.find((s) => s.n === r.n && !!s.burnt === (r.mode === 'burnt'));
      t.ok(`${r.id}: found by a ${tier.id} spec`, !!spec);
    }
  }
  const med = (rows) => {
    const p = rows.map((r) => r.par).sort((x, y) => x - y);
    return p[Math.floor((p.length - 1) / 2)];
  };
  const plain = TIERS.map((x) => x.id).filter((id) => (byTier.get(id) || [])[0].mode === 'plain');
  for (let i = 1; i < plain.length; i++) {
    t.ok(
      `plain rung ${plain[i]} (median par ${med(byTier.get(plain[i]))}) is not easier than ${plain[i - 1]} (${med(byTier.get(plain[i - 1]))})`,
      med(byTier.get(plain[i])) > med(byTier.get(plain[i - 1]))
    );
  }
  const burnt = TIERS.map((x) => x.id).filter((id) => (byTier.get(id) || [])[0].mode === 'burnt');
  for (let i = 1; i < burnt.length; i++) {
    t.ok(
      `burnt rung ${burnt[i]} (median par ${med(byTier.get(burnt[i]))}) is not easier than ${burnt[i - 1]} (${med(byTier.get(burnt[i - 1]))})`,
      med(byTier.get(burnt[i])) > med(byTier.get(burnt[i - 1]))
    );
  }
  // The top of each mode's ladder is the "unique opening" rung: exactly one of the legal first
  // flips is right, and the count of such rows is a property of the graph, not of the sampler.
  for (const id of ['exp', 'master']) {
    const rows = byTier.get(id);
    const uniq = rows.filter((r) => r.starts === 1).length;
    t.ok(`${id}: ${rows.length} rows, ${uniq} with a unique optimal opening`, uniq >= 2);
  }
}

t.where('random play carries the same promise');
for (const tier of TIERS) {
  const seen = new Set();
  let allValid = true;
  let firstProblem = '';
  for (let i = 0; i < 6; i++) {
    const seed = 4242 + i * 977;
    const row = sampleLevel(tier.id, seed);
    if (!row) {
      allValid = false;
      firstProblem = `seed ${seed} produced no level`;
      continue;
    }
    const problems = checkRows([row], { quotas: false });
    if (problems.length) {
      allValid = false;
      firstProblem = `seed ${seed}: ${problems[0]}`;
    }
    if (sampleLevel(tier.id, seed).code !== row.code) {
      allValid = false;
      firstProblem = `seed ${seed} is not reproducible`;
    }
    seen.add(row.code);
  }
  t.eq(`${tier.id}: 6 sampled levels all measure out and repeat`, firstProblem || 'ok', 'ok');
  t.ok(`${tier.id}: the sampler is not pinned to one stack (${seen.size} distinct over 6 seeds)`, seen.size >= 2);
  // A tier drawn from a cell the graph only populates three times *must* collide; that is a fact
  // about the maths, so the test states the population instead of pretending the sampler broke.
  if (tier.id === 'appr') t.eq('appr: 3 of 6 seeds repeat, because n=4 has only 3 stacks at par 4', seen.size, 3);
}
  // And a tier drawn from a wide cell must not collide at all: n=7/par-7 has 281 candidates.
  t.eq('exp: 6 seeds, 6 different stacks', new Set(Array.from({ length: 6 }, (_, i) => sampleLevel('exp', 4242 + i * 977).code)).size, 6);
t.eq('an unknown tier samples nothing', sampleLevel('nope', 1), null);
t.ok('tierSpecs() agrees with TIERS', TIERS.every((x) => tierSpecs(x.id).length === x.specs.length));
t.eq('a level id that is not ours resolves to no tier', tierIdOf('lot-3'), null);

t.where('the diameter block matches the tables the rows need');
{
  // Keys in the data file are "<n>|plain" / "<n>|burnt". Compared as pairs of {n, mode} objects,
  // because a stringified boolean ('false') is truthy and a split-and-rejoin here already cost one
  // passing test the wrong lookup.
  const need = new Map();
  for (const r of LOTS) need.set(`${r.n}|${r.mode}`, { n: r.n, mode: r.mode });
  const have = new Map();
  for (const key of Object.keys(MEASURED_DIAMETER)) {
    const [n, mode] = key.split('|');
    have.set(key, { n: Number(n), mode });
  }
  t.eq('same (n, mode) pairs', [...need.keys()].sort().join(' '), [...have.keys()].sort().join(' '));
  for (const [key, { n, mode }] of need) {
    const f = field(n, mode === 'burnt');
    const entry = MEASURED_DIAMETER[key];
    t.eq(`${key}: states counted`, entry.states, f.size);
    t.eq(`${key}: diameter`, entry.diameter, f.diameter);
    t.ok(`${key}: every par in that table is inside the graph's diameter`,
      LOTS.filter((r) => `${r.n}|${r.mode}` === key).every((r) => r.par <= f.diameter));
  }
}

t.done();
