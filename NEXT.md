# 下一步可做的事（交接清单）

> 更新于 2026-09-21。字段级逆向细节见 README，本文只列**优先级、入口、阻塞与工作量**。

## 现状一句话

**11 个工具**可用：`get_file_meta` / `list_pages` / `get_file_nodes` / `get_page_tree` / `list_styles` / `list_text_styles` / `list_effect_styles` / `list_variables` / `list_token_styles` / `list_components` / `diff_files`。

- 节点树：legacy 828/828（0 错判）、modern 容器类型 **已打通（2026-09-23）** —— FRAME/INSTANCE/COMPONENT/GROUP 全对、
  COMPONENT_SET 191/193、容器准确率 **100.0%**（antd5 官方稿，探针34 算法：`05==1` 组件判别式 + CS 树结构 + `1a` 链跟随）；
  **叶子杂音也已修复（2026-09-23）** —— TEXT/PEN/ELLIPSE/LINE/RECTANGLE 全部 100.0%（PEN 766 个误判、TEXT 16 个误判清零，
  规则：容器/叶子嵌入块偏移 >150 忽略 + 复杂类取偏移最小、否则取最后），总准确率 130445/130452 ≈ 100.0%
- **样式与变量：已全面打通**，与浏览器真值逐条一致 —— 颜色 38/38、文字 13/13、效果 **34/34（antd5，90/90 项含全字段）**、变量 57/57；
  数值型变量（CORNER_RADIUS/NUMBER）也已解出 `floatData`，antd5 **12/12 逐值一致**
- **样式族：已打通（2026-09-22）**，`list_token_styles` 交付 —— SPACING **7/7**、CORNER_RADIUS **5/5** 与
  `getLocalSpacingStyles()` / `getLocalCornerRadiusStyles()` 真值逐条一致；族判别式取自**客户端自身枚举**
  （`05 <n>`：1=PAINT/2=EFFECT/3=TEXT/4=GRID/5=STROKE/6=CUSTOM；CUSTOM 子块 `01 <sub>`：1=Spacing/2=Padding/3=Radius/4=CrossSpacing）
- **守卫：legacy（`test:regress`）+ modern（`test:styles`）双套都在 CI 里**，modern 侧公开样本自动匿名下载，缺快照不再静默跳过而是判失败
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

- **`05 <n>` 才是类型判别式**：`1`=PAINT、`2`=EFFECT、`3`=TEXT、`6`=数值型（CORNER_RADIUS/NUMBER，实测 57/57 纯净、零杂音）
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
- **节点级渐变 fill** —— ✅ 已完成（2026-09-20）。节点 fill 引用的 `refId` 若命中渐变 paint 表，`get_page_tree` 的 `geometry.fills` 直接输出渐变（`type`/`gradientStops`/`gradientHandlePositions`），不再退回 `UNKNOWN/null`。实测「定稿5：首页火车票卡片」页面 20 个渐变 fill 节点；已加 `test:regress` 守卫（`checkNodeGradFills`）。

### 6. 文字样式的 letterSpacing（modern 编码）—— ✅ 已完成（2026-09）
- 用可编辑 antd5 文件（fileId `204971164239455`）取样：经编辑器把选中文字的**字间距**从 0% 改成 30%
  后，`createTextStyle({id:该文字层, name})` 建出带该属性的**文字样式**，再下载 `/data` 反解。
- 破析：modern 文字样式子块为 `03 字体名 04 fontSize [08 紧凑浮点 letterSpacing] 0c PostScript 12 json 13 (8B) …`，
  **`08` 即字间距紧凑浮点，仅非 0 时才出现**（0 则整字段缺省）。样本 `08 83 00 00 e0` = 30 ✓（与浏览器真值一致）。
  `08`/`12`/`13` 三个 tag 已补进 `parseTextStyleBody`，顺带修正了 modern 样式 `fontPostScriptName` 的取错（此前会误取成字体族显示名）。
- **仍缺失**：`textCase` / `decoration` 枚举语义——全部现有样式都只用了 ORIGINAL / NONE，且 `createTextStyle` 的 textCase/decor 参数
  会被忽略、编辑器里这两个控件自动化难以稳定命中，故未取样到非默认值；`letterSpacing` 的单位仅验证到 PERCENT（单一 % 样本）。

---

## P1 · 有真值就能继续做（真值导出已通，门槛只剩「取样」）

### 4. 效果样式的 `09`/`0b` 缺省规律 + 全字段解码 —— ✅ 已完成（2026-09）
- **现象**：legacy 效果定义表里 `09`(radius) / `0b`(offsetY) 会**整字段缺省**，而缺省**不等于 0**
  （实测 `0:3140` 无 `0b` 但真值 offsetY=4；`0:7861` 某条无 `09` 但真值 radius=10）。
