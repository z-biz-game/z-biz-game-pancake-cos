# 设计文档 · 烙饼 Pancake

这份文档讲"为什么这样写"，不重复 README 的玩家视角。所有数字都是 2026-09-28 那一轮在本机
（node v26.8.1 / macOS 26.6.2 / Chrome 154.0.8037.57 / Apple M5 Pro 15 核）读到的观测值；
引用代码一律用**文件 + 符号名**，不用行号——行号会随一次注释漂移，漂了就把文档里的证据变成误导。

---

## 1. 状态空间：一个整数就是一个局面

`js/engine/perms.js` 提供 Lehmer 阶码 `rank` / `unrank`，把 `n` 层的全排列双射到 `[0, n!)`。
焦边多了每张饼的朝向，于是：

```
code = lehmer(order) * (burnt ? 2^n : 1) + bits      // bits 的第 i 位 = 深度 i 的饼焦面是否朝上
```

这个式子是整个引擎的支点，它带来三件事：

- **距离场是一个 `Int16Array(size)`**，下标就是 `code`，不需要 Map、不需要哈希、不需要访问标记数组。
  `js/engine/graph.js` 的 `field(n, burnt)` 从 goal 出发做 BFS，队列是同一个 typed array 的两端指针。
- **翻转是对合（involution）**：同一铲翻两次回到原状。BFS 因此可以"翻下去、记距离、翻回来"原地走，
  不必复制排列。`test/perms.test.mjs` 逐 n 断言这个对合性，`test/graph.test.mjs` 在 n=6/8 普通与
  n=5 焦边上把整张距离场与一个**独立实现的局部 rank + 局部翻转**逐 code 对账。
- **一次建图，处处复用**：出货、复核、提示、随机模式调的都是同一个 `field`。距离场按 `(n, burnt)`
  缓存在模块级 Map 里，所以 `[table]` 腿在浏览器里重算 23 行只要几十毫秒。

## 2. 三个测量值，不是三个形容词

每行出货记录带三个由距离场算出的数（`js/engine/make.js` 的 `measure`）：

| 字段 | 定义 | 玩家的读法 |
| --- | --- | --- |
| `par` | 到 goal 的真最短步数 | 下界：没有更短的路 |
| `starts` | 首铲里仍留在最短路径上的种数 | `1` 表示另外 14 种点下去就要多走路 |
| `detour` | `1 + max(邻居的 par) − par` | 最坏第一铲的代价 |

`detour` 的公式被 `test/graph.test.mjs` 独立复核：它自己重数邻居、自己求 `maxNeighbour`，再要求
`measure()` 报的值等于 `1 + maxNeighbour − d`。这条断言钉的是公式，不只是数值。

`par < 0` 不可能，`over = 步数 − par` 因此也不会是负的——但 **HUD 上会**：`js/game.js` 的
`over` 是 `tape.length − par`，开局就是 `-2`。这不是 bug 而是未定义域，界面必须 clamp：
`js/main.js` 的 `updateHud` 把"还没花到 par"显示成 `0`，只有真的多花了才写 `+n`。
（这一条是浏览器闸抓出来的：`[play]` 腿在开局断言 `#hud-over` 为 `0`，读到 `-2` 就红。）

## 3. 图的事实决定了阶梯能怎么画

普查（`test/graph.test.mjs`）里最反直觉的一条：**在最远的环上，难度是往下掉的**。普通六层里
par = 直径 7 的 2 个对跖点都有 5 种最优首铲，七层的 35 个有 5–6 种，八层的 455 个最少也有 3 种，
六层焦边那唯一一个直径 12 的局面有 6 种——直径处恰恰是全图最不被逼死的地方。
"`par = 直径 且 starts = 1`" 并不是空集，只是小：两层普通图有 1 个，五层普通图在直径 5 的 20 个里
有 5 个，`pk-reg-1` 就是出货的那一个（`par 5` 等于该图直径 5、`starts 1`、`detour 1`）。
但六层往上就再没有可买的，所以 `exp`／`master` 两档把 `par` 停在直径下一到两步，
用 `starts === 1` 与更大的 `n` 换陡峭度；填不满配额时 `bake.mjs` 抛错，这是给谓词失效兜底的机制。
`js/engine/tiers.js` 顶部把这段推理写成注释，谓词表就是它自己：

```js
{ n: 8, burnt: false, want: 2, ok: (m) => m.par === 8 && m.starts === 1 }
```

填不满配额**不放宽**：`js/engine/library.js` 的 `buildRows` 直接 `throw`，措辞是
"the predicate is unreachable, not relaxed"。一个绿的闸 shipping 一个说谎的阶梯，比一个红的 CI 糟得多。

> 这一节初稿写的是"数学上为空 / 唯一最优首铲只出现在直径严格之下"，被自己的出货表推翻了：
> `pk-reg-1` 就站在直径 5 上。三处文案改成"对出货尺寸成立、对 n=5 不成立"，反例连同缺失一起进测试——
> 断言不存在的同时断言存在，推理就不会再被写成定律。

