// Turning the distance field into level design: measure a stack, and sample stacks that measure
// out the way a tier wants.
//
// Two numbers besides `par` describe how nasty a position is, and both are read off the same table:
//   starts  — how many legal first flips stay on a shortest path. One of them means the player has
//             to find the single right spatula insertion out of n-1 (or n) candidates, and nothing
//             on the screen tells them which.
//   detour  — how many extra flips the *worst* first move costs, i.e. max over legal k of
//             1 + par(after k) - par. A detour of 4 says a careless opening is recoverable but
//             expensive; that is a property of the position, not a difficulty opinion.

import { decode, encode, flip, rng, minFlip } from './perms.js';
import { field } from './graph.js';

export function stackOf(code, n, burnt) {
  const order = new Uint8Array(n);
  const avail = new Uint8Array(n);
  const bits = decode(code, n, burnt, order, avail);
  return { order, bits };
}

// Sizes 1..n, smallest first, top of the stack first — what a human counts on the picture.
export function labelStack(code, n, burnt) {
  const { order } = stackOf(code, n, burnt);
  return Array.from(order, (v) => v + 1);
}

export function burntSides(code, n) {
  const mod = 1 << n;
  const bits = code % mod;
  const out = [];
  for (let i = 0; i < n; i++) out.push((bits >> i) & 1);
  return out;
}

export function measure(f, code) {
  const { n, burnt } = f;
  const { order, bits } = stackOf(code, n, burnt);
  const par = f.distAt(code);
  const scratch = new Uint8Array(n);
  scratch.set(order);
  let starts = 0;
  // -1, not par: a position whose every legal flip shortens the stack really does have detour 0,
  // and clamping the accumulator to par would round that up to 1 and hide the case.
  let worst = -1;
  for (let k = minFlip(burnt); k <= n; k++) {
    const nb = flip(scratch, bits, k, burnt);
    const d = f.distAt(encode(scratch, nb, n, burnt));
    if (d === par - 1) starts++;
    if (d > worst) worst = d;
    flip(scratch, nb, k, burnt);
  }
  return { par, starts, detour: 1 + worst - par };
}

// Deterministic sampler: seeded rejection over the code space. Never Math.random — a level table
// that redraws itself between the bake run and the browser run is not a table.
// `opts.ok(measure, code)` is the tier filter; a position that fails it is not collected.
export function sample(n, burnt, want, opts = {}) {
  const f = field(n, burnt);
  const ok = opts.ok || (() => true);
  const rand = rng(opts.seed >>> 0);
  const seen = opts.exclude || new Set();
  const out = [];
  let tries = 0;
  const maxTries = opts.maxTries || 400000;
  while (out.length < want && tries < maxTries) {
    tries++;
    const code = Math.floor(rand() * f.size);
    if (seen.has(code)) continue;
    const m = measure(f, code);
    if (ok(m, code)) {
      out.push({ code, n, burnt, ...m });
      seen.add(code);
    }
  }
  return out;
}

export { field };
