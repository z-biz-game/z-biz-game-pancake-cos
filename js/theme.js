// Colour scheme and motion preference, in one place, because the canvas reads the same tokens the
// DOM does.
//
// The rule this file exists to enforce: a theme change must be visible in the *pixels*, not only in
// a data attribute. `css/game.css` declares exactly two palettes, on `:root[data-theme='light']`
// and `:root[data-theme='dark']`, and this file always resolves 'auto' down to one of them before
// painting. One source of truth for each palette — a media-query copy plus an attribute copy is how
// a theme ends up looking right in the DOM and wrong on the canvas.
//
// The page is a game that needs JavaScript to draw anything at all, so a no-JS light-mode fallback
// would be a rule that protects a state the app cannot reach.

const KEY = 'pancake.theme.v1';
export const SCHEMES = ['auto', 'light', 'dark'];

export function createTheme(storage, opts = {}) {
  const mqLight = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
  const mqReduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const root = opts.root || (typeof document !== 'undefined' ? document.documentElement : null);
  const subs = new Set();
  let scheme = 'auto';
  try {
    const raw = storage && storage.getItem(KEY);
    if (SCHEMES.includes(raw)) scheme = raw;
  } catch {
    /* a storage that throws is a storage that will also not save; auto is the honest fallback */
  }

  const theme = {
    get scheme() {
      return scheme;
    },
    // 'auto' hands the decision to the media query; the other two names are claims about this tab.
    get effective() {
      return scheme === 'auto' ? (mqLight && mqLight.matches ? 'light' : 'dark') : scheme;
    },
    get reducedMotion() {
      return !!(mqReduce && mqReduce.matches);
    },
    set(next, persist = true) {
      if (!SCHEMES.includes(next)) return false;
      scheme = next;
      paint();
      if (persist && storage) {
        try {
          storage.setItem(KEY, scheme);
        } catch {
          /* preference not surviving a reload is not a reason to stop applying it now */
        }
      }
      for (const fn of subs) fn(scheme, theme.effective);
      return true;
    },
    cycle() {
      return theme.set(SCHEMES[(SCHEMES.indexOf(scheme) + 1) % SCHEMES.length]);
    },
    onChange(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    // Resolved by the browser, so a caller cannot be handed a value the stylesheet does not agree
    // with — the gate reads colours through here and compares them to canvas pixels.
    token(name) {
      if (!root) return '';
      return getComputedStyle(root).getPropertyValue(name).trim();
    },
  };

  function paint() {
    if (root) root.setAttribute('data-theme', theme.effective);
  }
  paint();
  if (mqLight && mqLight.addEventListener) {
    mqLight.addEventListener('change', () => {
      if (scheme !== 'auto') return;
      paint();
      for (const fn of subs) fn(scheme, theme.effective);
    });
  }
  return theme;
}

