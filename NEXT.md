# 下一步可做的事（交接清单）

> 生成于 2026-09-19，对应提交 `3eb9564`。字段级逆向细节见 README「待实现能力 / 接手指南」，本文只列**优先级、入口、阻塞与工作量**。

## 现状一句话

`get_file_meta` / `list_pages` / `get_file_nodes` / `get_page_tree` / `list_styles` 五个工具可用；节点树在 **legacy 格式**（火车票）实测 828/829 = 99.9%、0 错判，**modern 格式**（Ant Design 5.0）命中 8.3%、错判 0.41%（FRAME 等容器返回 `null`）。

---

## P0 · 有明确线索，本地就能做（不阻塞）

### 1. 定位那 608 个节点的布局值覆盖来源
- **现象**：autoLayout 的 `itemSpacing` / `padding` 错判**高度集中**——各字段 top1 错判都是同一批 **608 个节点**（`itemSpacing 0→10`、`paddingTop 6→1`、`paddingRight 6→3`…），占该字段全部错判的 ~90%。
- **已有线索**：几何段内 `2a {"tokens":...}` 令牌覆盖、或值由父级/母版继承（实例内部节点 id 含 `/`，其 `1c 07` 块省略布局字段）。
- **入口**：把这 608 个节点 id 导出，与父节点/母版节点的布局值对照；确认是「继承」还是「令牌覆盖」。若是继承，可给 `autoLayout` 补一个 `inherited` 标记或回填父值。
- **收益**：`itemSpacing` 98.03% → 可能接近 100%，padding 四边同理。
- **素材**：`ad_src.bin` + `ad_truth.json`（都在 `%TEMP%/Trae/tools/`），无需网络。

### 2. legacy 格式的 COMPONENT 识别 —— ✅ 已完成（2026-09）
- **结论**：已补齐。legacy 文件中可能嵌入 modern 容器块（`1c 07 01 01`，组件库/混合格式），在 legacy 分支复用 modern 的零假阳性判据 `b===0x07 && c===0x01 && hasSelfUkey` → COMPONENT。实测火车票 3 个组件根下识别出 **87 个 COMPONENT**（如「组件/Checkbox」），PAGE 树回归 828/828、0 错判，误伤为零。
- **实测关键**（与本文原文预测不同）：火车票这 100 个带 selfUkey 的节点**全部挂在「组件根」下**（`6846:53669`、`5026:42651`、`11458:99555`），**不在用户 PAGE 树** `10371:87078` 内。因此原来「828/829 未覆盖」是为真的，但**当前 `get_page_tree`（按 PAGE 根）并不会输出它们**——只有对组件根调用时才会暴露，修复主要服务于组件根场景。
- **已验证免回归**：改动只在 `format==="legacy"` 分支；AD 稿（modern，`1c 07 01 01` 占比 49.8%）不进入该分支，逻辑零影响。
- ⚠️ **已证伪的思路**：不要再用「首个 `1c` 块第 2/3 字节试 `01/02/07/08`」（README ④ 原文建议）。modern 下容器块统一为 `1c 07 01 01 02 00 …`，试值法完全失效。

---

## P1 · 有真值就能做（**阻塞在真值导出**）

### 3. 文字样式（Text Styles）/ 效果样式（Effect Styles）— 原列表 ②③
- **阻塞**：需要「含文字/效果样式的设计稿 + `getLocalTextStyles()` / `getLocalEffectStyles()` 真值」。火车票文件里 0 个文字样式、0 个效果样式。
- **真值怎么来**：README 假设用 chrome-devtools MCP 的 `evaluate_script` 调 `window.mg`。**但本会话的 `browser-skill` 明确不支持任意页面 JS 求值**，这条路当前走不通 → 需要你手工在浏览器 console 导出 JSON，或换一个支持 `evaluate_script` 的工具。
- **入口**：README 接手指南 ②/③ 有具体步骤（搜 `+<styleId>` 定位聚合记录、比对 paint 样式那种 `03 61 <subtype>` 结构）。

### 4. 变量 / Design Tokens — 原列表 ④
- **阻塞**：同上（真值），且 `window.mg` 里 variables 的导出函数名都还没确认。
- **入口**：README 接手指南 ⑤。

---

## P2 · 纯工程，不依赖真值

### 5. 回归测试脚本（**我建议优先加**）
- **动机**：本次连续踩到三个坑——两套容器编码、`/data` 响应不可字节复现、`Range` 被忽略。没有回归守卫，下次改 `decodeNodeType` 很容易悄悄退化。
- **可行性**：火车票文件是**公开文件**（`isPublic: true`），**匿名即可下载**，所以 CI 也能跑。829 条真值 JSON 只有约 270KB，可以入库。
- **做法**：`npm run test:regress` → 下载 `/data` → 逐根 `parsePageTree` → 断言 828/829、0 错判。**注意**：必须按结构比对，不能比 md5。
- **代价**：每次跑要下载 47MB（缓存后 ~2s 解析）。