- **破析结论**：用 Ant Design 5 文件（antd5，34 样式 / **90 个效果项**）取样后确认 —— **modern 编码下
  `09`/`0a`/`0b`/`0f` 全部显式出现、无缺省反例**，故缺省是 legacy 旧编码的历史行为，非通用规律。
  现按「字段出现则取值、未出现则输出 null」。
- **连带突破**：效果项**全字段**（color/radius/offsetX/offsetY/type/spread）已在 antd5 上 90/90 解出，
  与 `getLocalEffectStyles()` 真值逐项一致（含顺序）。`type` 用 `0d`（1=DROP_SHADOW）、`spread` 用 `0f`
  （负号=mantissa 最低字节 bit0）。**顺序规律**：同一样式多项分散在多个 `01 <effectId>` 记录且字节序
  与 API 不一致，需按 `01 <effectId>` **数字后缀降序**排序。
- **另需取样**：`type` 仅取样到 1=DROP_SHADOW，INNER_SHADOW / LAYER_BLUR / BACKGROUND_BLUR 的 `0d`
  字节值未验证；`0e` 的 2 字节语义仍未知。

### 5. 渐变样式的 stops 多色解码 —— ✅ 已完成（2026-09）
- 真值（`gradientStops` 含 position + RGBA、`gradientHandlePositions`、`transform`、`type`）已拿到并存盘 `.cache/gradient_truth.json`。
- 编码已破解并落地 `buildGradientTable` / `parseGradientAt`（见 README Roadmap）：渐变 paint 图元 `… 03 61 <sub> 00 05 <kind> 08 …`，`<kind>` 判别类型（1=LINEAR/2=RADIAL），`08` 后多色 stops + 手柄；紧凑数字 **0 压成单字节 0x00、非 0 用 4 字节浮点**；stop 颜色 **a,r,g,b** 顺序。渐变 paint 的 refId=所属样式 id，按 refId 聚合。
- 实测火车票 `渐变` 样式（`5377:50013`）两笔渐变（`5377:50015` LINEAR / `5377:50014` RADIAL）的 **stops/handles 与浏览器真值逐位一致**；其余 3 个 SOLID 样式不受影响；回归 828/828 + 样式基线 4 条通过。
- **已知局限**：LINEAR 渐变在二进制只显式存**一个**手柄（第二个由轴默认推导，未编码），故 `gradientHandlePositions` 对 LINEAR 仅 1 项（真值为 2）。`isVisible/alpha/blendMode` 未在渐变块内显式编码，不输出。`transform` 由手柄/几何推导，未解码。

---

## P2 · 纯工程，不依赖真值

### 7. 回归测试扩展 —— ✅ 已完成（2026-09-20，modern 侧 2026-09-22 重写，见 12a）
- `npm run test:regress`（**legacy 守卫，CI 可跑**）：节点类型 828/828 + 0 错判，**并已加入火车票 paint 样式断言 4 条**
  （`渐变` / `f1f4fb` / `1` / `2`，含 ukey 前缀校验 + hex 值断言）与文字样式断言。
- `npm run test:styles`（**modern 守卫，已进 CI**）：双样本 fail-closed ——
  `antd_modern`（公开 `204971164239455`，真值 `test/fixtures/truth_antd_modern.json` 已入库，缺快照自动匿名下载 `/data` 并缓存）
  + `mobile_kit`（私有 `107389953208823`，真值 `truth_mobile_kit.json` 已入库，需 `.cache/mg_mobile_kit.bin` 私有快照，缺失只跳过它自己）。
  基线（**下限**）paint 290 / text 29 / effect 34 / vars 365（= 真值条数，防漏读），并对 SOLID 颜色、文字 fontSize/lineHeight/字体/字间距、
  效果 alpha/radius/offsetY、变量 type 与数值型 `floatData` **逐值断言**。
- **为什么两套都要**：legacy 与 modern 是**两套 ukey 编码 + 两类样式短码锚点**，只测一个极易改坏另一个 ——
  `list_styles` 漏检 bug 与「modern 文字样式整表读不出」都是「一侧全绿、另一侧归零」。
- ~~⚠️ **2026-09-21 复核发现：modern 守卫实际处于「静默跳过」状态**~~ → **2026-09-22 已修**：
  原先只依赖私有快照、缺失即 `exit 0`，CI 也没挂这条。现在公开样本自动下载、**一个样本都没跑起来就 `exit 1`**，
  并且加了「快照 <64KB 判无效」的防护（Cookie 失效时 403 的 36 字节错误体曾被当成快照落盘 → 解出 0 条却全绿）。

### 8. 打包发布 —— ✅ 已完成（2026-09-20）
- `package.json` 已补 `bin`（`mastergo-mcp` → `dist/index.cjs`）/ `files`，用 esbuild（`scripts/build.mjs`）出单文件 CJS，
  免 `npx tsx`、免 node_modules。
