// Motion preference, tracked live instead of sampled once.
//
// Two ways in, and both are needed:
//   - `(prefers-reduced-motion: reduce)` is the OS-level contract. It is *subscribed*, not polled,
//     because a player who turns the switch on while the page is open should get a still board
//     without reloading.
//   - `<html data-motion>` is what `css/game.css` matches on. Without it the stylesheet could only
//     ever honour the OS switch, and the canvas (which has no media queries) would disagree with the
//     DOM about what "reduced" means.
//
// `?motion=off|on` overrides both for one tab. This repo's gate is a single headless driver that
// cannot be told to prefer reduced motion, so the override is the only way to exercise the branch —
// and while it is set, a system `change` event must not silently win, or the leg would test whatever
// the browser felt like rather than what was asked for.

const QUERY = '(prefers-reduced-motion: reduce)';

export function createMotion(opts = {}) {
  const mq = typeof matchMedia === 'function' ? matchMedia(QUERY) : null;
  const search = opts.search === undefined && typeof location !== 'undefined' ? location.search : opts.search || '';
  const forced = new URLSearchParams(search).get('motion');
  const subs = new Set();
  let reducedMotion = forced === 'off' ? true : forced === 'on' ? false : !!(mq && mq.matches);

  function apply() {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.dataset.motion = reducedMotion ? 'reduce' : 'no-preference';
    }
    for (const fn of subs) fn(reducedMotion);
  }

  const motion = {
    get reducedMotion() {
      return reducedMotion;
    },
    get source() {
      return forced ? 'url' : mq ? 'media' : 'default';
    },
    set(next) {
      reducedMotion = !!next;
      apply();
      return reducedMotion;
    },
    toggle() {
      return motion.set(!reducedMotion);
    },
    onChange(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };

  if (mq && mq.addEventListener) {
    mq.addEventListener('change', (ev) => {
      if (forced) return;
      motion.set(ev.matches);
    });
  }
  apply();
  return motion;
}
