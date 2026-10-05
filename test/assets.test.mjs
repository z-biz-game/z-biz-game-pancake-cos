// 资产台账：页面上每一个写死的路径，磁盘上必须有一张真实可读的图。
//
// 为什么单独成一份文件，而不是"看起来目录挺干净"：这个仓的出货面是三处写死的路径 ——
// index.html 的 <link>/<script>、manifest.webmanifest 的 icons、sw.js 的离线兜底 SHELL，外加
// css 的 url() 和 js 里当 sprite 用的字符串。任何一处拼错，浏览器只会安静地 404：图标没了、
// 离线白屏、社交卡裂图，而 448 项行为测试一条都不会红。所以这里不做字符串搜索式的"提权"，
// 而是真的解析 PNG 的 IHDR、真的走一遍 import 图、真的比对三张清单和磁盘。
//
// 反注水：阴性对照在最后 —— 把一条不存在的路径喂进同一套校验，它必须被判成缺失，
// 否则这份文件是一台空转的尺子。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { suite } from '../tools/harness.mjs';

const t = suite('assets');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const absolutePaths = [];

const CRC_TABLE = (() => {
  const tab = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tab[n] = c;
  }
  return tab;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const COLOR_TYPE = { 0: 'gray', 2: 'RGB', 3: 'palette', 4: 'gray+alpha', 6: 'RGBA' };

// 真实解析，不接受"扩展名是 .png"。签名、第一个块必须是 IHDR、块 CRC 必须对得上，
// 宽高必须非零 —— 0 字节、SVG 冒充 PNG、截断文件都在这里死掉。
function pngInfo(rel) {
  const abs = path.join(ROOT, rel);
  let buf;
  try { buf = readFileSync(abs); } catch { return { rel, missing: true, reason: '文件不存在' }; }
  if (buf.length === 0) return { rel, bytes: 0, reason: '0 字节' };
  if (buf[0] === 0x3c) return { rel, bytes: buf.length, reason: '文本冒充图片（以 < 开头）' };
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(SIG)) return { rel, bytes: buf.length, reason: 'PNG 签名不对' };
  const len = buf.readUInt32BE(8);
  if (buf.toString('latin1', 12, 16) !== 'IHDR' || len !== 13) {
    return { rel, bytes: buf.length, reason: '第一个块不是 13 字节的 IHDR' };
  }
  if (crc32(buf.subarray(12, 29)) !== buf.readUInt32BE(29)) {
    return { rel, bytes: buf.length, reason: 'IHDR 的 CRC 校验不过（文件被截断或改坏）' };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const ctype = buf[25];
  if (!(width > 0 && height > 0)) return { rel, bytes: buf.length, reason: 'IHDR 宽高为 0' };
  return { rel, bytes: buf.length, width, height, depth, ctype, alpha: ctype === 4 || ctype === 6 };
}

function exists(rel) {
  try { return statSync(path.join(ROOT, rel)).isFile(); } catch { return false; }
}

function read(rel) { return readFileSync(path.join(ROOT, rel), 'utf8'); }

// ---------- 引用面：页面/manifest/css/js 里写死的每一条本地路径 ----------
const refs = new Map(); // rel -> Set(来源)
function note(rel, source) {
  if (!rel || rel.startsWith('#') || rel.startsWith('data:') || rel.startsWith('mailto:')) return;
  if (/^(https?:)?\/\//.test(rel)) return;
  if (rel.startsWith('/')) { absolutePaths.push(`${rel} ← ${source}`); return; }
  const norm = path.posix.normalize(rel.split(/[?#]/)[0]);
  if (!norm || norm === '.' || norm.startsWith('..')) return;
  if (!refs.has(norm)) refs.set(norm, new Set());
  refs.get(norm).add(source);
}

const html = read('index.html');
for (const m of html.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)) note(m[1], 'index.html');
// 社交卡写的是部署后的绝对 URL（爬虫不解相对地址），所以这里把仓库前缀剥掉再回盘上比对。
const DEPLOY = 'https://z-biz-game.github.io/z-biz-game-pancake-cos/';
for (const m of html.matchAll(/content="([^"]+)"/g)) {
  if (m[1].startsWith(DEPLOY)) note(m[1].slice(DEPLOY.length), 'index.html:og:image');
}

for (const m of html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) note(m[1], 'index.html:inline');
for (const m of read('css/game.css').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
  note(path.posix.normalize(path.join('css', m[1])), 'css/game.css');
}

const manifest = JSON.parse(read('manifest.webmanifest'));
const manifestIcons = manifest.icons || [];
for (const ic of manifestIcons) note(ic.src, 'manifest.webmanifest');
for (const k of ['start_url', 'scope']) note(String(manifest[k] || '').replace(/\.\/$/, 'index.html'), 'manifest.webmanifest');

// ---------- 模块图：从页面真正加载的两个入口走一遍 import ----------
function graphFrom(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel) || !exists(rel)) continue;
    seen.add(rel);
    for (const m of read(rel).matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) { (graphFrom.external ||= new Set()).add(`${rel} → ${spec}`); continue; }
      queue.push(path.posix.normalize(path.join(path.dirname(rel), spec)));
    }
  }
  return [...seen].sort();
}
const graph = graphFrom(['js/main.js', 'js/sw-register.js']);
for (const g of graph) note(g, '模块图');
// js 里当 sprite / tile 用的位图字符串。
for (const rel of graph) {
  for (const m of read(rel).matchAll(/['"]((?:art|icons)\/[^'"]+\.(?:png|jpg|webp|svg))['"]/g)) note(m[1], rel);
}