- `npm run build`（tsc）+ `npm run build:bundle`（`node scripts/build.mjs`）→ `dist/index.cjs`，spawn 校验可启动到 MCP server 就绪。
- **文档对齐（2026-09-21）**：README「快速开始 / 启动 / 配置到 AI 客户端」已改为推荐
  `node dist/index.cjs`（`npm install` 的 `prepare` 钩子自动打包），`npx tsx src/index.ts` 降级为「开发调试」路径；
  特性表补了单文件产物一条。已实测 spawn `dist/index.cjs` → initialize → tools/list 返回 10 个工具。
- **`npm test` 已接上**（原为 `exit 1` 占位）：指向纯内存的 `test:diff`；需要网络/快照的守卫仍用各自脚本名。

### 9. 设计稿差异对比 —— ✅ 已完成（2026-09-21）
- `diff_files` 已交付：基于 `get_page_tree` 输出做两份快照的节点 diff（**纯内存，不依赖真值**），输出 added/removed/changed，changed 带字段级明细。
- `match_by`：`id`（默认，同文件不同版本，id 稳定）/ `path`（跨文件，按根→节点名称路径匹配，重名兄弟按出现次序加 `#n` 消歧；节点改名表现为 removed+added）。
- 可选 `ignore`（`name`/`type`/`geometry` 或 geometry 子字段，数字按 1e-6 容差）与 `max_changes`（默认 200，0 不限）。
- `npm run test:diff`（`scripts/verify-diff.ts`）为纯内存自检，不依赖网络/二进制。
- 切图 / 图片导出：**⚠️ 暂不考虑**（`window.mg` 里未见导出函数，逆向难度高）——**明确不主动做**，待开发者后期指明要求后再启动。

### 10. CI 与端到端验证 —— ✅ 已完成（2026-09-21，2026-09-22 补 modern 守卫 + 修缓存顺序 bug）
- **GitHub Actions**（`.github/workflows/ci.yml`）：push/PR 触发，跑 `npm ci` → `tsc` → `test:diff` → `test:regress` → `test:styles` → `build:bundle` → `test:e2e`。
  `test:regress` / `test:styles` 用公开文件（无需 Cookie）可在 CI 跑，用 `~/.cache/mg` + `actions/cache`（key **`mg-bin-v2`**）复用二进制快照，命中时跳过 47MB / 105MB 下载。
  ⚠️ **修了一个既有 bug**：`actions/cache` 步骤原先排在 `test:regress` **之后**，restore 发生在消费之后 → 缓存从未生效过。现已前置。
- **端到端**（`npm run test:e2e`，`scripts/e2e-mcp.ts`）：以真实 MCP 客户端身份 spawn `dist/index.cjs`，
  走 JSON-RPC stdio 全链路 —— initialize → tools/list（断言 10 个工具）→ 依次调用
  `get_file_meta` / `list_pages` / `get_page_tree` / `diff_files` / `get_file_nodes` / `list_styles`，
  **基于 Ant Design 5 官方公开文件（antd5，modern 格式，74 页，无 Cookie）**，首次全量下载 ~106MB、进程内缓存复用。
- **现代格式补全（2026-09-21）**：
  - `parsePageBlocks`（`list_pages` 的页面列表）新增 **modern 头部索引**解析：文件头
    `09 02 01 04 02 00 03 <count>` 后扫描 `01 <id>\0 02 <name>\0` 页面块（块后附 03/04/06 等字段，
    故按 count 扫描式提取）；legacy 双 marker 扫描保留为回退路径。
  - `parseNodeBlocks`（`get_file_nodes` 的全量节点索引）新增 **modern 节点扫描**：与 `parsePageTree`
    共用 `01 <id>\0` 语义，页面列表复用 `parsePageBlocks` 头部索引（正文里「02 非 id」记录
    可能是实例引用名，不能当页面判定），name 优先 `04` 字段、回退 `02`。
  - 实测（antd5）：`list_pages` 74 页 ✓、`get_file_nodes` 144055 节点 ✓、`get_page_tree`/`diff_files` 正常；
    miniapp_proto 3 页、proto_wireframe 2 页同样命中；legacy 火车票回归不变（55 页 / 7481 节点）。
  - ~~antd5 的 `list_styles` 返回 0 条**是预期行为**~~ → **2026-09-22 已推翻**，见下文 12。
- **样本分工（最终决定 2026-09-21）**：`test:regress` 继续用**火车票（legacy）**做 CI 回归 ——
  legacy 与 modern 是两套编码，必须各留一个守卫；火车票虽为公司内部稿，但文件本身 `isPublic`、
  匿名可下载，且真值（`train_ticket_truth.json`）与样式基线已入库，是现成可用的 legacy 样本。
  antd5 仅作为 **e2e 的 modern 样本**，不替代 regress。
- 本地实测（2026-09-21）：全链路 PASS（tools 10/10、list_pages 74 页、get_page_tree 400 节点、
  get_file_nodes 144055 节点、diff_files 汇总正确）；`test:regress` 火车票 legacy 守卫 PASS。

