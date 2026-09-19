# mastergo-mcp

基于 MasterGo **网页接口（Web API）** 完全自研的内部 MCP Server（Node.js + TypeScript），用于在 AI 客户端（Cursor / Trae / Claude Desktop 等）中读取 MasterGo 设计稿数据。

> **设计原则**：本项目**完全自行实现**，通过 MasterGo 网页接口（`/api/v1/...`、`/data/...`）逆向实现 MCP 能力，**不使用、不依赖官方 MCP 网关（`/mcp/*`）**——官方 Magic MCP 需要付费席位（研发席位 / Magic MCP）。本项目仅需一个浏览器登录态的 Cookie 即可访问，**无需额外付费**。

## 特性

- **单 Cookie 认证**：浏览器 Cookie（`gfsessionid=...`）即可访问文件元信息 / 页面列表 / 全量节点索引，无需个人访问令牌、无需付费席位
- **私有二进制逆向**：解析 `/data/{fileKey}` 的 MasterGo 私有二进制格式，提取文件内全部页面列表（双 marker 逆向）与全量节点索引（页面/节点位标记区分 + 去重）
- **5 分钟 LRU 缓存 + in-flight 去重**：相同请求并发复用，避免重复网络开销
- **URL 智能解析**：直接粘贴设计稿 URL（含 `?page_id=` / `?layer_id=`）即可使用
- **`.env` 配置**：开发/测试期可放在根目录 `.env`，正式生产改用环境变量，优先级一致

## 快速开始

```bash
npm install
npm run build
```

### 认证（唯一方式：浏览器 Cookie）

| 环境变量 | 说明 |
| --- | --- |
| `MG_COOKIE="gfsessionid=xxx; ..."` | 浏览器 Cookie，网页 API 认证的唯一方式 |

Cookie 获取：登录 mastergo.com 后，打开浏览器开发者工具 → Network → 任意请求的 Request Headers 中复制 `Cookie` 整段值。

> 测试期可直接填入根目录 `.env`（已加入 `.gitignore`），参考 `.env.example`；正式生产用环境变量 `MG_COOKIE`。

### 启动

```bash
# 方式一：环境变量 / .env
MG_COOKIE="gfsessionid=..." npx tsx src/index.ts

# 方式二：命令行参数
npx tsx src/index.ts --cookie "gfsessionid=..." --url https://mastergo.com
```

### 配置到 AI 客户端

以 Cursor / Claude Desktop 等支持 MCP 的客户端为例，在 MCP 配置中新增：

```json
{
  "mcpServers": {
    "mastergo": {
      "command": "npx",
      "args": ["tsx", "/绝对路径/mastergo-mcp/src/index.ts"],
      "env": { "MG_COOKIE": "gfsessionid=xxx; ..." }
    }
  }
}
```

## 已实现工具

| 工具 | 说明 | 依赖接口 |
| --- | --- | --- |
| `get_file_meta` | 文件元信息：名称、团队、项目、fileKey、权限、负责人 | `/api/v1/documents/{id}` |
| `list_pages` | 文件内全部页面列表（页面 ID + 页面名） | `/data/{fileKey}` 二进制索引 |
| `get_file_nodes` | 全量节点索引：全部页面 + 所有名节点的 id/名称（支持按名搜索、限量） | `/data/{fileKey}` 二进制索引（全量下载） |
| `get_page_tree` | 指定页面节点树：id、名称、类型、父节点 id、父子层级（支持限深展开） | `/data/{fileKey}` 二进制节点树解码 |
| `list_styles` | 文件本地 paint 样式（颜色样式）：id、名称、collection、ukey、RGBA（按 ukey 筛本文件定义） | `/data/{fileKey}` 二进制 paint 样式聚合记录 |

### 推荐工作流

1. `get_file_meta` 获取文件基本信息，拿到 `fileKey`；
2. `list_pages` 拿到页面列表，确定目标页面（如 `10371:87078`）；
3. `get_page_tree` 传入目标页面，得到整棵图层树（含节点类型、父子层级）；
4. `get_file_nodes` 可按名搜索全文件节点，快速定位具体图层。

