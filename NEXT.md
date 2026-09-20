# 下一步可做的事（交接清单）

> 更新于 2026-09-20。字段级逆向细节见 README，本文只列**优先级、入口、阻塞与工作量**。

## 现状一句话

**9 个工具**可用：`get_file_meta` / `list_pages` / `get_file_nodes` / `get_page_tree` / `list_styles` / `list_text_styles` / `list_effect_styles` / `list_variables` / `list_components`。

- 节点树：legacy 828/828（0 错判）、modern 命中 8.3%（容器仍返回 `null`）
- **样式与变量：已全面打通**，与浏览器真值逐条一致 —— 颜色 38/38、文字 13/13、效果 6/6、变量 57/57
- **组件：已打通（2026-09-20）**，`list_components` 交付，火车票 96/96 与真值一致

---

## 🔑 2026-09-20 的关键突破（先读这段）

### 0. 真值导出链路已打通 —— 旧文档说的「做不了」已不成立

旧版本文档（及本文件上一版）反复强调一条阻塞：

> `browser-skill` **不支持任意页面 JS 求值**，因此 `window.mg` 真值导出做不了

**这条现在不成立**。当前会话的浏览器工具支持在页面里执行任意 JS（`browser_execute`），
于是 README 里那套「`evaluate_script` 调 `window.mg` 导真值」的方法论**完全可用**。

实测 `window.mg` 是完整的插件 API（99 个键），关键导出函数：

| 用途 | 函数 |
| --- | --- |
| 颜色样式 | `getLocalPaintStyles()` |
| 文字样式 | `getLocalTextStyles()` |
| 效果样式 | `getLocalEffectStyles()` |
| **变量** | `variables`（object）→ `getCollections()` / `getVariables()` / `getModes()` / `getGroupList()` |
| 组件 | `getComponentListVal()` |
| 旧文档完全没提到 | `getLocalGridStyles` / `getLocalPaddingStyles` / `getLocalSpacingStyles` / `getLocalCornerRadiusStyles` / `getLocalStrokeWidthStyles` |

**导出真值的可复用做法**（避免大 JSON 手工搬运）：

1. 页面里把真值 `JSON.stringify` 后挂到 `window.__T`
2. 起一个本地接收器（见 `.cache/post_server.cjs`，`node .cache/post_server.cjs <out.json> 8787`）
3. `browser_execute` 里 `fetch('http://127.0.0.1:8787/', { method:'POST', body: window.__T })`
   —— HTTPS 页面 POST 到 `127.0.0.1` 不会被拦（localhost 属 potentially trustworthy），
   接收器回 `Access-Control-Allow-Origin: *` 即可

> 注意：页面里 `a.download` + Blob 触发的自动下载**会被浏览器拦截**，别走那条路。

### 1. 样式索引表结构已破解（两套编码）

记录格式：

```
01 <id> \0 02 <name> \0 03 61 <c> \0 [04 <desc> \0] 05 <n> [子块] 00 00 [06 01] 07 <ukey> \0
```

- **`05 <n>` 才是类型判别式**：`1`=PAINT、`2`=EFFECT、`3`=TEXT（实测 57/57 纯净、零杂音）
- ⚠️ `03 61 <c>`（a0/a1/aL…）**不是**类型：同类型的 c 各不相同（Purple=aL、Yellow=a1、Success=aF），只是个序号
- **两套 ukey 编码**：新文件只存 `+<selfId>`（**不含 fileId**），旧文件存 `<fileId>+<selfId>`
- `04 <desc>` 与 `06 01` 均可整体缺省（旧编码常见 `06 01`，新编码没有）

### 2. 「变量」与「样式」是同一批对象（纠正旧文档）

用浏览器真值交叉验证：

```
样式 id 集合（paint 38 + text 13 + effect 6 = 57） == 变量 id 集合（57），双向完全包含
变量 type 分布恰为 { PAINT: 38, EFFECT: 6, TEXT: 13 }
```

即 `getLocalPaintStyles()` 等只是**按 type 过滤的视图**，`variables.getVariables()` 是**统一视图**。
**破解变量 = 破解样式，同一张表**，工作量减半。

