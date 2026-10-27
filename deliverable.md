# 烙饼 Pancake · 前缀翻转排序 · 交付卡

> 本文件由 `003_辅助能力/audit/script/gen_deliverable.py` 从本仓 README、package.json 与 `git ls-files` 生成，**不要手改**；改源后重跑，`--check` 必须逐字节一致。
> 读数取自本仓 `git ls-files` 与 package.json，均不含本文件自身；这里不写提交号，所以 `--check` 比的是内容，不是时间。

## 一句话

一摞大小各不相同的饼。一次操作只能把铲子插到某张饼下面，把那张饼和它上面的一切整段翻回来。

- 仓名：`z-biz-game-pancake-cos`　组别：E · 生成艺术与交互视觉
- 技术栈：Electron + Canvas

## 怎么跑

```sh
npm start    # node server.cjs
```

## 怎么验

| 层 | 命令 |
| --- | --- |
| 整仓门禁 | `bash tools/verify.sh` |
| 单元/规则测试 | `npm test` |
| npm verify | `npm run verify` |

## 规模

| 指标 | 读数 |
| --- | ---: |
| 跟踪文件 | 61 |
| 应用代码 | 3,795 行（JS 2,899 / CSS 770 / HTML 126） |
| 测试/工具文件 | 18 个 |
| 依赖 | `dependencies` 0 / `devDependencies` 0 |
| 位图资产（不含 shots） | 13 个 / 563 KB |

## 目录

```
.github .gitignore DESIGN.md LICENSE README.md art assets css icons index.html js manifest.webmanifest package.json server.cjs sw.js test tools
```

## 已知边界

- **直径处几乎买不到"起手唯一"**，而且方向是反的：越远的环，最优首铲越多。普通六层的 2 个对跖点
  各有 5 种、七层 35 个各有 5–6 种、八层 455 个最少也有 3 种；六层焦边全图只有 1 个局面在直径 12 上，
  它有 6 种。所以高手／烙饼师这两档把 `par` 停在直径下一到两步，用 `starts === 1` 换陡峭度。
  这不是定理：五层普通图直径 5 上的 20 个局面里有 5 个起手唯一，`pk-reg-1` 就出货了其中一个
  （`par 5 = 直径 5` 且 `starts 1`）。两侧都在 `test/graph.test.mjs` 里断言，注释不能大得过数据。
- 出货最重的一摞是**八层**（40 320 个局面）。九层 362 880 只在测试里跑，不在关卡表里。
- 六层焦边是出货的最重焦边阵（46 080）；七层焦边 645 120 个局面没进表，也没进 CI 的墙钟。
- 浏览器闸需要本机有 Chrome（或设 `CHROME_BIN`）。它读画布像素、发真指针事件，所以没有 jsdom 替代。
- 提示给的是答案不是方向：一旦用过，这一关在这一台机器上就永久带标记。这是设计，不是 bug。
- **暂停冻的是仿真，不是模型**。本仓没有计时器，唯一持续推进的仿真就是翻牌那一段缓动（`anim.t` 靠
  `performance.now()` 的差推进），所以暂停 = 停掉 rAF 心跳、恢复时把 `anim.start` 后移暂停时长。
  按下暂停后**仍然下得去手**：那一铲走 `view.animateFlip` 的暂停分支直接落定、不排缓动（`[pause]` 腿
  把这两条都写成断言，改天想挡输入得先改这条边界）。

## 证据

- 重跑：在 lead 仓根执行 `python3 003_辅助能力/audit/script/gen_deliverable.py ../z-biz-game-pancake-cos --check`，应与本文件逐字节一致。
- 漂了就重跑并复核读数变化：新增文件、改 README 的边界小节、加/删闸都会让它变，这些变化本身就是要看的内容。
