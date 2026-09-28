// The player's side of the engine: what a tap means, and what a stack looks like to a human.
//
// Kept separate from perms.js/graph.js on purpose. The graph answers "what is the true distance",
// which is a fact about mathematics; this file answers "the player clicked the pancake third from
// the top, is that a move, and what does the stack become", which is a fact about the game. A tap
// that is not a move has to come back as a rejection the UI can *show* — silently swallowing an
// invalid input is the defect class this fleet audits for.

import { encode, decode, flip, isGoal, legal, minFlip } from './perms.js';

export const SOLVED = 'solved';

// A live position: sizes are 1..n with 1 = smallest, top of the stack first; `sides[i]` is 1 when
// the pancake at depth i has its burnt side up. `code` is the graph's integer id for the same thing.
export function start(code, n, burnt) {
  const order = new Uint8Array(n);
  const avail = new Uint8Array(n);
  const bits = decode(code, n, burnt, order, avail);
  return {
    n, burnt, code, order, bits,
    sizes: Array.from(order, (v) => v + 1),
    // Empty for plain levels, so the view has one rule for "paint a burnt side" and the shipped
    // row's `burnt: []` means the same thing as the live position's `sides`.
    sides: burnt ? bitsOf(bits, n) : [],
  };
}

function bitsOf(bits, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((bits >> i) & 1);
  return out;
}

function sync(p) {
  p.code = encode(p.order, p.bits, p.n, p.burnt);
  p.sizes = Array.from(p.order, (v) => v + 1);
  p.sides = bitsOf(p.bits, p.n);
  return p;
}

export function clone(p) {
  const q = new Uint8Array(p.n);
  q.set(p.order);
  return sync({ n: p.n, burnt: p.burnt, order: q, bits: p.bits });
}

// The deepest valid insertion is under the bottom pancake (k = n); the shallowest is k = minFlip,
// which is 2 for plain pancakes and 1 when there is a burnt side to turn over.
export function maxFlip(n) {
  return n;
}

export function canFlip(pos, k) {
  return legal(k, pos.n, pos.burnt);
}

// Returns { ok, pos, reason }. `reason` is machine-readable on purpose ('too-shallow',
// 'not-a-number', 'already-at-the-top') so the UI can say something specific instead of shrugging.
export function flipAt(pos, k) {
  if (!Number.isFinite(k) || !Number.isInteger(k)) return { ok: false, reason: 'not-a-number', k };
  if (k > pos.n) return { ok: false, reason: 'past-the-bottom', k };
  if (!pos.burnt && k === 1) return { ok: false, reason: 'one-plain-pancake-does-not-move', k };
  if (k < minFlip(pos.burnt)) return { ok: false, reason: 'too-shallow', k };
  if (!legal(k, pos.n, pos.burnt)) return { ok: false, reason: 'illegal', k };
  const q = clone(pos);
  q.bits = flip(q.order, q.bits, k, q.burnt);
  return { ok: true, pos: sync(q), k };
}

export function solved(pos) {
  return isGoal(pos.order, pos.bits, pos.n, pos.burnt);
}

// A star rating has to be a claim about the player, not about the clock: three stars for par, two
// for one extra flip, one for anything else, and a run that used a hint is reported as such
// forever. `over` is how far from the measured optimum the run is — the number the whole repo
// exists to make honest.
export function grade(moves, par, hints) {
  const over = moves - par;
  // over < 0 is not a thing: par is the true minimum, so no run can beat it. Reported honestly
  // rather than clamped, and test/game.test.mjs asserts every real run's over is >= 0 — that is
  // where a contradiction between the table and the move rules would surface.
  const stars = over <= 0 ? 3 : over === 1 ? 2 : 1;
  return { over, stars, hinted: hints > 0 };
}