// ---------- sw.js 的离线兜底清单 ----------
const swSrc = read('sw.js');
const shellBlock = /const SHELL\s*=\s*\[([\s\S]*?)\]/.exec(swSrc);
const SHELL = shellBlock ? [...shellBlock[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]) : [];

t.where('引用面：写死在页面上的每一条本地路径都在盘上');
const missing = [];
for (const [rel, srcs] of refs) if (!exists(rel)) missing.push(`${rel} ← ${[...srcs].join(', ')}`);
t.eq('引用总数（去重后的本地路径）> 20，否则这份台账什么都没看', refs.size > 20, true);
t.ok('每一条引用都落在磁盘上', missing.length === 0, missing.slice(0, 5).join(' | '));
t.eq('没有根绝对路径（Pages 把它挂在 /z-biz-game-pancake-cos/ 下，/js/… 一定 404）',
  absolutePaths.join(' | '), '');

t.where('位图是真的：签名、IHDR 宽高、CRC、以及"文件名声称的尺寸"');
// favicon-48.png / icon-192.png / spatula-720x96.png / og-1200x630.png 的尺寸写在名字里。
// 名字和 IHDR 不一致就是挂羊头卖狗肉：manifest 会按声称的尺寸装，浏览器安静地缩出一张糊图。
function sizeMismatch(rel, info) {
  const wh = /(\d+)x(\d+)\.png$/.exec(rel);
  if (wh) {
    return Number(wh[1]) === info.width && Number(wh[2]) === info.height
      ? '' : `名字说 ${wh[1]}x${wh[2]}，IHDR 是 ${info.width}x${info.height}`;
  }
  const square = /-(\d+)\.png$/.exec(rel);
  if (square) {
    const n = Number(square[1]);
    return info.width === n && info.height === n ? '' : `名字说 ${n}x${n}，IHDR 是 ${info.width}x${info.height}`;
  }
  return '';
}

const images = [...refs.keys()].filter((r) => r.endsWith('.png'));
t.ok('页面用到的 PNG 至少 12 张（图标 + 母题）', images.length >= 12, `实际 ${images.length}`);
const badPng = [];
for (const rel of images) {
  const info = pngInfo(rel);
  if (info.reason) { badPng.push(`${rel}: ${info.reason}`); continue; }
  const lie = sizeMismatch(rel, info);
  if (lie) badPng.push(`${rel}: ${lie}`);
}
t.ok('每张 PNG 都能解出真实尺寸且与文件名自洽', badPng.length === 0, badPng.slice(0, 5).join(' | '));

const touch = pngInfo('icons/apple-touch-icon.png');
t.eq('apple-touch-icon 是 180x180', `${touch.width}x${touch.height}`, '180x180');
t.eq('apple-touch-icon 不带 alpha（iOS 会把透明处填黑）', touch.alpha, false);
const maskable = pngInfo('icons/icon-maskable-512.png');
t.ok('maskable 图标是 ≥512 的正方形', maskable.width === maskable.height && maskable.width >= 512);
const any192 = pngInfo('icons/icon-192.png');
const any512 = pngInfo('icons/icon-512.png');
t.ok('PWA 出货要求 192 与 512 两张 any 用途图', any192.width === 192 && any512.width === 512);

t.where('manifest 与磁盘互相印证，而不只是 JSON 里写着');
for (const ic of manifestIcons) {
  const info = pngInfo(ic.src);
  t.eq(`${ic.src} 的实际尺寸等于 manifest 声称的 ${ic.sizes}`, `${info.width}x${info.height}`, ic.sizes);
}
t.ok('manifest 同时有 192 与 512、且至少一张 maskable',
  manifestIcons.some((i) => i.sizes === '192x192') &&
  manifestIcons.some((i) => i.sizes === '512x512') &&
  manifestIcons.some((i) => (i.purpose || '').includes('maskable')));
const og = pngInfo('art/og-1200x630.png');
const declaredOg = [/og:image:width"\s+content="(\d+)"/, /og:image:height"\s+content="(\d+)"/]
  .map((re) => Number((re.exec(html) || [])[1]));