同时 `collectionId:"M:1"` / `modeId:"M:2"` 是**真实 id**（真值 `getCollections()` 返回
`[{id:"M:1", name:"集合", modes:[{id:"M:2", name:"模式 1"}]}]`），
旧文档「二进制中没有独立 collection 表、疑似客户端默认构造」的推测**是错的**。

### 3. `list_styles` 漏检 bug 已修（现有功能的真实缺陷）

旧实现要求 `ukey.startsWith(fileId + "+")`，而新编码的 ukey 是 `+0:26620`（无 fileId），
导致「移动端界面设计」文件上 **返回 0 条**（真值 38 条）。现已改为：

- 用 `07 <ukey> \0` 作锚点（样式记录独有，可排除大量形似的节点记录）
- 本文件判定：`+<id>` 视为本文件；`<fid>+<id>` 则比较 fid
- 另一个隐藏 bug：paint 定义表里 paint 图元 id 是 `:005`（**省略数字前缀**），
  被严格的 `ID_RE` 整条跳过 → 所有样式颜色解成 `null`。已引入 `PAINT_ID_RE` 放宽。

---

## P0 · 已完成

- **608 个 autoLayout 错判定位** —— 结论：DatePicker 组件库实例的布局被客户端主题覆盖，
  二进制存定义值、浏览器存覆盖值，**无可靠二进制判据，按宁缺毋滥不回填**（详见 README）。
- **legacy 格式 COMPONENT 识别** —— 已补齐（复用 modern 的零假阳性 `selfUkey` 判据）。
- **文字样式 / 效果样式 / 变量** —— 已实现并交付 3 个工具（原 P1 全部三项）。
- **组件索引表** —— ✅ 已实现 `list_components`（2026-09-20），火车票 96/96 与 `getComponentListVal()` 真值一致，详见 README ④。

---

## P1 · 有真值就能继续做（真值导出已通，门槛只剩「取样」）

### 4. 效果样式的 `09`/`0b` 缺省规律 ⭐ 最值得做
- **现象**：效果定义表里 `09`(radius) / `0b`(offsetY) 会**整字段缺省**，而缺省**不等于 0**。
  实测 `0:3140` 无 `0b` 但真值 offsetY=4；`0:7861` 某条无 `09` 但真值 radius=10。
- **为何难**：当前文件只有 **6 个效果样式**、8 个效果项，样本太少。
- **入口**：用浏览器打开一个**阴影样式多、且 offsetY/radius 取值分散**的设计稿，导真值，
  看缺省与哪些字段相关（怀疑与某个「默认值继承」或 `05 <n>` 计数有关）。
- **收益**：`list_effect_styles` 的 radius/offsetY 从「有字段才给」变为完整。
- **另需取样**：`offsetX` / `spread` / `type`（INNER_SHADOW / LAYER_BLUR / BACKGROUND_BLUR）
  在现有素材中**全部是默认值**，无从验证。

### 5. 渐变样式的 stops 多色解码
- 真值已拿到（`gradientStops` 含 position + RGBA、`gradientHandlePositions`、`transform`、`type`），
  但二进制里渐变 paint 的多色 stops 尚未定位。现有实现只标记 `kind`，`color` 为 `null`。

---

## P2 · 纯工程，不依赖真值

### 7. 回归测试扩展 —— ✅ 已完成（2026-09-20）
- `npm run test:regress`（**legacy 守卫，CI 可跑**）：节点类型 828/828 + 0 错判，**并已加入火车票 paint 样式断言 4 条**
  （`渐变` / `f1f4fb` / `1` / `2`，含 ukey 前缀校验）与「文字样式 0 条」断言。
- `npm run test:styles`（**modern 守卫，不进 CI**）：对照 `test/fixtures/truth_mobile_kit.json`（已入库，68KB）断言
  颜色 **38/38**（SOLID 逐值 RGBA）、文字 **13/13**（fontSize/lineHeight/字体名）、效果 **6/6**、变量 **57/57**。
  需 `.cache/mg_mobile_kit.bin`（私有文件快照，6.2MB，不入库；缺失时脚本提示并跳过），或用 `MG_STYLE_SRC=<路径>` 指定。
- **为什么两套都要**：legacy 与 modern 是**两套 ukey 编码**，只测一个极易改坏另一个 ——
  `list_styles` 漏检 bug 正是「modern 返回 0 条、legacy 看起来完全正常」。