> `get_file_nodes` / `get_page_tree` 会全量下载 `/data/{fileKey}`（实测单个文件约数十 MB），因此首次调用较慢，之后 5 分钟内命中缓存。`get_page_tree` 通过逆向节点记录（`01=id / 02=parent / 03=类型码 / 04=name`）重建层级，并通过几何段首个 `1c` 子块字节判别类型（TEXT/FRAME/GROUP/RECTANGLE/ELLIPSE/LINE/PEN/SLICE/INSTANCE/BOOLEAN_OPERATION），实测父/子与类型均 100% 与浏览器一致。

## 权限说明（重要）

- 文件元信息、页面列表：**仅需浏览器 Cookie，无需付费席位**（已实测验证：`GET /api/v1/documents/{fileId}` 与 `/data/{fileKey}` 均可用 Cookie 访问）；
- 本项目**不使用**官方 `/mcp/*` 网关，因此**不需要**个人访问令牌、也不受「是否开通 Magic MCP / 研发席位」的限制。

## 项目结构

```
src/
  index.ts        # MCP Server 入口（Stdio 传输）
  config.ts       # 配置加载（命令行参数 + 环境变量 + .env）
  mastergo.ts     # HTTP 客户端：网页 API + 缓存
  page-index.ts   # 私有二进制页面索引解析（双 marker 逆向）
  node-index.ts   # 私有二进制全量节点索引解析（页面/节点位标记区分 + 去重）
  node-tree.ts    # 私有二进制节点树解码（01/02/03/04 记录 + 1c 子块类型判别）
  tools.ts        # MCP 工具定义与参数
```

## 待实现能力（Roadmap · 均基于网页接口自研）

- [x] **图层/节点深度读取**：完整节点树已解码（id / 名称 / 类型 / 父子层级，`get_page_tree`，父/子与类型实测 100%）
- [ ] **几何与布局属性（部分完成）**：尺寸（width/height）、透明度（opacity）、圆角（cornerRadius，RECTANGLE）、x/y 坐标（带符号）、rotation/transform 已在 `get_page_tree` 的 `geometry` 输出，实测与浏览器一致（178 x / 177 y 对照 100%）。
  - x/y 符号位已破解：坐标为 18 块内 `01/02` 子块跟随的**带符号**紧凑浮点，符号位是 24 位小端尾数最低字节 bit0（置 1 为负、清 0 为正，`positionSignResolved` 恒为 `true`）。
  - rotation/transform 已破解：18 块容纳完整仿射变换，子 `01=tx(x)`、`02=ty(y)`、`03..06` 按 `(m00,m11,m01,m10)` 顺序打包 2×2 矩阵 `m=[[s3,s5],[s6,s4]]`，`rotation = atan2(m10,m00)`（度；无旋转子 03..06 省略为单位阵）。8 个 rotation 节点对照浏览器 `relativeTransform` 真值 8/8 一致。
  - fill(纯色)/stroke 已破解：颜色不内联在节点记录，而存于独立的 **paint 定义表**（`01 <selfId>\0 02 <refId>\0 03 61 30\0 00 08 <A> <R> <G> <B> [09 <A'>]`，实测 987 条，RGBA 用紧凑浮点编码）。节点记录里 `15 <refId>`（图元 fill）/`16/17 <refId>`（stroke）/`09 01 02 02 03 <refId>`（TEXT fill）引用该表。solid 纯色对照浏览器真值 143/153 命中（余为渐变/实例内部/隐藏描边）。
