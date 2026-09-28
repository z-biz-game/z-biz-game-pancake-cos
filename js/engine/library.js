// The shipped level table, in code: build it, check it, render it.
//
// tools/bake.mjs is a thin CLI over this file and the browser reads the generated js/data/lots.js,
// so there is exactly one implementation of "what makes a level" and no hand-copied numbers to go
// stale. `checkRows` is the gate the CI runs, and it re-derives everything from the distance field:
// par, optimal-start count, detour, the printed stack, the printed burnt sides. A row whose stored
// numbers disagree with the table it was measured from is a hard failure, not a warning.

import { TIERS, tierSpecs } from './tiers.js';
import { field } from './graph.js';
import { sample, measure, labelStack, burntSides, stackOf } from './make.js';

export const SEED_BASE = 20260928;

export function buildRows() {
  const rows = [];
  const exclude = new Set();
  TIERS.forEach((tier) => {
    let k = 0;
    tier.specs.forEach((spec, si) => {
      const found = sample(spec.n, spec.burnt, spec.want, {
        seed: SEED_BASE + 101 * TIERS.indexOf(tier) + 7 * si,
        exclude,
        ok: spec.ok,
      });
      if (found.length < spec.want) {
        throw new Error(
          `tier ${tier.id} spec ${si} (n=${spec.n} ${spec.burnt ? 'burnt' : 'plain'}) filled ${found.length}/${spec.want} — the predicate is unreachable, not relaxed`
        );
      }
      for (const f of found) {
        rows.push(rowOf(tier, k++, f));
      }
    });
  });
  return rows;
}

function rowOf(tier, k, m) {
  return {
    id: `pk-${tier.id}-${k + 1}`,
    tier: tier.id,
    tierName: tier.name,
    mode: m.burnt ? 'burnt' : 'plain',
    n: m.n,
    code: m.code,
    par: m.par,
    starts: m.starts,
    detour: m.detour,
    stack: labelStack(m.code, m.n, !!m.burnt),
    burnt: m.burnt ? burntSides(m.code, m.n) : [],
  };
}

// Re-derive every field of every row from the distance field. Returns the list of complaints;
// empty means the table on disk says nothing the graph does not.
// `quotas: false` checks only the per-row facts. A single sampled level has no table to fill, and
// applying the campaign's row counts to it would report every tier as short.
export function checkRows(rows, opts = {}) {
  const quotas = opts.quotas !== false;
  const problems = [];
  const fields = new Map();
  const F = (n, burnt) => {
    const key = `${n}|${burnt}`;
    if (!fields.has(key)) fields.set(key, field(n, burnt));
    return fields.get(key);
  };
  const ids = new Set();
  const perTier = new Map();
  for (const r of rows) {
    const burnt = r.mode === 'burnt';
    // Both shapes the game actually mints: `pk-<tier>-<k>` from the campaign and
    // `pk-<tier>-r<seed36>` from random play. checkRows runs over sampled rows too, so rejecting
    // the second shape here would mean the infinite mode has never been through the gate.
    if (!/^pk-[a-z]+-(\d+|r[0-9a-z]+)$/.test(r.id)) problems.push(`${r.id}: id is neither pk-<tier>-<k> nor pk-<tier>-r<seed>`);
    if (ids.has(r.id)) problems.push(`${r.id}: duplicate id`);
    ids.add(r.id);
    perTier.set(r.tier, (perTier.get(r.tier) || 0) + 1);
    if (r.code < 0 || r.code >= F(r.n, burnt).size) {
      problems.push(`${r.id}: code ${r.code} outside the ${r.mode} n=${r.n} state space`);
      continue;
    }
    const m = measure(F(r.n, burnt), r.code);
    if (m.par !== r.par) problems.push(`${r.id}: par says ${r.par}, graph says ${m.par}`);
    if (m.starts !== r.starts) problems.push(`${r.id}: starts says ${r.starts}, graph says ${m.starts}`);
    if (m.detour !== r.detour) problems.push(`${r.id}: detour says ${r.detour}, graph says ${m.detour}`);
    if (r.par <= 0) problems.push(`${r.id}: shipped a level that is already solved (par ${r.par})`);
    const stack = labelStack(r.code, r.n, burnt);
    if (stack.join(',') !== r.stack.join(',')) {
      problems.push(`${r.id}: printed stack [${r.stack}] is not what code ${r.code} decodes to [${stack}]`);
    }
    const sides = burnt ? burntSides(r.code, r.n) : [];
    if (sides.join(',') !== (r.burnt || []).join(',')) {
      problems.push(`${r.id}: printed burnt sides [${r.burnt}] disagree with [${sides}]`);
    }
    // A row must land in its own tier's window: that is the ladder being what it claims.
    const spec = (tierSpecs(r.tier).find((s) => s.n === r.n && !!s.burnt === burnt) || {});
    if (spec.ok && !spec.ok(m, r.code)) {
      problems.push(`${r.id}: par=${m.par} starts=${m.starts} is outside the ${r.tier} predicate`);
    }
  }
  if (quotas) {
    for (const t of TIERS) {
      const want = t.specs.reduce((a, s) => a + s.want, 0);
      const got = perTier.get(t.id) || 0;
      if (got !== want) problems.push(`tier ${t.id}: ${got} rows on disk, ${want} promised`);
    }
  }
  for (const [, f] of fields) {
    if (!f.complete) problems.push(`graph n=${f.n} ${f.burnt ? 'burnt' : 'plain'} reached ${f.reached}/${f.size}`);
  }
  return problems;
}