### 8. 打包发布 —— ✅ 已完成（2026-09-20）
- `package.json` 已补 `bin`（`mastergo-mcp` → `dist/index.cjs`）/ `files`，用 esbuild（`scripts/build.mjs`）出单文件 CJS，
  免 `npx tsx`、免 node_modules。
- `npm run build`（tsc）+ `npm run build:bundle`（`node scripts/build.mjs`）→ `dist/index.cjs`，spawn 校验可启动到 MCP server 就绪。

### 9. 设计稿差异对比（切图导出已暂缓）
- diff：基于现有 `get_page_tree` 输出做两份快照的节点 diff，不阻塞。
- 切图 / 图片导出：**⚠️ 暂不考虑**（`window.mg` 里未见导出函数，逆向难度高）——**明确不主动做**，待开发者后期指明要求后再启动。

---

## P3 · 已知局限（已评估，暂不建议动）

| 项 | 现状 | 为何搁置 |
| --- | --- | --- |
| modern 的 FRAME / COMPONENT_SET | 返回 `null` | 段内无结构判别式（~1500 样本/类型、220B 窗口 n-gram 搜索无果）；宁可判空不猜错 |
| COMPONENT_SET vs COMPONENT | 折叠为 COMPONENT | 最优候选判别式精确率仅 79%，会误标 7 个 COMPONENT |
| 255 条「容器→LINE/RECTANGLE」 | 错判 | 让容器块压过叶子标记精确率仅 55% |
| 文字样式的 textCase / decoration / letterSpacing | 未输出 | 现有 13 个样式里这三个字段**全是同一个值**（ORIGINAL / NONE / 0），无法验证枚举语义 |
| 变量 scopes / codeSyntax / 多模式 | 未输出 | 二进制内未定位到 scopes 字段；本文件只有 1 个模式 M:2，多模式无从验证 |

---

## 环境与踩坑备忘

**构建与运行**（2026-09-20 在 macOS / Node 24 实测通过）
- `npm run build`（tsc）✅ 通过
- `npm run test:regress` ✅ PASS：828/828 = 100%、0 错判（**匿名下载** 47MB 公开文件，CI 可跑）

**素材位置**（`.cache/` 已 gitignore，不入库）
| 文件 | 说明 |
| --- | --- |
| `test/fixtures/truth_mobile_kit.json` | **已入库**：移动端界面设计全部真值（样式 57 + 组件 144 + 变量 57 + 集合/组），供 `npm run test:styles` 使用 |
| `.cache/mg_mobile_kit.bin` | 该文件 `/data` 快照，6.2MB |
| `.cache/train_ticket.bin` | 火车票 `/data` 快照，47.9MB（公开） |
| `.cache/post_server.cjs` | 真值导出用的本地 POST 接收器 |

文件 id：
- 移动端界面设计（**私有**）`107389953208823` / fileKey `2b195a62-0d3e-40ee-b55f-59b607e729a0`
- 火车票（公开）`115278536821990` / fileKey `890c5c78-a533-4751-91ef-06e3fbb70d5e`

**`/data` 接口三个反直觉特性**
1. **不可字节复现**：同一未变动文件连续下载 md5 不同 → 回归按结构比对，别用 md5 / 整文件 diff
2. **忽略 `Range`**：带 `Range` 仍返回 200 + 完整 content-length
3. **公开文件无需任何认证**；私有文件才需要 Cookie（可用浏览器会话直接下载）

**紧凑浮点编码**（反复用到）
`tag`(1 字节) + 3 字节小端尾数，`value = (2²⁴ + intLE) · 2^(tag−151)`。
自检：`82 00 00 80` → 12；`83 00 00 10` → 17。**0 值单独用 1 字节 `00` 表示**（不写 4 字节）。

**写探针的约定**
- `probe_*.mjs` 放项目根目录，**验证后删除**（本仓库既有约定）
- 用 `npx tsx probe_xxx.mjs` 可直接 import `./src/node-tree.ts`

**工具限制（已过时，勿再引用）**
- ~~`browser-skill` 不支持任意页面 JS 求值~~ → **当前会话已支持**，`window.mg` 真值可导出