- [x] **strokeWeight（描边宽度）**：描边宽度已破解。几何段内、13 引用块之前，key=`0x10`：`10 00`→0（隐藏描边）、`10 <4字节紧凑浮点>`→权重值、无该字段→默认 1。实测 63/63 与浏览器真值一致。
- [x] **strokeAlign（描边对齐）**：字段 `13`：`01`→CENTER、`02`→INSIDE、`03`→OUTSIDE，缺省 CENTER。实测 776/776 与浏览器真值一致。
- [x] **constraints（布局约束）**：字段 `0b`=vertical、`0c`=horizontal：`01`→END、`03`→CENTER、`04`→SCALE，字段缺省→START；两字段仅在该轴非默认值时出现（如 `0b 03 0c 03` 即垂直/水平皆 CENTER）。实测垂直 546/548、水平 546/548 与浏览器真值一致（2 例偏差为实例内部节点继承母版约束）。
- [x] **autoLayout 自动布局（flexMode/padding/itemSpacing/对齐/sizingMode）**：已破解并落地到 `geometry.autoLayout`。字段位于几何段内 `1c 07` 类型块（FRAME/INSTANCE/GROUP/BOOLEAN_OPERATION）中：`08 <v>`→flexMode（00=NONE/01=HORIZONTAL/02=VERTICAL）、`09 <紧凑浮点|00>`→itemSpacing、`0a 01<pt> 02<pr> 03<pb> 04<pl> 00`→padding（每边为 0 以单字节 `00` 存）、`0d <ma> 0e <ca>`→主轴/交叉轴对齐（0=FLEX_START/1=FLEX_END/2=CENTER/3=SPACING_BETWEEN）、锚点 `1e 00 [1f <0|1>] [20 <紧凑浮点|00>] 21 <ms> [22 <xs>]` 内 `21`→主轴 sizingMode、`22`→交叉轴 sizingMode（0=FIXED/1=AUTO，`22` 缺省时按 AUTO 处理）。实测（Ant Design 5.0，73620 条布局真值）：flexMode 33302 命中 / 37 错；itemSpacing 32664/658；padding 32478/676；主轴对齐 33081/258、交叉轴 33014/325；主轴 sizingMode ≈99.3%、交叉轴 sizingMode ≈96.7%。偏差集中在**实例内部节点**（id 含 `/`，其 `1c 07` 块省略布局字段、继承母版，autoLayout 为 null，共 40225 个）与**绑定了设计令牌**的节点（几何段内 `2a {"tokens":...}` 覆盖了内联值）。
- [ ] **组件与样式资源（部分完成）**：颜色样式（paint 样式）已破解并交付 `list_styles` 工具，实测 4/4 与浏览器 `getLocalPaintStyles()` 真值一致；文字样式 / 效果样式 / 组件库尚未实现。**如何继续**：见下节「接手指南 ②/③」。
  - paint 样式聚合记录格式：`01 <selfId>\0 02 <name>\0 03 61 <subtype>\0 [04 00] 05 01 00 00 06 01 07 <ukey>\0 08 ...`，按 `07` 后 ukey 前缀 `fileId+` 筛本文件定义；SOLID 样式 RGBA 走 paint 定义表（`buildPaintTable`）查询 selfId 拿到颜色。
  - collectionId 默认 `M:1`、collectionName 默认 `集合`：二进制中**没有独立 collection 表**（搜 `fileId+M:` 0 命中），疑似客户端对每个文件默认构造一个 collection。
  - 渐变样式（GRADIENT_LINEAR/RADIAL）目前只标记 kind，渐变 stops 多色解码暂未实现，color 为 null。
- [ ] **变量（Variables）**：Design Tokens 的读取与引用关系。**如何继续**：见下节「接手指南 ⑤」。
- [ ] **图片/切图导出**：节点导出为 PNG/SVG/PDF，可交付到本地目录
- [ ] **设计稿差异对比**：两份文件/版本间节点 diff
- [ ] **Cookie 过期检测**：失效检测与登录引导提示
- [ ] **打包发布**：`npm pack` / 单文件二进制（esbuild），免 npx tsx 依赖

## 未解析内容 · 接手指南

以下的逆向方向均被**「缺少可供对照的真值样本」**阻塞：要么当前火车票文件里没有该特性，要么需要导出浏览器 API 真值才能定位二进制锚点。通用方法论（前几项已反复验证有效）是：

> **准备一份含目标特性的设计稿 → 用 chrome-devtools 连到该标签页，`evaluate_script` 调用 `window.mg` API 导出「真值」JSON 存盘 → 同步把该文件 `/data/{fileKey}` 二进制整份存盘（约几十 MB）→ 在二进制中搜索真值里的特征字符串（ukey / collectionId / 样式名 / 组件名等）定位记录 → 写 probe 脚本对照解码 → 落地到 `node-tree.ts` + 新工具。**

