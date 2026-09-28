#!/usr/bin/env node
// Bake — or audit — the level table.
//
//   node tools/bake.mjs            regenerate js/data/lots.js from the tiers
//   node tools/bake.mjs --check    re-derive every printed number; write nothing
//
// --check is what CI and the browser gate trust, so the file on disk has to agree with the graph
// on every row. Both modes rebuild the full BFS for the (n, mode) pairs the table uses: that is the
// whole cost of the promise, and it is a fraction of a second.
//
// A tier that cannot fill its quota throws instead of relaxing its predicate — see tiers.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRows, checkRows, render } from '../js/engine/library.js';
import { field } from '../js/engine/graph.js';
import { TIERS } from '../js/engine/tiers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'js', 'data', 'lots.js');
const CHECK = process.argv.includes('--check');

const now = () => Number(process.hrtime.bigint()) / 1e6;

// The published optima, for the digest line and for test/graph.test.mjs — indexed by n, so
// PUBLISHED.plain[9] === 10. Plain pancakes give P_1..P_9 = 0,1,3,4,5,7,8,9,10; burnt ones give
// B_2..B_7 = 4,6,8,10,12,14. Our burnt n=1 is 1 rather than the 0 some tables print, because a
// lone pancake may legally be turned over by itself, so that cell is left out rather than fudged.
export const PUBLISHED = {
  plain: [null, 0, 1, 3, 4, 5, 7, 8, 9, 10],
  burnt: [null, null, 4, 6, 8, 10, 12, 14],
};

async function imported() {
  const url = pathToFileURL(OUT).href + '?t=' + Date.now();
  return (await import(url)).LOTS;
}

if (CHECK) {
  if (!fs.existsSync(OUT)) {
    console.error(`no ${OUT} — run \`node tools/bake.mjs\` first`);
    process.exit(1);
  }
  const rows = await imported();
  const t = now();
  const problems = checkRows(rows);
  const ms = now() - t;
  digest(rows);
  console.log(`check: ${rows.length} rows re-derived from a fresh BFS in ${ms.toFixed(0)} ms`);
  if (problems.length) {
    for (const p of problems.slice(0, 20)) console.log('  MISMATCH ' + p);
    console.log(`FAIL ${problems.length} row(s) disagree with the graph`);
    process.exit(1);
  }
  console.log('OK every printed par / starts / detour / stack matches the distance field');
  process.exit(0);
}

const rows = buildRows();
const problems = checkRows(rows);
if (problems.length) {
  for (const p of problems.slice(0, 20)) console.log('  MISMATCH ' + p);
  console.error('refusing to write a table that does not check out');
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, render(rows));

// Read back what actually landed, so a render bug (a dropped field, a mis-quoted key) is caught
// here rather than by the browser.
const again = await imported();
const after = checkRows(again);
if (after.length || again.length !== rows.length) {
  for (const p of after.slice(0, 20)) console.log('  REREAD MISMATCH ' + p);
  console.error(`${OUT} does not re-read cleanly`);
  process.exit(1);
}
digest(again);
console.log(`wrote ${OUT} (${again.length} rows)`);

function digest(list) {
  const byTier = new Map();
  for (const r of list) {
    if (!byTier.has(r.tier)) byTier.set(r.tier, []);
    byTier.get(r.tier).push(r);
  }
  for (const t of TIERS) {
    const rs = byTier.get(t.id) || [];
    if (!rs.length) {
      console.log(`  ${t.id.padEnd(7)} EMPTY — the ladder is broken here`);
      continue;
    }
    const pars = rs.map((r) => r.par).sort((a, b) => a - b);
    const starts = rs.map((r) => r.starts);
    console.log(
      `  ${t.id.padEnd(7)} ${String(rs.length).padStart(2)} rows  n=${[...new Set(rs.map((r) => r.n))].join(',')}  ` +
        `mode=${[...new Set(rs.map((r) => r.mode))].join(',')}  par ${pars[0]}..${pars[pars.length - 1]}  ` +
        `starts ${Math.min(...starts)}..${Math.max(...starts)}  detour ${Math.max(...rs.map((r) => r.detour))}`
    );
  }
  const keys = [...new Set(list.map((r) => `${r.n}|${r.mode}`))].sort();
  for (const k of keys) {
    const [n, mode] = k.split('|');
    const f = field(Number(n), mode === 'burnt');
    const pub = PUBLISHED[mode][Number(n)];
    console.log(
      `  graph n=${n} ${mode.padEnd(5)}: ${f.reached}/${f.size} positions, diameter ${f.diameter}` +
        (pub === null || pub === undefined ? '' : f.diameter === pub ? ` (= published ${pub})` : ` (! published says ${pub})`)
    );
  }
}