t.eq('社交卡的 meta 尺寸与图本身一致（写错尺寸的卡会被爬虫丢弃）',
  `${declaredOg[0]}x${declaredOg[1]}`, `${og.width}x${og.height}`);

t.where('离线壳：断网首启要拿到的是整张图，不是 index.html 一张皮');
t.ok('SHELL 是一条非空清单', SHELL.length >= 20, `实际 ${SHELL.length}`);
t.ok('SHELL 无重复项', new Set(SHELL).size === SHELL.length);
const shellMissing = SHELL.filter((p) => !exists(p));
t.ok('SHELL 里每一项都在磁盘上（写错一条就是一次静默 404）', shellMissing.length === 0, shellMissing.join(' | '));
const notShelled = graph.filter((p) => !SHELL.includes(p));
t.ok('模块图的每一个 js 都进了离线壳', notShelled.length === 0, notShelled.join(' | '));
t.ok('css / manifest / index.html 进了离线壳',
  ['index.html', 'css/game.css', 'manifest.webmanifest'].every((p) => SHELL.includes(p)));
const artNotShelled = [...refs.keys()].filter((p) => /\.(png|webp|jpg)$/.test(p) && !SHELL.includes(p));
t.ok('页面引用的每张位图都进了离线壳', artNotShelled.length === 0, artNotShelled.join(' | '));
t.eq('SHELL 里除 index.html 外都真的被引用（兜底清单不能塞私货）',
  SHELL.filter((p) => !refs.has(p) && p !== 'sw.js').join(' | '), '');

t.where('磁盘上的资产都被用着（不留死图）');
const onDisk = ['art', 'icons'].flatMap((d) =>
  readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.png')).map((f) => `${d}/${f}`));
const orphans = onDisk.filter((p) => !refs.has(p));
t.ok('art/ 与 icons/ 没有一张图是没人引用的', orphans.length === 0, orphans.join(' | '));
const empty = onDisk.filter((p) => pngInfo(p).bytes === 0);
t.eq('没有 0 字节资产', empty.join(' | '), '');

// 生成路线可复现：仓内的资产工厂脚本必须存在、可被 node --check 之外的方式读到、并且
// 明确产出上面每一条 assets/ 路径 —— 否则"重生成"只是口头承诺。
t.where('母题可复现：assets/gen/ 里的脚本真的负责这些图');
const genFiles = readdirSync(path.join(ROOT, 'assets/gen'));
t.ok('assets/gen 下有生成脚本', genFiles.length > 0, genFiles.join(','));
const genSrc = genFiles.filter((f) => f.endsWith('.py')).map((f) => read(`assets/gen/${f}`)).join('\n');
for (const rel of onDisk) {
  t.ok(`${rel} 由生成脚本产出（不是手工塞进仓的二进制）`, genSrc.includes(rel), `gen 脚本里找不到 ${rel}`);
}

// ---------- 阴性对照 ----------
t.where('阴性对照：这台尺子量得动东西');
// 每一条都喂"说谎的输入"给上面用过的同一个函数；并且配一条干净输入，
// 免得某个检查靠"永远报警"蒙过这一节。
t.ok('尺寸自洽检查会咬人：favicon-96.png 实际 48x48 必须被点名',
  sizeMismatch('icons/favicon-96.png', { width: 48, height: 48 }) !== '');
t.eq('尺寸自洽检查不误伤：favicon-96.png 真的 96x96 时无话可说',
  sizeMismatch('icons/favicon-96.png', { width: 96, height: 96 }), '');
t.ok('长宽比写法也咬：spatula-720x96.png 报成 960x96 会被点名',
  sizeMismatch('art/spatula-720x96.png', { width: 960, height: 96 }) !== '');
const notPng = pngInfo('sw.js'); // 真文件，但根本不是 PNG
t.ok('文本文件冒充位图会被签名检查抓住', !!notPng.reason, JSON.stringify(notPng));
const notThere = pngInfo('art/__definitely_not_shipped__.png');
t.ok('不存在的路径被判缺失', notThere.missing === true && !notThere.width, JSON.stringify(notThere));
t.ok('台账用的存在性判断对伪造路径回答"不在盘上"', exists('art/__definitely_not_shipped__.png') === false);
t.ok('生成脚本漏登记一张图时，provenance 检查会红',
  !read('assets/gen/make_art.py').includes('art/__definitely_not_shipped__.png') &&
  onDisk.every((p) => read('assets/gen/make_art.py').includes(p)));

const shellBytes = SHELL.filter(exists)
  .reduce((a, p) => a + statSync(path.join(ROOT, p)).size, 0);
console.log(`#   本地引用 ${refs.size} 条 · 模块图 ${graph.length} 个 js · 离线壳 ${SHELL.length} 项 / ${(shellBytes / 1024).toFixed(1)} KB · 磁盘位图 ${onDisk.length} 张`);

t.done();