## 4. 出题器必须跨引擎同构

`js/engine/make.js` 的 `sample` 用 mulberry32，**没有 `Math.random`、没有 `Date.now`**。原因很直接：
node 里量出来的表要能在 Chrome 里逐字节复现，否则 `[table]` 腿复核的是另一份数据。`sort` 比较器里
抽随机数会画两张盘（这个坑在别的仓踩过并记着），所以抽样是纯计数循环 + 整数哈希。

随机模式（`sampleLevel(tier, seed)`）的 seed 来自 URL 或"换一局"的持久计数器，同样不读时钟。
默认 seed 若按日期算，界面就会在你说"换一局"的时候端回今天那盘——仓里四个持久键都是显式的
（`pancake.progress.v1` / `.theme.v1` / `.sound.v1` / `.seed.v1`）。

## 5. 几何只在 `js/view.js` 里有一份

`rectFor(depth, n, sizes)` 是唯一的大小/位置来源：绘制用它、`depthAt(clientX, clientY)` 命中测试用它、
闸里的 `pointFor(k)` 也用它。这不是洁癖——命中盒与像素分家之后，"看着能点其实点不到"这类缺陷只有
在真浏览器里才暴露，而闸如果用自己算的一套坐标，就等于在测自己的算式而不是测页面。

`[hit]` 腿的断言顺序是刻意的：**先**证明 `document.elementFromPoint(p.x, p.y) === canvas`（点真的
落到了画布上，中间没有别的盒子挡着），**再**断言 `depthAt` 报的深度与 `p.depth` 一致。反过来的话，
一个被遮挡的控件会让"点不动"看起来像命中逻辑的 bug。

`geom()` 里带 `press`（当前铲位）也是闸逼出来的：`[reject]` 腿要断言"抬手之后不再显示铲位"，
而 `geom()` 一开始没暴露这个字段，那条断言于是恒真——一个永远绿的检查比没有检查更糟。

## 6. 主题：JS 解析成具体一套，CSS 只留一份

`js/theme.js` 把 `auto` 通过 `matchMedia('(prefers-color-scheme: light)')` 解析成 `light` / `dark`
之一，**永远**把 `data-theme` 写成具体值。于是 CSS 里每套配色只有一份声明，不存在 media query
副本与 override 互相漂移的问题。

画布的颜色全部走 token（`view.js` 的 `cssColor` / `mix` / `withAlpha`）：盘子 `--plate`、铲位线
`--warn`、计数列 `--bad` 与 `--ink-dim`、饼面数字 `--label-ink`、描边 `--stack-line`。饼本身的
熟度色（`--pancake-plain` / `--pancake-burnt` / `--pancake-edge`）在两套配色下不变——那是食物，
不是灯。这个区分让 `[theme]` 腿有意义：**换皮必须能在像素上看见**（盘子像素移动），同时
"饼还是那张饼"（焦边像素不动）。

两处踩过的坑写进了代码注释：
- `ctx.fillStyle = 'var(--x)'` 是死代码，canvas 不解析 `var()`；必须 `getComputedStyle` 取值。
- `[hidden]` 需要自己的 `display: none !important`：任何给区块设了 `display:grid` 的规则都会盖过 UA
  样式表，让"隐藏的关卡表"其实占着位。`[boot]` 与 `[layout]` 腿都断言隐藏区块的
  `getClientRects().length === 0`。

## 7. 音效：闸听不见，但读得到

`js/audio/synth.js` 每次 `play(name, notes)` 都**先**把 `{name, at, notes}` 推进 24 条的
`history`，**再**看开关与 AudioContext。于是"拒绝的声音和翻动不一样""静音也留痕"这类断言变成对
数据的检查，而不是对耳朵的请求。`AudioContext` 懒建、且硬失败之后不再重试：没有输出设备或被策略
挡住时，游戏应当安静而不是坏掉。

翻动音此前**根本没被调用过**（只有 `reject` / `hint` / `solve` 接了线）——`[reject]` 腿在合法翻动之后
读 `history[0].name`，读到空数组直接把整腿炸出 `TypeError`，这就是那条腿存在的价值：一个静默的
失败路径和一个静默的成功路径长得很像。

## 8. 存档：逐条解析，空覆盖要拒绝

`js/store.js` 不用 `try { JSON.parse } catch { return [] }`。一个 blob 解析失败时，它按大括号深度
**逐条**扫出还能读的 JSON 对象，保留幸存者，把原始字节另存 `…progress.v1.corrupt` 隔离区，并在
`problems` 里记账。写盘时同样两件事先做：payload 逐条 encode（编不进去就整次写失败），以及
**空进度覆盖非空存档直接 refuse**（`refused-empty-overwrite`）。存档失败应该是丢一次更新，
不该是把玩家的 23 关抹掉。

## 9. 浏览器闸的工程细节