// A fresh position for one tier, measured exactly like a baked row. `seed` comes from the URL or
// from the date, never from the clock at sample time, so "再来一局" can be replayed by hand.
export function sampleLevel(tierId, seed) {
  const specs = tierSpecs(tierId);
  if (!specs.length) return null;
  const spec = specs[Math.abs(seed | 0) % specs.length];
  const tier = TIERS.find((t) => t.id === tierId);
  const found = sample(spec.n, spec.burnt, 1, { seed: (seed >>> 0) ^ 0x9e3779b9, ok: spec.ok });
  if (!found.length) return null;
  const f = found[0];
  f.n = spec.n;
  f.burnt = spec.burnt;
  const row = rowOf(tier, 0, f);
  return { ...row, id: `pk-${tierId}-r${(seed >>> 0).toString(36)}`, seed: seed >>> 0 };
}

export function positionOf(row) {
  const burnt = row.mode === 'burnt';
  const { order, bits } = stackOf(row.code, row.n, burnt);
  return { order: Array.from(order), bits, burnt };
}

export function render(rows) {
  const body = rows
    .map((r) =>
      '  ' +
      JSON.stringify({
        id: r.id, tier: r.tier, tierName: r.tierName, mode: r.mode, n: r.n,
        code: r.code, par: r.par, starts: r.starts, detour: r.detour,
        stack: r.stack, burnt: r.burnt,
      })
    )
    .join(',\n');
  return `// Generated by tools/bake.mjs — do not hand-edit, run \`node tools/bake.mjs\` and re-check.
//
// Every number in here is a measurement over the complete prefix-reversal graph of that (n, mode),
// produced by js/engine/tiers.js + js/engine/make.js and re-derived by \`node tools/bake.mjs --check\`:
//   par     — the true minimum number of flips, from a BFS that visited all n! (or 2^n·n!) stacks
//   starts  — how many legal first flips keep you on a shortest path; 1 means every other click is
//             a mistake you will pay for, and the screen does not say which
//   detour  — 1 + max over first flips of par(after) - par, the cost of the worst opening move
//   stack   — sizes 1..n, smallest first, top of the stack first: a rendering of \`code\`, checked
//             against it, not a second source of truth
//
// SEED_BASE ${SEED_BASE}; the sampler is seeded, so the same code re-derives the same table.
export const LOTS = [
${body},
];

export const MEASURED_DIAMETER = ${JSON.stringify(diameters(rows))};
`;
}

export function diameters(rows) {
  const seen = new Set(rows.map((r) => `${r.n}|${r.mode}`));
  const out = {};
  for (const key of [...seen].sort()) {
    const [n, mode] = key.split('|');
    const f = field(Number(n), mode === 'burnt');
    out[key] = { diameter: f.diameter, states: f.size };
  }
  return out;
}
