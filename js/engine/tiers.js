// The ladder, written as measurements rather than as adjectives.
//
// Every tier says: which mode, which stack heights, how many levels, and what a position has to
// measure like to be collected into it. `par` is the true minimum over the whole graph and
// `starts` is how many first moves keep you on a shortest path — so the rungs are "taller stack,
// longer forced optimum, fewer correct openings", all three of them recomputed by every check.
//
// The windows come from a census of the graph, and one of its facts shapes the design: at the
// sizes the top rungs use, the diameter is the *least* forced part of the whole space, not the most
// forced — plain n=6 has 2 antipodes and both offer 5 optimal first moves, n=7 has 35 offering 5
// or 6, n=8 has 455 offering between 3 and 7, and burnt n=6 has exactly one position at distance
// 12 with 6 openings. `starts === 1` at the diameter is not impossible, only small: plain n=2 has
// one such position and plain n=5 has five of its 20, and `pk-reg-1` ships one of those. But there
// is nothing to buy at n >= 6, so the steep rungs step one or two rings under the diameter and pay
// for difficulty with `starts === 1` instead. test/graph.test.mjs asserts the shipped-size absence
// *and* the n=5 counterexample, so this reasoning cannot quietly harden into a law.
//
// A tier whose filter cannot fill its quota makes tools/bake.mjs throw. Silently relaxing a
// difficulty predicate is how a green gate ends up shipping a lie about the ladder.

export const TIERS = [
  {
    id: 'warm', name: '灶前热身', note: '三层饼的非平凡局面全收（par 2–3），再加一张起手唯一的四层饼',
    specs: [
      { n: 3, burnt: false, want: 3, ok: (m) => m.par >= 2 },
      { n: 4, burnt: false, want: 1, ok: (m) => m.par === 3 && m.starts === 1 },
    ],
  },
  {
    id: 'appr', name: '学徒', note: '四层饼的最远一环：par 4，全图只有 3 个这种局面',
    specs: [{ n: 4, burnt: false, want: 3, ok: (m) => m.par === 4 }],
  },
  {
    id: 'reg', name: '熟手', note: '五到六层，最优起手不超过两种',
    specs: [
      { n: 5, burnt: false, want: 2, ok: (m) => m.par === 5 && m.starts <= 2 },
      { n: 6, burnt: false, want: 2, ok: (m) => m.par === 6 && m.starts === 1 },
    ],
  },
  {
    id: 'exp', name: '高手', note: '七到八层，起手唯一（15 个合法翻法里只有 1 个不绕路）',
    specs: [
      { n: 7, burnt: false, want: 2, ok: (m) => m.par === 7 && m.starts === 1 },
      { n: 8, burnt: false, want: 2, ok: (m) => m.par === 8 && m.starts === 1 },
    ],
  },
  {
    id: 'burnt', name: '焦边', note: '烙焦的一面必须朝下；翻一张要连它上面的一起翻',
    specs: [
      { n: 3, burnt: true, want: 2, ok: (m) => m.par >= 5 && m.starts <= 2 },
      { n: 4, burnt: true, want: 2, ok: (m) => m.par >= 7 && m.starts <= 3 },
    ],
  },
  {
    id: 'master', name: '烙饼师', note: '五到六层焦边阵，par 9–10 且起手唯一',
    specs: [
      { n: 5, burnt: true, want: 2, ok: (m) => m.par >= 9 && m.starts <= 5 },
      { n: 6, burnt: true, want: 2, ok: (m) => m.par === 10 && m.starts === 1 },
    ],
  },
];

export const TIER_BY_ID = new Map(TIERS.map((t, i) => [t.id, { ...t, index: i }]));

export function tierSpecs(tierId) {
  const t = TIER_BY_ID.get(tierId);
  return t ? t.specs : [];
}

// Level ids are `pk-<tier>-<k>` for the baked campaign and `pk-<tier>-r<seed36>` for a freshly
// sampled one, so the route alone says which tier to build a position from.
export function tierIdOf(levelId) {
  const m = /^pk-([a-z]+)-/.exec(levelId || '');
  return m && TIER_BY_ID.has(m[1]) ? m[1] : null;
}

export function specAt(tierId, i) {
  const specs = tierSpecs(tierId);
  return specs.length ? specs[i % specs.length] : null;
}

export function tierNames() {
  return TIERS.map((t) => t.id);
}
