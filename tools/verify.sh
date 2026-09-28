#!/usr/bin/env bash
# One-shot browser verification: real Chrome, real DOM, scripted scenarios, both URL shapes.
#
#   ./tools/verify.sh                 # every leg, at root shape and at the Pages shape
#   SCENARIOS="play hint" ./tools/verify.sh
#   SHAPES=root ./tools/verify.sh
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-pancake-cos/ ./tools/verify.sh
#   SHOTS=v1 ./tools/verify.sh        # also write tools/shots/*-v1.png
#
# Why two shapes: GitHub Pages serves this repo under /z-biz-game-pancake-cos/, while server.cjs
# serves it as the document root. A specifier that only works at the root — an absolute '/js/…' in
# markup, a '/css/game.css' <link> — is invisible in the first shape and a 404 in the second, so one
# shape cannot be evidence for the deployed page.
#
# Every leg loads a distinct URL (?leg=<name>-<counter>) on purpose. A navigation that only changes
# the fragment reuses the live document, so a leg that "reloads" by hashing to #menu is really the
# previous leg asserting against itself; the reloaded scenario additionally compares
# performance.timeOrigin against the value the save leg wrote, so a stale document fails the gate
# instead of passing it.
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates every core and, with no CDP client attached, Chrome will not exit on its
# own.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(basename "$HERE")
# Post-mortem evidence lives beside the repo, not in /tmp: an auto-cleaned /tmp mid-session turns a
# failing leg into "see the log that no longer exists". .gate/ is gitignored.
LOGD=${LOG_DIR:-$HERE/.gate}
mkdir -p "$LOGD"
PORT=${CDP_PORT:-9386}
# 5173 is Xcode/ashen-ring's default and a long-lived server there will happily serve a *different*
# app, so this harness runs on its own ports. Other agents in the farm run their own verify.sh at
# the same time; 5266 (root), 5267 (prefix) and 9386 (CDP) are pancake's and nothing else's.
HTTP=${HTTP_PORT:-5266}
PREF=${PREFIX_PORT:-5267}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

FAILED=0
LEG_NAMES="boot table menu play reject hint hit save reloaded theme win layout"
# The data gate first: it is 38 ms, and a shipped par that the graph disagrees with should stop the
# run before a browser is even started.
echo "=== bake --check ==="
if node "$HERE/tools/bake.mjs" --check 2>&1 | tail -6 | sed 's/^/  /'; then :; else FAILED=1; fi

SPID=0
PROOT=""
cleanup() {
  trap - EXIT
  [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
  [ -n "$CPID" ] && kill -9 $CPID 2>/dev/null
  [ -n "$UDD" ] && rm -rf $UDD
  [ -n "$PROOT" ] && rm -rf "$PROOT"
  wait 2>/dev/null
}
trap cleanup EXIT

# ---------- Chrome, once for every shape ----------
UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$PORT --user-data-dir=$UDD \
  --window-size=900,1000 --no-first-run --no-default-browser-check about:blank >"$LOGD/pancake-chrome.log" 2>&1 &
CPID=$!
# The watchdog redirects its fds: a background subshell inherits this script's stdout, and inside a
# pipeline it would hold the write end open long after the tests finished.
( sleep ${WD_TIMEOUT:-600}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

for i in $(seq 1 120); do
  curl -fsS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$PORT" >&2; exit 3; }

export CDP_PORT=$PORT
cd "$HERE"

run() {
  # $1 = scenario, $2 = leg label, $3 = optional WxHxD device emulation for this leg's own session.
  # Each leg gets its own URL so the document is genuinely new.
  local s=$1 label=$2 emu=${3:-} url="${BASE}"
  case "$BASE" in *\?*) url="${BASE}&leg=${label}" ;; *) url="${BASE}?leg=${label}" ;; esac
  # ?want=narrow states which device the leg expects: an Emulation override that silently failed
  # would otherwise re-run the desktop checks and report them as the mobile pass.
  [ -n "$emu" ] && url="${url}&want=narrow"
  EMULATE="$emu" BASE_URL="$url" node tools/playtest.cjs scenario "$s" 2>"$LOGD/pancake-${label}.console.log" | tail -1 | sed 's/^RESULT //' | python3 -c "
import sys, json
tally = sys.argv[1]
raw = sys.stdin.read().strip()
if not raw:
    print('  NO RESULT (see ' + tally.replace('.tally', '.console.log') + ')'); sys.exit(1)
try:
    d = json.loads(raw)
except Exception:
    print('  UNPARSED:', raw[:400]); sys.exit(1)
for r in d['rows']:
    if not r['pass']: print('  FAIL %-46s %s' % (r['test'], r['detail']))
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail')}
if not d['rows']:
    print('  NO CHECKS RUN — a scenario that asserts nothing cannot be green'); sys.exit(1)
print('  %d checks, %d failed  %s' % (len(d['rows']), d['fail'], extra if extra else ''))
open(tally, 'a').write('%d %d\n' % (len(d['rows']), d['fail']))
sys.exit(1 if d['fail'] else 0)
" "$LOGD/$SHAPE-$label.tally"
}