`tools/verify.sh` 的结构本身是被缺陷教出来的：

- **一条腿一个 URL**（`?leg=<name><n>`）。只改 fragment 的导航复用同一个文档，"重载续局"那条腿
  于是会变成上一腿对自己断言。
- **驱动拒绝假导航**：`tools/playtest.cjs` 的 `navigate()` 先给当前文档盖章（`window.__preNav = 1`），
  导航后必须读到**没有章**的文档才返回，否则抛 "navigation never committed a new document"。
- **`timeOrigin` 证人**：`[save]` 腿写下本页 `bootAt`，`[reloaded]` 腿比对两者相差 > 1 ms。文档没死
  就过不了这条腿。
- **Emulation 是 per-session 的**：`playtest.cjs metrics` 那个进程一退出，覆写就没了。所以窄屏腿靠
  `EMULATE=380x780x2` 在**同一个** CDP 会话里、在首次导航之前设好；URL 还带 `?want=narrow`，腿里
  先断言 `innerWidth ≤ 520 && devicePixelRatio ≥ 2`，覆写没生效就红，不会把桌面的 25 条当成手机的 27 条。
- **默认 origin 会咬人**：`playtest.cjs` 用 `BASE_URL` 的 origin 决定附加到哪个标签页。prefix 形态
  跑的时候若 boot 探针漏了导出 `BASE_URL`，探针就会去问一个 `about:blank`，报"应用从没启动"。
  现在 `run_shape` 一进去就 `export BASE_URL`。
- **每条腿的 tally 文件**：汇总读 `$LOGD/<shape>-*.tally`，数"报告过的腿数"。腿要是死在半路没打印
  结果，这里会显示 `12/13` 并判红——只看失败计数会把它读成"少跑了一条无关紧要的腿"。
- **NO-CHECKS-RUN 守卫**：`rows` 为空的报告判红。断言数为 0 的腿不能算绿。
- **看门狗重定向 fd**：`( sleep …; cleanup ) </dev/null >/dev/null 2>&1 &`，否则后台子 shell 继承
  管道写端，脚本结束后 stdout 迟迟不收尾，CI 的日志会被拖住。
- **不加 swiftshader**：好几条腿读回画布像素，软件光栅化会让它们说谎。
- **端口是本仓的**：5266（root）、5267（prefix）、9386（CDP）。5173 是别的工具的常用端口，而且一个
  长期活着的 5173 会乐呵呵地端出**另一个仓**的 index.html。所以闸起来先 `curl` 一次，抓到的字节里
  必须有 `pancake` 字样才继续。

## 10. 场景层：只读页面，不读旗标

`tools/scenarios.js` 的规矩：**断言 DOM、几何、像素、localStorage 的字节**，不断言内部布尔。
`solved === true` 说的是代码的想法，`#win` 有没有 client rect、`localStorage` 里那条记录的 `best`
是多少、盘子上那个像素是不是 `--plate`，说的才是玩家拿到了什么。

所有输入都走真实入口：指针事件打在 `pointFor(k)` 报的客户端坐标上、按钮 `.click()`、真
`KeyboardEvent` 打在 `document.activeElement` 上。`solveAll()` 也是驱动 `onFlip` 而不是
`game.flip`，所以一条绿的通关腿顺带把动画回调、HUD 重绘和写盘都跑过了。

`[table]` 腿额外做了"闸自己的闸"：当场把一行 `par` 抬高、把堆叠颠倒、把 `code` 推出状态空间、
塞一个 `par = 0` 的行，要求 `checkRows` 逐条骂出来。复核函数坏过一次不会有人知道，除非有人每次
都故意弄坏一次数据。

## 11. 观测值（本轮）

| 项 | 读数 |
| --- | --- |
| `node tools/bake.mjs --check` | 23 行重算 61 ms（复跑过 45–61 ms，只当量级看）；`n=8 plain` 40 320/40 320 直径 9；`n=6 burnt` 46 080/46 080 直径 12 |
| `npm test`（六套） | 431 条断言，1.6 s，0 失败 |
| `bash tools/verify.sh`（双形态） | 每形态 13 腿 / 388 条，0 失败；整跑 41 s |
| 稳定性 | 同一命令连跑两遍，逐腿条数完全一致（15/22/28/44/32/45/49/18/16/22/45/25/27） |
| 远端 `cf1597a` | Actions：CI 与 Deploy to GitHub Pages 两个 workflow 均 `completed / success`；CI 的 11 + 7 个 step 全 success |
| 已部署站点 | `BASE_URL=https://z-biz-game.github.io/z-biz-game-pancake-cos/ bash tools/verify.sh` → `shape=custom: 13/13 legs · 388 checks · 0 failed` |
| runner 自己的条数 | **没取到**：jobs raw log 这一轮先是 TLS 抖、换签名 URL 又 403，所以只引上面的 step 状态，不代 runner 报条数 |
| 出货规模 | 6 档 23 关；普通最重八层，焦边最重六层 |