### 11. modern 样式守卫可复跑化 —— ✅ 已完成（2026-09-22，落地细节见下文 12a）
- **要解决的问题**：见上文 7 的 ⚠️ —— modern 编码的样式/文字/效果/变量解码现在**没有可复跑的自动化保护**
  （`test:styles` 因缺私有快照静默跳过，CI 未挂）。改 `list_styles`/`parseTextStyleBody`/效果解码时
  只能靠手工比对，历史 bug 就是这么漏过去的。
- **原建议做法**（当时以为要「另找公开 modern 文件 + 种数据」）：
  1. 找一个**公开（`isPublic`）且带本地样式**的 modern 文件。⚠️ antd5 **不行** —— 它 445 个样式 ukey
     全部来自外部团队库，本地样式 0 条（见上文 10 末尾），正好会被守卫误判成「解码坏了」。
  2. 用已打通的 `window.mg` 真值导出链路（见「2026-09-20 的关键突破」第 0 节）导一次
     `getLocalPaintStyles/TextStyles/EffectStyles` + `variables`，存成 `test/fixtures/truth_<name>.json` **入库**；
  3. `test:styles` 改成：优先读 `MG_STYLE_SRC`/本地快照，缺失时**匿名下载** `/data/{fileKey}`，
     并支持 `MG_STYLE_CACHE` 落盘供 CI `actions/cache` 复用；真值缺失时报错而非 `exit 0`。
  4. CI 挂上（新增一个 cache key，别复用 `mg-regress-v1`）。
- **实际结果与第 1 步的判断相反**：antd5 **复制稿**（`204971164239455`，公开、匿名可下载）就是合格样本 ——
  「本地样式 0 条」不是样本缺陷，而是 #12 那个漏检 bug 的表象（客户端算本地、二进制存源库 ukey）。
  守卫改的是**先修解码、再按 selfId 对照真值**，不需要给文件「种」样式。第 2~4 步按原计划做完。

### 12. 样式来源判据已改写（2026-09-22），modern 守卫已落地并进 CI —— ✅ 完成
- **发现链**（为 #11 找样本时撞出来的）：`204971164239455`（antd5 的**复制稿**，`isPublic:true`、匿名可下载）
  浏览器真值有 **290 paint / 29 text / 34 effect，全部 `remote:false`**，而 `list_styles` 返回 0 条。
  挖到记录本身在表里：`01 138:58135\0 02 中性色板/Text/colorTextTertiary\0 … 05 01 00 06 01 07 122691166044911+138:58135\0`
  —— **ukey 前缀留着源库 fileId**（复制时客户端把它重写成自己的，二进制没改）。旧判据「前缀≠fileId 就丢」→ 整批丢光。
- **已改**：`scanStyleIndex` 不再按 `isExternal` 丢记录，4 个 `list*Styles` 全部返回，新增
  `sourceFileId`（= ukey 前缀）与 `isExternal`。语义与 `list_components` 早已有的做法对齐。
  `test:regress` 基线升级为「本地 4 + 库引用 86（总 90）」并校验两字段自洽；`test:e2e` 加断言
  「antd5 条数 > 100 且 name 可正常读出」。
- **订阅表假设已证伪**（别再走）：`window.mg.teamLibrary` 确实给出订阅库（3 个，ukey 前缀
  `55113530176899`/`170598424868578`/`170601172976103`，复制稿的 `122691166044911` **不在**其中 → 客户端据此判本地）；
  但这三个前缀在该文件 `/data` 里 **0 命中**，而火车票二进制里 `55113530176899` 却有 9 条正经样式记录 ——
  **订阅关系不在二进制里**。在线接口 `GET /api/v1/users/team-libraries/styles?documentId=…` 能取到（1130 条，`key` 就是 `<libFileId>+<id>`），
  但**匿名 401**、对公开的火车票还 403 → 拿不到，进不了 CI。**结论：`isExternal` 只能表达「谁定义的」，
  不等于客户端的本地/远程；已在 README「样式来源判定」写明。**

#### 12a. 守卫本体（#11 的收尾）—— ✅ 已完成（2026-09-22）
- `test/fixtures/truth_antd_modern.json`（177KB，**已入库**）= 浏览器 `window.mg` 导出的
  290 paint / 29 text / 34 effect / 365 变量 + collections + meta（含 type 分布与 kind-6 的 `floatData` 真值）。
- `scripts/verify-styles-truth.ts` 改成**双样本、fail-closed**：
  `antd_modern`（公开，**自动匿名下载** `/data` + 落缓存，CI 必跑）+ `mobile_kit`（私有，缺快照只跳过它自己）。
  **一个样本都没真跑起来就 `exit 1`** —— 静默跳过等于失效。