- **真值来源 API**（浏览器里 `window.mg`，多为已暴露的导出函数）：`getLocalPaintStyles()`（颜色，已用）、`getLocalTextStyles()`（文字）、`getLocalEffectStyles()`（效果）、`getComponentListVal()`（组件）、variables 相关（见 ⑤）。先用 `Object.keys(window.mg)` 罗列可用函数再挑。
- **连接浏览器**：chrome-devtools MCP（`server_name=mcp_plugin_Chrome_DevTools_chrome-devtools`）。先 `list_pages` 找到目标设计稿所在的标签页 id（火车票文件是 `pageId=2`），再 `evaluate_script` 传 `{ pageId, function: new Function(...) }`；注意**不要**传 `returnByValue`（不支持的参数）。
- **存盘路径**：真值存 `%TEMP%/Trae/tools/` 下（例 `mng_rfsl.json`），二进制存 `%TEMP%/Trae/tools/mg_src.bin`（47.9MB，勿删）；probe 脚本放项目根目录、以 `probe_*.mjs` 命名，验证后删除。
- **本文件文件级 key**：fileId/`documentId = 115278536821990`，`fileKey = 890c5c78-...`（从 `get_file_meta` 拿）。ukey 前缀 = `115278536821990+`。

### ① 自动布局（autoLayout）约束 —— 已完成（2026-09）
- **结果**：已破解并落地到 `node-tree.ts` 的 `geometry.autoLayout`（`NodeAutoLayout` 接口 + `parseAutoLayout`）。
- **字段编码**（位于几何段内 `1c 07` 类型块，键号与外层几何段复用但作用域独立）：
  - `08 <v>` → flexMode：`00`=NONE、`01`=HORIZONTAL、`02`=VERTICAL
  - `09 <紧凑浮点 | 00>` → itemSpacing（`09 00`=0）
  - `0a 01<pt> 02<pr> 03<pb> 04<pl> 00` → padding（每边为 0 时以单字节 `00` 存）
  - `0d <ma> 0e <ca>` → main/crossAxisAlignItems：`0`=FLEX_START、`1`=FLEX_END、`2`=CENTER、`3`=SPACING_BETWEEN
  - 锚点 `1e 00 [1f <0|1>] [20 <紧凑浮点|00>] 21 <ms> [22 <xs>]` → `21`=mainAxisSizingMode、`22`=crossAxisSizingMode：`0`=FIXED、`1`=AUTO（`1d 01`/`1f <v>`/`20 <float|00>` 为可选前缀；`21` 恒存在，`22` 常缺省、缺省按 AUTO 处理）
- **真值与命中率**：以 Ant Design 5.0 稿（fileKey `eb0ea904-...`，真值 `ad_truth.json` 73620 条、二进制 `ad_src.bin` 105.8MB）对照，见 Roadmap 中 autoLayout 条目。
- **已知局限**：实例内部节点（id 含 `/`）的 `1c 07` 块省略布局字段，`autoLayout` 为 null（继承母版）。sizingMode 残差（主轴 ≈0.7%、交叉轴 ≈3%）集中在含 `25 02` 标记的节点——疑似尺寸由父/母版继承或覆盖（layoutGrow/STRETCH），实测其真值并非都能由内联值或父节点继承还原（探针 `probe_sz18`）。曾试过在 `25 02`/`2a` 上抑制（置 null），但这只是把「猜错」换成「漏报」，原始错误数反而上升，故未采用。

### ② 文字样式表（Text Styles）
- **目标字段**：字体族 `fontFamily`、`fontSize`、`fontWeight`、行高 `lineHeight`、字距 `letterSpacing`、文字样式名。
- **现状**：未实现。火车票文件 0 个文字样式；二进制里连样式聚合记录（`03 61 <subtype>`，参考 paint 样式的 `subtype=0x40+`）都还没确认文字样式的 subtype 值。TEXT 节点的 fill 已可通过 `09 01 02 02 03 <refId>` 引用解出（见几何小节）。
- **从何入手**：
  1. 打开含**文字样式**的设计稿（有「样式」面板里建了字号/字重/字体族样式的文件），`evaluate_script` 调 `getLocalTextStyles()` 导真值。
  2. 真值里取某个样式的 `ukey`（形如 `fileId+<styleId>`），在二进制搜该 `+<styleId>` 串定位**文字样式聚合记录**——比对它是否也满足 paint 样式那种 `03 61 <subtype> 00 [04 00] 05 01 00 00 06 01 07 <ukey>` 结构，若一致则 subtype 不同，记下该 subtype 值作为文字样式锚点。
  3. 反过来：已知的 TEXT 节点记录里找 `fontSize`/`fontFamily` 等紧凑浮点/字符串，与真值 `characters/fontName` 对照。