# ---------- one shape ----------
run_shape() {
  SHAPE=$1
  SPID=0
  PROOT=""
  rm -f "$LOGD"/$SHAPE-*.tally
  case "$SHAPE" in
    root)
      node "$HERE/server.cjs" "$HTTP" >"$LOGD/pancake-root-server.log" 2>&1 &
      SPID=$!
      BASE="http://127.0.0.1:$HTTP/"
      ;;
    prefix)
      # The Pages shape without copying or rewriting anything: the server's document root is a
      # directory that only contains a symlink to the repo, so the app is one path segment deep
      # exactly as it is on z-biz-game.github.io.
      PROOT=$(mktemp -d)
      ln -s "$HERE" "$PROOT/$REPO"
      python3 -m http.server "$PREF" --bind 127.0.0.1 --directory "$PROOT" >"$LOGD/pancake-prefix-server.log" 2>&1 &
      SPID=$!
      BASE="http://127.0.0.1:$PREF/$REPO/"
      ;;
    custom)
      BASE="$BASE_URL"
      ;;
    *) echo "unknown shape: $SHAPE" >&2; return 1 ;;
  esac
  if [ "$SHAPE" != custom ]; then
    for i in $(seq 1 40); do
      curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
      sleep 0.25
    done
  fi
  # Pre-flight: prove the bytes we are about to test are this app's, not some other repo's
  # index.html served on the same port.
  local log=pancake-$([ "$SHAPE" = prefix ] && echo prefix || echo root)-server.log
  SERVED=$(curl -fsS -m 5 "$BASE" 2>/dev/null || true)
  case "$SERVED" in *js/main.js*) ;; *) echo "nothing served at $BASE (see $LOGD/$log)" >&2; return 2 ;; esac
  echo "$SERVED" | grep -qi pancake || { echo "$BASE is serving a different app, not 烙饼/PANCAKE" >&2; return 2; }

  echo "################ shape=$SHAPE base=$BASE"
  # BASE_URL has to be in the environment, not just in this shell: playtest.cjs decides which tab to
  # attach to by matching its default origin, so an `eval` that inherits the 5266 default while the
  # prefix shape is running attaches to a blank tab and reports the app as never booting.
  export BASE_URL="$BASE"
  node tools/playtest.cjs open "$BASE" | head -3

  BOOT=""
  for i in $(seq 1 60); do
    BOOT=$(node tools/playtest.cjs eval "window.pancake?window.pancake.version:'nope'" nonav 2>/dev/null | tr -d '\n" ')
    case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
  done
  echo "boot: pancake $BOOT at $BASE"
  [ "$BOOT" = "nope" ] && { echo "window.pancake never appeared at $BASE" >&2; return 4; }

  local bad=0 N=0
  for s in ${SCENARIOS:-$LEG_NAMES}; do
    N=$((N + 1))
    echo "=== [$SHAPE] $s ==="
    run "$s" "$s$N" || bad=1
    if [ -s "$LOGD/pancake-$s$N.console.log" ]; then
      echo "  --- console ---"
      sed 's/^/  /' "$LOGD/pancake-$s$N.console.log" | tail -12
    fi
  done

  if [ -n "${SHOTS:-}" ] && [ "$SHAPE" != prefix ]; then
    mkdir -p tools/shots
    for shot in menu board win; do
      case $shot in
        menu) node tools/playtest.cjs eval "history.replaceState(null,'','/?shot');window.pancake.go('menu');'ok'" nonav >/dev/null 2>&1 ;;
        board) node tools/playtest.cjs eval "window.pancake.go('pk-exp-1');window.pancake.hint();'ok'" nonav >/dev/null 2>&1 ;;
        win) node tools/playtest.cjs eval "window.pancake.go('pk-warm-1');window.pancake.solveAll();'ok'" nonav >/dev/null 2>&1 ;;
      esac
      sleep 1.4
      node tools/playtest.cjs shot "tools/shots/$shot-$SHOTS.png" >/dev/null
    done
    echo "shots: $(ls tools/shots/*-$SHOTS.png 2>/dev/null | tr '\n' ' ')"
  fi

  # The same layout gate at a phone's layout viewport: Emulation, not --window-size, because the
  # media query keys off the viewport and headless-new does not draw window chrome.
  if [ "${MOBILE_LEG:-1}" = 1 ]; then
    echo "=== [$SHAPE] layout @380 (mobile viewport) ==="
    N=$((N + 1))
    run layout "mobilelayout$N" "${MOBILE_METRICS:-380x780x2}" || bad=1
    if [ -s "$LOGD/pancake-mobilelayout$N.console.log" ]; then
      echo "  --- console ---"
      sed 's/^/  /' "$LOGD/pancake-mobilelayout$N.console.log" | tail -12
    fi
  fi

  # The summary reads the tally files, not the printed lines: a leg that died before reporting is
  # then visible as a missing file rather than as a number that quietly stayed low.
  local reported=0 checks=0 fails=0
  for f in "$LOGD"/$SHAPE-*.tally; do
    [ -e "$f" ] || continue
    reported=$((reported + $(wc -l < "$f" | tr -d ' ')))
    checks=$((checks + $(awk '{c+=$1} END {print c+0}' "$f")))
    fails=$((fails + $(awk '{f+=$2} END {print f+0}' "$f")))
  done
  local want=0
  for s in ${SCENARIOS:-$LEG_NAMES}; do want=$((want + 1)); done
  [ "${MOBILE_LEG:-1}" = 1 ] && want=$((want + 1))
  echo "---- shape=$SHAPE: $reported/$want legs reported · $checks checks · $fails failed ----"
  if [ "$reported" != "$want" ]; then
    echo "  a leg never reported a tally — the run is incomplete, not green" >&2
    bad=1
  fi
  [ $bad -eq 0 ] || return 1
  return 0
}

if [ -n "${BASE_URL:-}" ]; then
  SHAPES_TO_RUN="custom"
  echo "BASE_URL given → 只跑部署件这一种形态，本脚本不起任何服务（CDP :$PORT）"
else
  SHAPES_TO_RUN=${SHAPES:-root prefix}
fi
RAN=""
for shape in $SHAPES_TO_RUN; do
  RAN="$RAN $shape"
  run_shape "$shape" || FAILED=1
  # Each shape gets its own server; tear this one down before the next.
  [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
  SPID=0
  [ -n "$PROOT" ] && { rm -rf "$PROOT"; PROOT=""; }
done

kill $WD 2>/dev/null
echo "==== ran shapes:$RAN ===="
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
# The shell reports each background job it reaps on stderr at exit ("Killed: 9"), after the verdict
# line. Silence it so a passing run ends on the verdict.
exec 2>/dev/null
exit $FAILED