- 记录数**下限**基线：paint 290 / text 29 / effect 34 / vars 365（= 真值条数）。多出来的是二进制里带着的**其他库**样式，按全量返回并标注来源。
  ⚠️ **2026-09-22 修正**：原先钉死精确值（294/61/43/414），但该类库样式**随源库增减而变** —— 实测远端源库变化后 paint 294→291、vars 414→411，
  真值仍 290/290 全覆盖却判红。现改为「下限 + 真值逐条覆盖」，并已验证注入值级故障仍能判红。
- CI 新增 `test:styles` 步骤，`actions/cache` key 升为 `mg-bin-v2`；同时修掉一个**既有 CI bug**：
  cache 步骤原先排在 `test:regress` **之后**，等于从来没命中过缓存。

#### 12b. 三个「剩余项」的结论 —— 两个原判据假设被推翻
1. ~~「27 条 TEXT 的详情在**另一张表**」~~ → **错的，根本不需要另一张表**。真因有三层，全部已修：
   - **锚点**：这批文字样式的 `03 <c>` 是 `ZJ`/`ZR`/`E`/`N`… **不以 `a`(0x61) 开头**，而旧代码把 `03 61` 当硬锚点 → 整表 0 命中。
     现对 TEXT 放宽锚点，改由「子块必须完整解析到 `07 <ukey>`」佐证（`a` 仍是必要主锚点：去掉后火车票 PAINT 候选 90→362）。
   - **子块起点**：modern 文字子块以 `01 <1B>` 开头（legacy 是 `02 <3B>`），旧解析没跳。
   - **0 值读取**：`04/05/08` 等字段值是 0 时只写 1 字节 `00`，按定长 4 字节读会读崩整块。
   结果：antd5 真值 **29/29** 全覆盖（fontSize/lineHeight/PostScript/字间距逐值），火车票库引用文字样式 **4→10**（都是真实回收，已复核每条字段非空）。
2. **效果 43 vs 真值 34**：多出的 9 条是**另一个订阅库**的记录（`sourceFileId` 非源库 `122691166044911`），
   不是假阳性 —— 按「全量返回 + 标注来源」处理，真值 34 条逐条覆盖、90 个效果项 alpha/radius/offsetY 全对（本样本 0 个 null）。
3. **`CORNER_RADIUS` / `NUMBER`（`05 06`）—— ✅ 已破解**：子块 `01 <sub> 02 <count> [<count> 个紧凑浮点/0]`，
   `sub=3/count=4`→CORNER_RADIUS、`sub=1/count=1`→NUMBER，输出为变量的 `floatData`。
   antd5 **12/12 条与浏览器 `modes["M:2"][0].floatData` 逐值一致**（`Padding`=16、`Padding XL`=32、圆角 `全圆角`=256000×4…），
   已写成值级断言。⚠️ 反直觉处：圆角 `基础` 真值是 **6** 不是 antd token 的 8 —— **只能靠真值钉，不能按 token 表猜**。

#### 12c. 连带修掉的一个系统性解码 bug（颜色）
- `buildPaintTable` 原先按「首通道是基值 + r/g/b 定长 4 字节 + alpha 取 `09`」读颜色，**只在 alpha=1 的样本上碰巧正确**。
  实际布局是 `08 <a><r><g><b>`，**通道序 a,r,g,b**、每通道「0 值压成单字节 `00`」，而 `09` 是另一个量（实测 1/0.65/0.45）。
  任何**半透明或含 0 通道**的颜色都会解错（`08 00 00 00 00` 曾解出 `r=6e-39`）。已修正，antd5 SOLID **288/288** 逐值通过；
  火车票本地颜色字节层 old-vs-new 对比**完全一致**（`probe_old_vs_new`，legacy 无退化）。

#### 12d. 顺着这条线还能做什么（2026-09-22 收尾后新增）
| 候选 | 入口 | 门槛 |
| --- | --- | --- |
| **效果 `type` 补全**（INNER_SHADOW / LAYER_BLUR / BACKGROUND_BLUR 的 `0d` 值） | `scanEffectTable` | 需一个含内阴影/模糊样式的文件导真值；antd5 只有 DROP_SHADOW |
| **`textCase` / `decoration`** | `parseTextStyleBody` 的 `06`/`0b` | 需取样到非默认值。`createTextStyle` 会忽略这两个参数，只能**在编辑器 UI 里改**再建样式 —— 自动化控件命中不稳，是本项唯一阻塞 |
| ~~**GRID / PADDING / SPACING / STROKE_WIDTH 等样式族**~~ | ✅ **已完成 2026-09-22**，见下 | — |
| **多模式变量**（`modes` 不止 `M:2`） | `list_variables` | 需一个建了多模式的文件；现在只解首模式值 |
| ~~**modern 节点树容器类型**（FRAME/COMPONENT_SET 仍 `null`）~~ | ✅ **已完成 2026-09-23**，见 P3 | 探针34：`05==1`→COMPONENT + CS 树结构 + `1a` 链跟随，容器 100.0% |

---

## 🔑 2026-09-22 的关键突破：样式族 + 一个真 P0