### ③ 效果样式表（Effect Styles）
- **目标字段**：阴影（drop shadow）`blur`（radius/spread）、内阴影、模糊，含颜色与偏移 `offsetX/offsetY`。
- **现状**：未实现。火车票文件 0 个效果样式。
- **从何入手**：流程同 ②——打开含效果样式的设计稿 → `getLocalEffectStyles()` 导真值 → 搜 `ukey` 定位效果样式聚合记录 → 观察其 subtype 与结构（阴影颜色多半走 compact 浮点 RGBA，坐标走带符号 compact 浮点）。阴影的 `blur` 结构与 AutoCAD/Figma 的 drop-shadow JSON 类似，二进制里大概率是若干紧凑浮点 + 一个颜色块。

### ④ 组件列表（Components）
- **目标字段**：文件组件库里的 `COMPONENT` 定义节点（id、名称、所属 frame）、`INSTANCE` 与 `COMPONENT` 的引用关系。
- **现状**：未实现。火车票文件用 `getComponentListVal()` 真值观察约 383 个组件（96 个本地），但 `decodeNodeType`（`node-tree.ts` 的 `TYPE_1C` + `1c 07` 分支）**尚未识别 COMPONENT**——目前把带子节点的组件统一归为 `FRAME`。`INSTANCE` 已能在 `1c 07 06` 判出。
- **从何入手**：
  1. `evaluate_script` 调 `getComponentListVal()`，导出组件 id 列表（含本地/外部标记）存真值。
  2. 拿一两个本地组件 id，在二进制搜 `01 <组件id>\0`，定位其节点记录，用几何段首个 `1c` 子块**第 2/3 字节**去比对——`FRAME` 是 `1c 07 03/09/0a`，`INSTANCE` 是 `1c 07 06`，那么 `COMPONENT` 大概率是 `1c 07 0?` 里某个未映射值（试 `01/02/07/08` 等）。
  3. 在 `TYPE_1C`/`decodeNodeType` 的 `1c 07` 分支补一个映射值，用全量组件 id 断言命中率，再落地。

### ⑤ 变量（Variables / Design Tokens）
- **目标字段**：变量集合（collection）、变量组、变量（数值/颜色/字符串）、每个变量在节点/样式上的引用关系。
- **现状**：完全未开始，连 `window.mg` 的 variables 导出函数名都未确认（`getLocalPaintStyles` 等是样式，变量是另一套）。
- **从何入手**：
  1. 打开一个**含变量**的设计稿（建了变量集合与引用的文件），先在浏览器 console 里 `Object.keys(window.mg).filter(k => /var|token|coll/i.test(k))` 找出变量导出函数，再导真值。
  2. 观察变量 `collectionId`（设计里 `M:1` 是变量/样式集合的默认 pseudo-id）在二进制中的存储：已知样式被硬编码 `collectionId="M:1"/"集合"`，就是因为二进制**没有独立 collection 表**（搜 `fileId+M:` 0 命中）。变量集合很可能以类似方式存在，需先找到其集合记录长什么样。
  3. 在三方工具（Figma→MasterGo 导入或用插件）或浏览器对象里对比变量 `ukey`，在二进制定位变量定义与引用，再落地。

### 既成工具的可复用输出
- `get_page_tree` 的 `geometry` 已含 `fills/strokes/strokeWeight/strokeAlign/constraints/autoLayout/rotation/transform/x/y/width/height/cornerRadius`；新增样式/组件工具则仿照 `list_styles`（`normalize(file) → getFileMeta → getLocalStyles(fileKey,fileId) → jsonOut`）的模式在 `tools.ts` 里追加。

## 注意事项

- 私有二进制格式为最小逆向，若 MasterGo 调整 `/data/{fileKey}` 结构，页面索引解析需同步更新（见 `page-index.ts` 注释）；
- Cookie 有有效期，失效后需重新登录浏览器复制（`.env` 中更新 `MG_COOKIE`）；
- 项目仅供内部使用，请遵守 MasterGo 服务条款与团队数据安全规范。