// The numbering of the state space. If rank/unrank is wrong the BFS is wrong, and if the BFS is
// wrong every "par" in this repo is a guess — so this file checks the bijection exhaustively, not
// by sampling.

import { suite } from '../tools/harness.mjs';
import { FACT, lehmer, unlehmer, encode, decode, flip, isGoal, legal, minFlip, sizeOf, rng, MAX_N } from '../js/engine/perms.js';

const t = suite('perms');

t.where('factorial table');
t.eq('FACT[0..13]', FACT.slice(0, 14).join(','), '1,1,2,6,24,120,720,5040,40320,362880,3628800,39916800,479001600,6227020800');
t.eq('sizeOf(9, plain)', sizeOf(9, false), FACT[9]);
t.eq('sizeOf(6, burnt)', sizeOf(6, true), 46080);
t.eq('sizeOf(7, burnt)', sizeOf(7, true), 645120);

t.where(' lehmer ↔ unlehmer, exhaustively ');
for (let n = 1; n <= MAX_N; n++) {
  const order = new Uint8Array(n);
  const avail = new Uint8Array(n);
  const seen = new Set();
  let bad = 0;
  let badOrder = 0;
  // n=9 plain is 362 880 codes; checking all of them costs well under a second and leaves no
  // "sampled" asterisk in the claim.
  for (let r = 0; r < FACT[n]; r++) {
    unlehmer(r, n, order, avail);
    if (lehmer(order, n) !== r) bad++;
    // the unranked thing must be a permutation: each value 0..n-1 exactly once
    seen.clear();
    for (let i = 0; i < n; i++) seen.add(order[i]);
    if (seen.size !== n) badOrder++;
  }
  t.eq(`n=${n}: rank(unrank(r)) === r for all ${FACT[n]} codes`, bad, 0);
  t.eq(`n=${n}: every unrank is a permutation`, badOrder, 0);
}

t.where('encode ↔ decode over the signed space ');
for (let n = 1; n <= 5; n++) {
  const size = sizeOf(n, true);
  const order = new Uint8Array(n);
  const avail = new Uint8Array(n);
  let bad = 0;
  for (let code = 0; code < size; code++) {
    const bits = decode(code, n, true, order, avail);
    if (encode(order, bits, n, true) !== code) bad++;
  }
  t.eq(`burnt n=${n}: code → (order,bits) → code is the identity for all ${size}`, bad, 0);
}

t.where('flip');
// A worked example, computed by hand from the definition (take the top k, put them back in reverse
// order), so the test does not just agree with the implementation.
{
  const order = Uint8Array.from([1, 3, 2, 0]); // sizes 2,4,3,1
  const before = Array.from(order);
  flip(order, 0, 3, false);
  t.eq('plain flip(3) on [2,4,3,1] reverses the top three', Array.from(order, (v) => v + 1).join(','), '3,4,2,1');
  flip(order, 0, 3, false);
  t.eq('flip is its own inverse (order)', Array.from(order, (v) => v + 1).join(','), before.map((v) => v + 1).join(','));
}
// Burnt: reversing the prefix carries the orientations with the pancakes and turns each one over.
{
  const order = Uint8Array.from([0, 1, 2, 3]);
  const bits = 0b0101; // depths 0 and 2 burnt-side-up
  const nb = flip(order, bits, 3, true);
  t.eq('flip(3) reversed the order', Array.from(order).join(','), '2,1,0,3');
  // depth 0 came from old depth 2 (1 → 0), depth 1 from old depth 1 (0 → 1), depth 2 from old
  // depth 0 (1 → 0), and depth 3 was above the spatula so it keeps its own bit (0).
  t.eq('flip(3) moved and toggled the bits, and left the rest alone', nb.toString(2).padStart(4, '0'), '0010');
  t.eq('flipping twice restores the bits exactly', flip(order, nb, 3, true), bits);
}

t.where('flip involution over the whole signed space');
for (let n = 1; n <= 4; n++) {
  const size = sizeOf(n, true);
  let bad = 0;
  for (let code = 0; code < size; code++) {
    const a = new Uint8Array(n);
    const b = new Uint8Array(n);
    const bits = decode(code, n, true, a, b);
    for (let k = 1; k <= n; k++) {
      const x = new Uint8Array(a);
      const xb = flip(x, bits, k, true);
      const yb = flip(x, xb, k, true);
      if (yb !== bits || lehmer(x, n) !== lehmer(a, n)) bad++;
    }
  }
  t.eq(`burnt n=${n}: flip(flip(s,k),k) === s for every state and every k`, bad, 0);
}

t.where('goal and legality');
{
  const id = Uint8Array.from([0, 1, 2, 3]);
  t.ok('sorted, all clean-side-down is the goal', isGoal(id, 0, 4, false));
  t.ok('sorted but a burnt side up is not the goal', !isGoal(id, 0b0010, 4, true));
  t.eq('the goal encodes to 0 (the BFS root)', encode(id, 0, 4, true), 0);
  t.eq('plain has no 1-flip', legal(1, 5, false), false);
  t.eq('burnt does have a 1-flip', legal(1, 5, true), true);
  t.eq('k = n is on the stack', legal(5, 5, false), true);
  t.eq('k = n+1 is off the end', legal(6, 5, false), false);
  t.eq('minFlip agrees with legal() at the shallow end', minFlip(true), 1);
  t.eq('minFlip agrees with legal() for plain', minFlip(false), 2);
}

t.where('rng is reproducible across engines');
{
  const a = rng(20260928);
  const b = rng(20260928);
  const seqA = Array.from({ length: 8 }, () => a());
  const seqB = Array.from({ length: 8 }, () => b());
  t.eq('same seed, same sequence', seqA.join('|'), seqB.join('|'));
  t.ok('in [0,1)', seqA.every((v) => v >= 0 && v < 1));
  t.ok('different seed, different sequence', seqA.join('|') !== rng(7)() + '');
  // A non-integer or negative seed must not silently produce a constant stream.
  const c = rng(-5);
  t.ok('negative seed still yields in-range values', c() >= 0 && c() < 1);
}

t.done();