### A. 样式族（SPACING/PADDING/CORNER_RADIUS/STROKE_WIDTH/GRID）已交付

`list_token_styles` 上线，等于离线实现浏览器那五个 `getLocalXxxStyles()`。

**族判别式不是猜的，是从客户端 JS 里挖出来的枚举**（编辑器 bundle 的 `StyleToCppStyle`）：

```
样式类型（= 样式索引的 `05 <n>`）：PAINT=1, EFFECT=2, TEXT=3, GRID=4, STROKE=5, CUSTOM=6
CUSTOM 子类型（= 子块 `01 <sub>`）：NONE=0, Spacing=1, Padding=2, Radius=3, CrossSpacing=4
```

这套值与我们**既有的实测**（1/2/3/6 + sub 1/3）完全吻合，故可信。
实测对照：SPACING **7/7**、CORNER_RADIUS **5/5**（真值 `test/fixtures/truth_numeric_families.json`，已进 `test:styles`）。

**重要认知：SPACING 与 NUMBER 是同一批对象** —— 二进制里完全同构（都是 `CUSTOM+Spacing`），
客户端里两者映射到同一个 CppStyle，只是变量 API 叫 NUMBER、样式 API 叫 SPACING。
（再次印证「变量 = 样式」。）

**GRID / STROKE_WIDTH 的值布局（2026-09-22 二次补全，已交付）**：
上一版这两个族在**全部 6 份样本里出现 0 次**，只能登记类型、`values` 恒 null。
本轮改为**自己现造样本**：在编辑器 UI 里新建文稿 → 加描边宽度样式 / 布局网格样式 → 用
`window.mg.getLocalGridStyles()` 导真值 → 下载 `/data` 逐字节对照。一次拿全两族：

- **STROKE_WIDTH**（`05 05`）：值子块 `02 <count> [<count> 个「紧凑浮点或 0」]`，
  **没有 `01 <sub>` 前导**（这点与数值族不同，是踩坑点）。
  `SW/1 → 02 04 7f000000 ×4 = [1,1,1,1]`、`SW/2 → 02 04 80000000 ×4 = [2,2,2,2]`。
- **GRID**（`05 04`）：**样式记录的 body 恒为空**（`00 00 06 01`）—— 值不在样式表里，
  而在一条**独立的对象记录**中，靠 `02 <styleId>` 反向指回样式：
  `01 <gridId> \0 02 <styleId> \0 03 <c> \0 [字段区] 00`。
  字段区**按字段号升序、且默认值一律省略**，故必须能区分「显式存了」与「省略了」：

  | 字段 | 含义 | 省略时默认 |
  | --- | --- | --- |
  | `04 <n>` | gridType | `GRID`（`2=COLUMNS` 实测） |
  | `05` | color，**通道序 a,r,g,b**，0 值压单字节 `00` | — |
  | `07 <f>` | sectionSize | 8 |
  | `08 <n>` | alignment | `STRETCH`（`3=CENTER` 实测） |
  | `09 <f>` | count | 8 |
  | `0a <f>` | gutterSize | 16 |
  | `0b <f>` | offset | 0 |
  | `0c <n>` | isVisible | true（实测恒 `01`） |

  实测对照（`test/fixtures/truth_grid_stroke.json`）：GRID **5/5**、STROKE_WIDTH **2/2**，
  含「默认值全省略」（GRID/COL）与「非默认值显式存」（GRID/12、GRID/COL2、GRID/ALIGN）两组，
  已进 `test:styles`（新增 `grid_stroke` 样本，公开可匿名下载，1.6KB）。

**未取样项（代码里显式返回 null，不猜）**：alignment 的 LEFT/RIGHT、gridType 的 `1`/`3`
（`GRID`/`ROWS` 按「默认值即枚举首项」与枚举序推断，注释已标明）。

### B. 真值导出的新姿势：**公开文件也能跑 `window.mg`**（省掉登录）

不必登录、不必私有文件：`https://mastergo.com/file/<fileId>` 只要是**公开稿**，
编辑器加载后 `window.mg` 就是完整的 99 键插件 API，`browser_execute` 可直接调
`getLocalSpacingStyles()` 等。配合 `.cache/post_server.cjs` 落盘真值即可。
本次即用此法拿到 `truth_numeric_families.json`。

**配套三招（本轮补全 GRID/STROKE_WIDTH 时全部用到）**：

1. **fileKey 不用翻 DevTools**：`GET /api/v1/documents/<fileId>` 的响应里直接有 `fileKey`
   （页面上下文里 `fetch(..., {credentials:'include'})` 即可），拿到就能匿名下 `/data/{fileKey}`。
2. **`createXxxStyle()` 全是「从图层存样式」**，不是凭空建：直接调会报
   `layer does not contain grid style` / `Expected to get the value of 'id'`。
   正路是**在编辑器 UI 里造**（面板 → 布局网格 `+` → 条目 → 四宫格「应用样式」→ 创建样式）。
