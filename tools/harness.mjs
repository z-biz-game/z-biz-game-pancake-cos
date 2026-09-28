// Three functions every suite in this directory uses, so "it printed something" is never
// mistaken for "it checked something". A suite that runs zero assertions exits non-zero on
// purpose: an empty file is not a gate.

export function suite(name) {
  const rows = [];
  let group = '';
  const push = (test, pass, detail) => rows.push({ test: group ? `${group} / ${test}` : test, pass, detail });
  const api = {
    // Scope the next assertions under a label, so a failure line says which invariant broke.
    where(label) {
      group = label;
    },
    ok(test, cond, detail) {
      push(test, !!cond, cond ? '' : String(detail === undefined ? '' : detail));
      return !!cond;
    },
    eq(test, got, want) {
      const pass = String(got) === String(want);
      push(test, pass, pass ? '' : `got ${fmt(got)} / want ${fmt(want)}`);
      return pass;
    },
    // For numbers computed by a second, independent implementation.
    near(test, got, want, tol = 1e-9) {
      const pass = Math.abs(got - want) <= tol;
      push(test, pass, pass ? '' : `got ${got} / want ${want} ±${tol}`);
      return pass;
    },
    fail(test, detail) {
      push(test, false, String(detail === undefined ? '' : detail));
    },
    done(extra = '') {
      const bad = rows.filter((r) => !r.pass);
      for (const r of bad) console.log(`not ok - ${r.test}${r.detail ? ': ' + r.detail : ''}`);
      console.log(`# ${name}: ${rows.length} checks, ${bad.length} failed${extra ? ' ' + extra : ''}`);
      if (!rows.length) {
        console.log(`# ${name}: NO CHECKS RUN — an empty suite cannot be green`);
        process.exit(1);
      }
      if (bad.length) process.exit(1);
      console.log(`# ${name}: PASS`);
    },
  };
  return api;
}

function fmt(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 90 ? s.slice(0, 90) + '…' : String(s);
}

// A fake localStorage that can hold exactly the bytes a real tab would leave behind, including
// half-written JSON. Passing globalThis.localStorage in the browser and this in node keeps the
// decode path under test on both sides.
export function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    raw: (k) => (map.has(k) ? map.get(k) : null),
  };
}