### 6. 打包发布 — 原列表 ⑧
- `package.json` 补 `bin` / `files`，用 esbuild 出单文件，免 `npx tsx` 依赖。当前 `npm run build && node dist/index.js` 已可用。

### 7. 设计稿差异对比 — 原列表 ⑥
- 基于现有 `get_page_tree` 输出做两份快照的节点 diff（id/名称/类型/几何）。不阻塞。

### 8. 图片 / 切图导出 — 原列表 ⑤
- **先调研**：MasterGo 是否有可用的导出 HTTP 接口（本会话未查）。若只有前端渲染路径，可能做不了，需先确认可行性再动手。

---

## P3 · 已知局限（已评估，暂不建议动）

| 项 | 现状 | 为何搁置 |
| --- | --- | --- |
| modern 的 FRAME / COMPONENT_SET | 返回 `null` | 段内无结构判别式（~1500 样本/类型、220B 窗口 n-gram 搜索无果）；宁可判空不猜错 |
| COMPONENT_SET vs COMPONENT | 折叠为 COMPONENT（48 例错判） | 最优候选判别式精确率仅 79%、会误标 7 个 COMPONENT、只多命中 27 个 |
| 255 条「容器→LINE/RECTANGLE」 | 错判 | 其几何段首个 `1c` 恰是叶子标记；让容器块压过叶子标记精确率仅 55%（464 条中 255 为容器、209 无真值） |
| 叶子类型在 modern 下的准确率 | **未知** | `ad_truth.json` 只含容器类型（73620/295784 = 24.9%），无叶子真值可对照 |

---

## 环境与踩坑备忘

**构建**
- WSL 下 `npm run build` 原本失败：`node_modules` 是在 Windows 装的，只有 `@typescript/typescript-win32-x64`。已补装 `@typescript/typescript-linux-x64`（`--no-save`，**未改 `package.json`**，在 Linux 下重装依赖需再来一次）。
- npm 默认缓存 `/root/.npm/_cacache` 只读 → 需 `npm install --cache ./.npm-cache`。

**git**
- 全局身份**已配置好**（`/root/.gitconfig` → `guanxin <gf__boy@163.com>`，另含 `safe.directory=*`），直接 `git commit` 即可，无需再加 `-c` 参数。
- 远端 `origin = git@github.com:Reapers702/mastergo-mcp.git`。**提交前记得 `git push`**——本清单生成时 `3eb9564` 及其后的文档改动尚未推送。

**`/data` 接口三个反直觉特性**（都实测过，README 也有记）
1. **不可字节复现**：同一未变动文件连续下载 md5 不同（长度相同、可有数千万字节差异，疑似序列化顺序随机）→ **回归按结构比对，不要用 md5 / 整文件 diff**。解析器对此稳健（已验证：4353 万字节差异的两份下载解出完全一致的 828/829）。
2. **忽略 `Range`**：带 `Range` 仍返回 200 + 完整 content-length → 别指望分段下载（客户端已按 206/200 判断并复用全量缓存）。
3. **公开文件无需任何认证**：不带 Cookie 甚至无效 Cookie 都返回 200 与完整数据；私有文件才需要 Cookie。

**真值素材**（`%TEMP%/Trae/tools/`，Windows 路径，WSL 下为 `/mnt/c/Users/Reaper/AppData/Local/Temp/Trae/tools/`）
- `mg_src.bin` 47,881,863B — 火车票 legacy 快照（**线上文件已更新为 47,882,079B**，但两者都实测通过 828/829；回归可任选，用实时下载更适合 CI）
- `ad_src.bin` 105,789,875B — Ant Design 5.0 modern 快照
- `mng_alltruth.json` — 火车票 829 条，字段名 `type`
- `ad_truth.json` — AD 稿 73620 条容器真值，字段名 `t`（**用 `n.t ?? n.type` 兼容**）
- 文件 id：火车票 `115278536821990` / `890c5c78-a533-4751-91ef-06e3fbb70d5e`（公开）；AD 稿 `204971164239455` / `eb0ea904-aa4f-4e83-863b-5071a4d386a3`（私有）

**回归怎么跑**
- 真值必须**按「所属根节点」分组**，对每个根调 `parsePageTree`（AD 稿 473 个根，全量约 **35 分钟**）。单遍扫描覆盖不到实例内部节点。
- 写 `probe_*.mjs` 放项目根目录，**验证后删除**（这是本仓库的既有约定）。

**工具限制**
- `browser-skill` **不支持任意页面 JS 求值**，因此 `window.mg` 真值导出（README 里写的 chrome-devtools MCP 路径）目前做不了 → P1 的三项都被这一点卡住。