3. **要造出「非默认值」样本才有判别力**：默认值在二进制里一律省略，
   只造默认样本会误以为「字段根本不存在」——`count/gutterSize/offset/alignment` 四个字段
   全靠 GRID/COL2（4 列 / 槽宽 20 / 边距 5）与 GRID/ALIGN（居中）才定位到。

> 浏览器 UI 坐标注意：`browser_execute` 报的 `innerWidth` 才是 CSS 坐标基准，
> 截图可能被 DPR 放大 —— 直接点截图像素坐标会点空（本轮踩过，x=1470 在 1400 宽视口外）。
> 稳妥做法是用 DOM `getBoundingClientRect()` 取坐标，或按 `path` 的 `d` 属性辨认「+ / 四宫格 / −」按钮。

### C. ⚠️ P0 踩坑：`/data` 头部签名的版本字节会变

modern 头部是 `09 <X> 01 04 02 00 03 <pageCount>`，**`<X>` 不是常量**：
同一份 antd5 官方稿 09-21 下载是 `09 02`、09-22 下载是 `09 04`，同一副本两次下载又是 `09 16`。

`page-index.ts` / `node-index.ts` 原先把整串写死成 `09 02 …`，于是**所有新下载的文件**都被判成
legacy → `list_pages` **0 页**、`get_file_nodes` 从 144055 条掉到 **1 条**。
现已改为只匹配后半段 `01 04 02 00 03`（签名固定在偏移 0，据此校验避免误命中），旧签名保留兜底。

> **教训**：`/data` 既然「不可字节复现」，**任何跨下载的固定字节都不该当判据**。
> 这个坑之所以能潜伏，是因为 CI 一直用 `actions/cache` 复用的**旧快照**（X=02）——
> 快照缓存提高了速度，却也把格式漂移挡在了 CI 之外。

---

## P3 · 已知局限（已评估，暂不建议动）

| 项 | 现状 | 为何搁置 |
| --- | --- | --- |
| ~~modern 的 FRAME / COMPONENT_SET~~ | ~~返回 `null`~~ | **已解决（2026-09-23）**：容器块体首个 `05==1`→COMPONENT（7406/7406 零假阳性）；COMPONENT_SET 用树结构判据（父=根/GROUP/CS 且直接子全 COMPONENT，191/193）；INSTANCE 沿 `1a` 引用链跟随（链端 COMPONENT 或无 1c 组件定义→INSTANCE，38903/38903）；剩余容器→FRAME（26255/26255）。容器准确率 **100.0%** |
| ~~COMPONENT_SET vs COMPONENT~~ | ~~折叠为 COMPONENT~~ | **已解决（2026-09-23）**：`05==1` 判 COMPONENT 后，CS 树结构判据补回 191 个 COMPONENT_SET（剩 2 个判 FRAME） |
| ~~255 条「容器→LINE/RECTANGLE」~~ | ~~错判~~ | **随容器类型打通而消失（2026-09-23）**；仅剩非容器杂音 TEXT 12 个判 LINE、PEN 755 个判 RECTANGLE（叶子判别任务，非容器范围） |
| ~~叶子杂音（TEXT→LINE / PEN→RECTANGLE）~~ | ~~错判~~ | **已解决（2026-09-23）**：叶子几何段内前置附加块（PEN 前 RECTANGLE@4/23、TEXT 前 LINE@55-60）与后置嵌入块（TEXT 的 ELLIPSE@127-1729、LINE 的 TEXT@234）—— 规则：容器/叶子嵌入块偏移 >150 忽略 + PEN/TEXT/ELLIPSE/SLICE 复杂类取偏移最小、否则取最后。TEXT/PEN/ELLIPSE/LINE/RECTANGLE 全 100.0%（56833 叶子 0 误判）；剩 7 条误判为既有边界（CS 2 判 FRAME；5 个跨页收录节点诚实返回 null 而非旧 bug 的 FRAME） |
| 文字样式的 textCase / decoration | 未输出 | 现有全部样式两个字段**全是同一个值**（ORIGINAL / NONE），无法验证枚举语义（`06`/`0b` 恒为 `01`） |
| 变量 scopes / codeSyntax / 多模式 | 未输出 | 二进制内未定位到 scopes 字段；本文件只有 1 个模式 M:2，多模式无从验证（数值型变量该模式的值已解出为 `floatData`） |
| 样式 `isExternal` 的「本地/远程」语义 | 只表达「谁定义的」 | 订阅关系既不在 `/data` 也取不到匿名接口（见 12）|

---

## 环境与踩坑备忘

**构建与运行**（本机 Windows / Node 24 与 CI ubuntu 均实测）
- `npm run build`（tsc）✅ 通过
- `npm run test:diff` ✅ / `npm run test:regress` ✅ 828/828 = 100%、0 错判 / `npm run test:styles` ✅（antd_modern 全绿，mobile_kit 缺私有快照干净跳过）
- `npm run build:bundle` + `npm run test:e2e` ✅（spawn `dist/index.cjs`，10 工具、list_pages 74 页、get_file_nodes 144055 节点、list_styles 292 条）

