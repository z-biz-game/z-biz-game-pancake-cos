// Positions, their integer codes, and the one move the game has.
//
// A position is a stack of n pancakes, sizes 0 (smallest) .. n-1 (largest), top index first, plus
// one orientation bit per *position*: bit i = 1 means the pancake sitting at depth i has its burnt
// side up. In `plain` mode the bits are never touched (every stack is all-zero, forever) so the
// state space is exactly the n! permutations; in `burnt` mode a flip turns each pancake it moves
// upside down, so the space is 2^n · n!.
//
// Code = lehmer(order) * (burnt ? 2^n : 1) + bits, which is a bijection onto 0..size-1 and lets the
// BFS keep its distance field in one typed array indexed by code. Nothing here allocates per
// lookup, because the whole game is a walk over this table.

export const FACT = (() => {
  const f = [1];
  for (let i = 1; i <= 13; i++) f[i] = f[i - 1] * i;
  return f;
})();

export const MAX_N = 9;

export function sizeOf(n, burnt) {
  if (n < 1 || n > MAX_N) throw new RangeError(`n must be 1..${MAX_N}, got ${n}`);
  return FACT[n] * (burnt ? 1 << n : 1);
}

// Lexicographic rank of a permutation of 0..n-1 (the Lehmer code read as a factorial-number-system
// number). Digit i counts the still-unplaced values below order[i], which is what the nested scan
// computes: everything after position i is exactly the unplaced set.
export function lehmer(order, n) {
  let r = 0;
  for (let i = 0; i < n; i++) {
    let d = 0;
    const v = order[i];
    for (let j = i + 1; j < n; j++) if (order[j] < v) d++;
    r = r * (n - i) + d;
  }
  return r;
}

// Inverse of lehmer, writing into `order` and using `avail` as scratch (both length n).
export function unlehmer(r, n, order, avail) {
  for (let i = 0; i < n; i++) avail[i] = i;
  for (let i = 0; i < n; i++) {
    const base = FACT[n - 1 - i];
    const idx = (r / base) | 0;
    r -= idx * base;
    order[i] = avail[idx];
    for (let j = idx; j < n - 1 - i; j++) avail[j] = avail[j + 1];
  }
  return order;
}

// Reverse the low k bits and turn each one over: the pancake now at depth i came from depth k-1-i,
// and being flipped puts its burnt side where its clean side was. Everything above the spatula is
// untouched, so the high bits have to be carried through — dropping them (as the first version of
// this did) leaves only all-ones prefixes reachable, and the BFS reports 2^n·n!/n! of that.
function flipBits(bits, k) {
  let out = 0;
  for (let i = 0; i < k; i++) out = (out << 1) | ((bits >> i) & 1);
  return (bits & ~((1 << k) - 1)) | ((out ^ ((1 << k) - 1)) & ((1 << k) - 1));
}

// One spatula insertion: take the top k pancakes off and put them back in reverse order. Its own
// inverse, which is what makes the BFS able to explore and restore without copying arrays.
export function flip(order, bits, k, burnt) {
  for (let i = 0, j = k - 1; i < j; i++, j--) {
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return burnt ? flipBits(bits, k) : bits;
}

export function encode(order, bits, n, burnt) {
  return lehmer(order, n) * (burnt ? 1 << n : 1) + (burnt ? bits : 0);
}

export function decode(code, n, burnt, order, avail) {
  const mod = burnt ? 1 << n : 1;
  unlehmer((code / mod) | 0, n, order, avail);
  return burnt ? code % mod : 0;
}

export function isGoal(order, bits, n, burnt) {
  if (burnt && bits !== 0) return false;
  for (let i = 0; i < n; i++) if (order[i] !== i) return false;
  return true;
}

// A move is legal when the spatula goes under something. k>n is off the end of the stack, and
// k=1 is only a move at all in burnt mode: turning one pancake over changes its orientation, while
// reversing a stack of one changes nothing, so plain pancakes start at 2 (the range the published
// pancake numbers are defined over). Burnt pancakes start at 1, and the reason is worth being exact
// about: taking k=1 away splits the three-layer burnt graph — only 12 of its 48 stacks stay
// reachable — but from four layers up the k>=2 moves already reach every stack (both readings are
// measured in test/graph.test.mjs). So k=1 is the rule "a single pancake can be turned over", not
// a connectivity patch; at n=3 those two things happen to be the same move.
export function legal(k, n, burnt = false) {
  return Number.isInteger(k) && k >= (burnt ? 1 : 2) && k <= n;
}

export function minFlip(burnt) {
  return burnt ? 1 : 2;
}

export function sameStack(a, b, n) {
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Deterministic generator. Math.random is not allowed anywhere in this repo: a level table that
// re-draws itself between node and Chrome is not a table, and a suite whose row count moves
// between runs is not a gate.
export function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