**素材位置**（`.cache/` 已 gitignore，不入库）
| 文件 | 说明 |
| --- | --- |
| `test/fixtures/truth_antd_modern.json` | **已入库**（177KB）：antd5 复制稿浏览器真值（290 paint / 29 text / 34 effect / 365 变量，含 12 条数值型变量的 `floatData`），`test:styles` 的 CI 侧判据本体 |
| `test/fixtures/truth_mobile_kit.json` | **已入库**：移动端界面设计全部真值（样式 57 + 组件 144 + 变量 57 + 集合/组） |
| `test/fixtures/truth_grid_stroke.json` | **已入库**：自建 GRID/STROKE_WIDTH 真值（GRID 5 + STROKE_WIDTH 2），`test:styles` 的 `grid_stroke` 样本判据 |
| `.cache/antd_sample.bin` | antd5 复制稿 `/data` 快照，100.9MB（**公开、脚本会自动匿名下载**，CI 用 `~/.cache/mg/styles-antd.bin`） |
| `.cache/grid_sw.bin` | 自建 GRID/STROKE_WIDTH 样本 `/data` 快照，1.6KB（**公开、脚本会自动匿名下载**） |
| `.cache/mg_mobile_kit.bin` | 移动端界面设计 `/data` 快照，6.2MB（**私有，需 Cookie**；当前 Cookie 对该文件 403，故只本地可选跑） |
| `.cache/train_ticket.bin` | 火车票 `/data` 快照，47.9MB（公开，legacy 回归样本） |
| `.cache/antd5.bin` | Ant Design 5 官方文件 `/data` 快照，105.8MB（公开，modern e2e 样本） |
| `.cache/post_server.cjs` | 真值导出用的本地 POST 接收器 |

文件 id：
- 移动端界面设计（**私有**）`107389953208823` / fileKey `2b195a62-0d3e-40ee-b55f-59b607e729a0`
- 火车票（公开）`115278536821990` / fileKey `890c5c78-a533-4751-91ef-06e3fbb70d5e`
- Ant Design 5 官方（公开）`205140012617682` / fileKey `010e341a-0eae-49c9-a538-87932df0307d`
- Ant Design 5 **复制稿**（公开，`test:styles` 的 modern 样本）`204971164239455` / fileKey `eb0ea904-aa4f-4e83-863b-5071a4d386a3`
  —— 样式源库为 `122691166044911`；e2e 用官方稿、守卫用复制稿，二者不要混
- **自建 GRID/STROKE_WIDTH 样本**（公开，`test:styles` 的 `grid_stroke` 样本）`205234583944753` / fileKey `bb3da168-0864-4eac-a22c-76f65f8e5772`
  —— 2026-09-22 用编辑器 UI 现造：5 个 GRID 样式（GRID/8、GRID/12、GRID/COL、GRID/COL2、GRID/ALIGN）+ 2 个描边宽度样式（SW/1、SW/2）。
  文件只有 KB 级，故 `test:styles` 对该样本走 `tokenOnly` 分支（跳过 paint/text/effect/vars）并放宽快照体积阈值。
  要再造同类样本：见上文 B 节「配套三招」。

**`/data` 接口三个反直觉特性**
1. **不可字节复现**：同一未变动文件连续下载 md5 不同 → 回归按结构比对，别用 md5 / 整文件 diff
2. **忽略 `Range`**：带 `Range` 仍返回 200 + 完整 content-length
3. **公开文件无需任何认证**；私有文件才需要 Cookie（可用浏览器会话直接下载）

**紧凑浮点编码**（反复用到）
`tag`(1 字节) + 3 字节小端尾数，`value = (2²⁴ + intLE) · 2^(tag−151)`。
自检：`82 00 00 80` → 12；`83 00 00 10` → 17。**0 值单独用 1 字节 `00` 表示**（不写 4 字节）。

**写探针的约定**
- `probe_*.mts` 放项目根目录，**验证后删除**（本仓库既有约定）
- ⚠️ **必须用 `.mts` 不能用 `.mjs`**：探针里要 import `../src/node-tree.ts` 的 TS 类型，`.mjs` 一旦被塞进类型标注就
  `SyntaxError: Unexpected token ':'`；`node --experimental-strip-types probe_xxx.mts` 或 `npx tsx probe_xxx.mts` 都可跑
- **`/data` 头部锚点**：`readCstr`（遇 `\0` 停）读 C 字符串；紧凑浮点见上；`05 <n>` 判别式表在 `node-tree.ts` 的 `STYLE_KIND_BY_N`

**工具限制（已过时，勿再引用）**
- ~~`browser-skill` 不支持任意页面 JS 求值~~ → **当前会话已支持**，`window.mg` 真值可导出
