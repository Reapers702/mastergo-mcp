# mastergo-mcp

基于 MasterGo **网页接口（Web API）** 完全自研的内部 MCP Server（Node.js + TypeScript），用于在 AI 客户端（Cursor / Trae / Claude Desktop 等）中读取 MasterGo 设计稿数据。

> **设计原则**：本项目**完全自行实现**，通过 MasterGo 网页接口（`/api/v1/...`、`/data/...`）逆向实现 MCP 能力，**不使用、不依赖官方 MCP 网关（`/mcp/*`）**——官方 Magic MCP 需要付费席位（研发席位 / Magic MCP）。本项目仅需一个浏览器登录态的 Cookie 即可访问，**无需额外付费**。

## 特性

- **单 Cookie 认证**：浏览器 Cookie（`gfsessionid=...`）即可访问文件元信息 / 页面列表 / 全量节点索引，无需个人访问令牌、无需付费席位
- **单文件产物**：esbuild 打成自包含 `dist/index.cjs`（含 shebang，`bin` 名为 `mastergo-mcp`），运行时无需 node_modules / tsx
- **私有二进制逆向**：解析 `/data/{fileKey}` 的 MasterGo 私有二进制格式，提取文件内全部页面列表（双 marker 逆向）与全量节点索引（页面/节点位标记区分 + 去重）
- **5 分钟 LRU 缓存 + in-flight 去重**：相同请求并发复用，避免重复网络开销
- **URL 智能解析**：直接粘贴设计稿 URL（含 `?page_id=` / `?layer_id=`）即可使用
- **`.env` 配置**：开发/测试期可放在根目录 `.env`，正式生产改用环境变量，优先级一致

## 快速开始

```bash
npm install
```

`npm install` 会触发 `prepare` 钩子（`scripts/build.mjs`）用 esbuild 打出**单文件自包含产物** `dist/index.cjs`：
运行时依赖（axios / zod / MCP SDK）全部打进去，**产物运行时无需 node_modules、无需 tsx**。
手动重建：`npm run build:bundle`（`npm run build` 仅做 tsc 类型检查与类型产物）。

### 认证（唯一方式：浏览器 Cookie）

| 环境变量 | 说明 |
| --- | --- |
| `MG_COOKIE="gfsessionid=xxx; ..."` | 浏览器 Cookie。访问**私有文件**的认证方式；**公开文件（`isPublic`）无需任何认证** |
| `MG_BASE_URL` | 可选。API 基础地址，默认 `https://mastergo.com`（私有化部署 / 走代理时使用） |
| `MG_MCP_TOKEN` | 可选，仅向后兼容保留。旧版官方 `/mcp/*` 网关使用；现网页 API 自研模式下**无需配置**，若配置会作为 `X-MG-UserAccessToken` 请求头附加发送 |

命令行参数（优先级高于环境变量）：`--cookie <值>`、`--url <值>`、`--token <值>`。
完整优先级：**命令行参数 → 环境变量 → 根目录 `.env.local` / `.env`**（`.env` 不覆盖已存在的环境变量）。

Cookie 获取：登录 mastergo.com 后，打开浏览器开发者工具 → Network → 任意请求的 Request Headers 中复制 `Cookie` 整段值。

> 测试期可直接填入根目录 `.env`（已加入 `.gitignore`），参考 `.env.example`；正式生产用环境变量 `MG_COOKIE`。

### 启动

```bash
# 推荐：单文件产物（可执行文件名 mastergo-mcp）
MG_COOKIE="gfsessionid=..." node dist/index.cjs
MG_COOKIE="gfsessionid=..." npm start

# 开发：直接跑 TS 源码（需 devDependencies）
MG_COOKIE="gfsessionid=..." npm run dev

# 命令行参数（优先级高于环境变量）
node dist/index.cjs --cookie "gfsessionid=..." --url https://mastergo.com
```

### 配置到 AI 客户端

以 Cursor / Claude Desktop 等支持 MCP 的客户端为例，在 MCP 配置中新增：

```json
{
  "mcpServers": {
    "mastergo": {
      "command": "node",
      "args": ["/绝对路径/mastergo-mcp/dist/index.cjs"],
      "env": { "MG_COOKIE": "gfsessionid=xxx; ..." }
    }
  }
}
```

> 本地开发想边改代码边调试时，把 `command`/`args` 换成 `npx` + `["tsx", "/绝对路径/mastergo-mcp/src/index.ts"]` 即可，无需重新打包；日常使用与接入请用上文的 `dist/index.cjs`。

## 已实现工具

| 工具 | 说明 | 依赖接口 |
| --- | --- | --- |
| `get_file_meta` | 文件元信息：名称、团队、项目、fileKey、权限、负责人 | `/api/v1/documents/{id}` |
| `list_pages` | 文件内全部页面列表（页面 ID + 页面名） | `/data/{fileKey}` 二进制索引 |
| `get_file_nodes` | 全量节点索引：全部页面 + 所有名节点的 id/名称（支持按名搜索、限量） | `/data/{fileKey}` 二进制索引（全量下载） |
| `get_page_tree` | 指定页面节点树：id、名称、类型、父节点 id、父子层级（支持限深展开）。`page` 可省略，自动取 URL 的 `page_id` | `/data/{fileKey}` 二进制节点树解码 |
| `list_styles` | 文件内颜色样式（PAINT）：id、名称、collection、ukey、**来源文件 `sourceFileId`/`isExternal`**、RGBA（渐变含 **type/stops/手柄**） | `/data/{fileKey}` 二进制样式索引表 + paint 定义表 + 渐变 paint 图元 |
| `list_text_styles` | 文件内文字样式（TEXT）：id、名称、字体名、字号、行高、字体 hash | `/data/{fileKey}` 二进制样式索引表（`05 03` 子块） |
| `list_effect_styles` | 文件内效果样式（EFFECT）：id、名称、颜色（含 alpha）、模糊半径、X/Y 偏移、类型、spread | `/data/{fileKey}` 二进制样式索引表 + 效果定义表 |
| `list_variables` | 文件内变量（Design Tokens）：id、名称、type、collection、ukey、颜色 | `/data/{fileKey}` 二进制样式索引表（**实测与「样式」是同一批对象**） |
| `list_components` | 文件本地组件（COMPONENT，含组件集）：id、名称、ukey、isExternal、宽高 | `/data/{fileKey}` 二进制节点扫描（本质是带自引用 ukey 的容器节点） |
| `diff_files` | 两份文件/页面的节点树差异：新增/删除/修改，修改带字段级明细 | 基于 `get_page_tree` 输出做纯内存 diff |

### 推荐工作流

1. `get_file_meta` 获取文件基本信息，拿到 `fileKey`；
2. `list_pages` 拿到页面列表，确定目标页面（如 `10371:87078`）；
3. `get_page_tree` 传入目标页面，得到整棵图层树（含节点类型、父子层级）；
4. `get_file_nodes` 可按名搜索全文件节点，快速定位具体图层。

> `get_file_nodes` / `get_page_tree` 会全量下载 `/data/{fileKey}`（实测单个文件约数十 MB），因此首次调用较慢，之后 5 分钟内命中缓存。`get_page_tree` 通过逆向节点记录（`01=id / 02=parent / 03=类型码 / 04=name`）重建层级，并通过几何段首个 `1c` 子块字节判别类型（TEXT/FRAME/GROUP/RECTANGLE/ELLIPSE/LINE/PEN/SLICE/INSTANCE/BOOLEAN_OPERATION）。
>
> **两套容器编码（重要）**：MasterGo 先后使用过两套容器编码，**用同一套规则硬解另一种格式会造成大面积错判**（实测新格式命中率 0%、且把 GROUP 误判为 BOOLEAN_OPERATION）。因此解码前先按文件判定格式——依据「类型块为 `1c 07 01 01` 的节点占比」，旧格式约 1%（火车票 2413/188731）、新格式约 50%（Ant Design 5.0 147383/295784）：
> - **legacy**（火车票等早期文件）：父子层级与类型实测 **828/829 = 99.9%**（0 错判）；
> - **modern**（Ant Design 5.0 等较新文件）：容器类型块统一为 `1c 07 01 0?`，目前**只解出实测精确的部分**——GROUP（`1c 07 01 00`，覆盖真值 784/790 且零假阳性）、COMPONENT（几何段含组件 ukey `<fileId>+<selfId>`）、INSTANCE（`1a` 指向已识别组件）；**FRAME 等其余容器一律返回 `null`，宁可判空也不猜错**。
>   实测（Ant Design 5.0，73620 条容器真值，逐根走真实 `parsePageTree`）：改造前 **命中 0 / 错判 740（其中 GROUP→BOOLEAN_OPERATION 466）**，改造后 **命中 6140 / 错判 303**。剩余错判为两处**已知局限**，均因判别式精确率不足而未引入猜测：① 255 条「容器→LINE/RECTANGLE」——其几何段首个 `1c` 恰是叶子标记（段内也存在容器块，但让容器块压过叶子标记只有 55% 精确率）；② 48 条 COMPONENT_SET→COMPONENT——实测仅 24.9% 的 COMPONENT_SET 带 ukey，最优候选判别式精确率仅 79%。
> - 叶子类型（TEXT/RECTANGLE/ELLIPSE/LINE/PEN/SLICE）两套格式共用同一判别，不受影响。
>
> **`/data` 接口的两个实测特性（做回归时务必注意）**：
> 1. **忽略 `Range`**：带 `Range: bytes=0-8388607` 仍返回 `HTTP 200` + 完整 `content-length`（无 `content-range` / `accept-ranges`），所以 `list_pages` 实际也会下载整个文件。客户端据此在「未请求分段」或「请求了分段但返回 200（而非 206）」时按**全量缓存**，避免随后的 `get_page_tree` 重复下载同一个数十 MB 文件（实测省下约 2s 下载）。
> 2. **响应不可字节复现**：同一未变动文件（`updateAt` 三次查询一致）连续下载会得到**不同 md5**，长度相同但可有数千万字节差异（疑似记录序列化顺序随机）。因此**回归对比必须按结构（节点 id / 类型 / 层级），不要用 md5 或整文件 diff**。已验证解析器对此稳健：两份字节差异达 4353 万字节的新下载，均解析出同样的 **828/829** 类型结果、且逐节点类型完全一致（919 相同 / 0 不同）。

## 样式来源判定（`list_styles` 系列，2026-09-22 改）

样式索引记录里的 `07 <ukey>` 前缀是**定义该样式的文件 id**，历史上被当作「是否本文件」的过滤器，
结果是**从团队库复制/另存出来的文件一条样式都读不到**（实测 antd5 副本 `204971164239455`：
浏览器 `getLocalPaintStyles()` 真值 290 条 `remote:false`，而旧判据返回 0 条——它的记录 ukey 前缀全是源库 `122691166044911`）。
现在**不再按前缀丢弃记录**，全部返回并用两个字段标注来源：

- `sourceFileId`：ukey 前缀（新编码无前缀时 = 本文件 fileId）
- `isExternal`：`sourceFileId !== fileId`

> ⚠️ 已知局限：`isExternal` 只反映「谁定义了这条样式」，**不等于**客户端 UI 上的本地/远程。
> 真正的订阅关系在 `GET /api/v1/users/team-libraries/styles?documentId=...`（实测该接口**匿名 401**、
> 对部分公开文件还会 403），无法离线获取，故复制稿的样式会被标成 `isExternal=true`。
> 需要「只要本文件自建」时按 `sourceFileId === fileId` 过滤即可。
>
> 实测总数（含库引用）：antd5 副本 `204971164239455` → paint 291 / text 61 / effect 43 / 变量 411
> （2026-09-22 复测数；源库会变动，此类"多出来的库样式"数量**不作为断言**，详见「回归测试」）；
> 火车票（legacy）→ paint 4 本地 + 86 库引用、文字 0 本地 + 10 库引用（`test:regress` 已把两个数都写进基线；
> 文字从 4 涨到 10 是本轮放宽 TEXT 锚点 + 解出「0 值单字节」紧凑编码的真实回收，详见「回归测试」）。

## 回归测试（node-tree 类型解码守卫）

**脚本分层**（按是否需要网络/本地快照排序）：

| 命令 | 覆盖 | 前置 |
| --- | --- | --- |
| `npm test` → `test:diff` | diff 纯函数自检 | 无（纯内存，任何时候可跑） |
| `npm run test:regress` | legacy 节点树类型 + 样式基线 | 匿名下载 47MB 公开文件（或 `MG_REGRESS_SRC` 指快照） |
| `npm run test:styles` | **modern** 颜色/文字/效果/变量对浏览器真值（含值级断言） | 公开样本 `antd_modern` **自动匿名下载 `/data` 并缓存**，CI 必跑；私有样本 `mobile_kit` 需 `.cache/mg_mobile_kit.bin`（**不入库**，缺失只跳过它一个） |
| `npm run test:e2e` | MCP stdio 全链路 | 先 `npm run build:bundle` |

`npm run test:regress` → 逐 PAGE 根 `parsePageTree`，断言节点类型解码不退化。
配套真值已入库 `test/fixtures/train_ticket_truth.json`（火车票公开文件，829 条，字段名 `type`）。当前基线 **828/828 命中、0 错判**。

- **数据来源**：火车票文件 `isPublic: true`，无需认证即可下载，因此 CI 也能跑。默认实时下载 `/data/{fileKey}`（~47MB，首次较慢）。
- **本地加速**：已有快照时设 `MG_REGRESS_SRC` 指向它即可跳过下载；`MG_REGRESS_CACHE` 可把在线下载结果缓存一份供下次复用。
- **比对方式**：**按结构/类型比对**，绝不 md5 / 整文件 diff——`/data` 响应不可字节复现（见上文）。

### `test:styles`：modern 编码的真值守卫（2026-09）

legacy 与 modern 是**两套 ukey 编码 + 两类样式序号短码**，只测一个极易改坏另一个，故本守卫跑两个样本：

| 样本 | 可见性 | fileId | 编码特征 | 基线（记录数 / 真值条数） |
| --- | --- | --- | --- | --- |
| `antd_modern` | **公开**，CI 必跑 | `204971164239455`（antd5 副本） | 旧 ukey `<fileId>+<id>`、样式全部来自源库 `122691166044911`；TEXT 短码非 `a` 开头 | paint ≥290、text ≥29、effect ≥34、变量 ≥365（下限=真值条数） |
| `mobile_kit` | 私有，缺快照只跳过自己 | `107389953208823` | **新 ukey `+<id>`**（无前缀） | paint 38、text 13、effect 6、变量 57 |

- **真值入库**：`test/fixtures/truth_antd_modern.json`（浏览器 `window.mg` 导出，含 12 条数值型变量的 `floatData`）。
- **断言到值**：SOLID 颜色 RGBA、文字 fontSize/lineHeight/PostScript/字间距、效果 alpha/radius/offsetY、变量 type 与数值型 `floatData` 逐值对照。
- **记录数只设下限，不钉死精确值（2026-09-22 修正）**：多出来的记录是二进制里带的其他库样式，**随源库增减而变、与解码正确性无关**。
  实测远端源库变化后 paint 294→291、vars 414→411（真值仍 290/290 全覆盖），精确相等会误报红灯。
  现在下限 = 真值条数（防漏读），**解码是否退化由「真值逐条覆盖 + 值级对照」负责** —— 已注入故障验证：值改错 / 整表读不出均能判红。
- **⚠️ 静默跳过即失效**：只要**一个样本都没真正跑起来**就 `exit 1`（曾出现「私有快照 403 得到 36 字节错误体被当成快照 → 解出 0 条 → 全绿」的假通过，现已加最小体积校验）。
- **本地快照**：`MG_STYLE_SRC_ANTD` / `MG_STYLE_SRC` 可分别指向两份 `/data` 快照跳过下载；私有样本获取方式见脚本头部注释。

## CI 与端到端验证（2026-09-21）

- **GitHub Actions**（`.github/workflows/ci.yml`）：push/PR 触发，依次跑 `npm ci` → `tsc` → `test:diff` → `test:regress` → `test:styles` → `build:bundle` → `test:e2e`。
  两个需要 `/data` 的步骤共用 `actions/cache`（key `mg-bin-v2`，缓存 `~/.cache/mg`）复用二进制快照，**cache 步骤必须排在消费者之前**（此前排在 `test:regress` 之后，等于从未命中过 —— 已修）。
- **`npm run test:diff`**（`scripts/verify-diff.ts`）：diff 纯函数自检，纯内存、不依赖网络/二进制。
- **`npm run test:e2e`**（`scripts/e2e-mcp.ts`）：以真实 MCP 客户端身份 spawn `dist/index.cjs`，走 JSON-RPC stdio 全链路——initialize → `tools/list`（断言 10 个工具齐全）→ 依次调用 `get_file_meta` / `list_pages` / `get_page_tree` / `diff_files` / `get_file_nodes` / `list_styles`，基于 **Ant Design 5 官方公开文件**（antd5，modern 格式 74 页，无需 Cookie），首次全量下载 ~106MB、进程内缓存复用。本地实测全链路 PASS（list_pages 74 页、get_file_nodes 144055 节点）。

## 权限说明（重要）

- **公开文件（`isPublic: true`）无需任何认证**：实测不带 Cookie、甚至带无效 Cookie，`GET /api/v1/documents/{fileId}` 与 `/data/{fileKey}` 均返回 `200` 与完整数据。因此客户端**不做 Cookie 前置校验**（前置拦截会让公开文件的 `list_pages` / `get_page_tree` 误失败）；
- **私有文件必须带浏览器 Cookie**，但无需付费席位。实测无 Cookie / Cookie 失效时服务端返回 `403`，响应体形态为：
  - `/data/{fileKey}` → `{"code":"AccessDenied","message":""}`
  - `/api/v1/documents/{fileId}` → `{"code":"NotAllowAnonymousAccess","meta":{"msg":"document not public"}}`
  - fileKey 不存在 → `{"code":"AccessDenied","message":""}`
  客户端统一归一化为可操作的中文提示（`mastergo.ts` 的 `ERROR_HINTS` + `normalizeErrorBody`）。注意 `/data` 用 `responseType: "arraybuffer"`，错误体是二进制，**必须先解码成 JSON** 才能读到 `code`，否则会得到空消息；
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
  diff.ts         # 节点树差异对比（纯函数：id/path 匹配 + 字段级 diff，供 diff_files 使用）
  tools.ts        # MCP 工具定义与参数
scripts/
  build.mjs       # esbuild 打包：src/index.ts → dist/index.cjs（单文件自包含，`prepare` 钩子调用）
  regress.ts / verify-styles-truth.ts / verify-diff.ts / e2e-mcp.ts  # 各级守卫，见「回归测试」
dist/
  index.cjs       # 运行产物（含 shebang，可作 bin：mastergo-mcp）
```

## 待实现能力（Roadmap · 均基于网页接口自研）

- [x] **图层/节点深度读取**：完整节点树已解码（id / 名称 / 类型 / 父子层级，`get_page_tree`）。类型解码已支持**两套容器编码**（按文件自动判定，见上文「两套容器编码」）：legacy 实测 828/829 = 99.9%（0 错判）；modern 命中率 8.3%、错判率 0.41%（FRAME 等仍在逆向，当前返回 `null` 而非猜错）
- [x] **几何与布局属性（部分完成）**：尺寸（width/height）、透明度（opacity）、圆角（cornerRadius，RECTANGLE）、x/y 坐标（带符号）、rotation/transform 已在 `get_page_tree` 的 `geometry` 输出，实测与浏览器一致（178 x / 177 y 对照 100%）。
  - x/y 符号位已破解：坐标为 18 块内 `01/02` 子块跟随的**带符号**紧凑浮点，符号位是 24 位小端尾数最低字节 bit0（置 1 为负、清 0 为正，`positionSignResolved` 恒为 `true`）。
  - rotation/transform 已破解：18 块容纳完整仿射变换，子 `01=tx(x)`、`02=ty(y)`、`03..06` 按 `(m00,m11,m01,m10)` 顺序打包 2×2 矩阵 `m=[[s3,s5],[s6,s4]]`，`rotation = atan2(m10,m00)`（度；无旋转子 03..06 省略为单位阵）。8 个 rotation 节点对照浏览器 `relativeTransform` 真值 8/8 一致。
  - fill(纯色)/stroke 已破解：颜色不内联在节点记录，而存于独立的 **paint 定义表**（`01 <selfId>\0 02 <refId>\0 03 61 30\0 00 08 <A> <R> <G> <B> [09 <A'>]`，实测 987 条，RGBA 用紧凑浮点编码）。节点记录里 `15 <refId>`（图元 fill）/`16/17 <refId>`（stroke）/`09 01 02 02 03 <refId>`（TEXT fill）引用该表。solid 纯色对照浏览器真值 143/153 命中（余为渐变/实例内部/隐藏描边）。
  - **节点级渐变 fill（2026-09）**：节点 fill 引用的 `refId` 若命中渐变 paint 表（`buildGradientTable`），直接复用渐变解码输出 `type`/`gradientStops`/`gradientHandlePositions`，而不再退回 paintMap 得到 `UNKNOWN/null`（渐变键在 paintMap 中恒「不含」）。`parseNodeGeometry` 新增 `gradientMap` 参数，`parsePageTree` 每页构建一份渐变表。实测火车票「定稿5：首页火车票卡片」页面 20 个渐变 fill 节点，抽查节点 3914:24830 的 fill 为 `GRADIENT_LINEAR` 双 stop + 手柄。已加入 `test:regress`（`checkNodeGradFills`）作守护。
- [x] **strokeWeight（描边宽度）**：描边宽度已破解。几何段内、13 引用块之前，key=`0x10`：`10 00`→0（隐藏描边）、`10 <4字节紧凑浮点>`→权重值、无该字段→默认 1。实测 63/63 与浏览器真值一致。
- [x] **strokeAlign（描边对齐）**：字段 `13`：`01`→CENTER、`02`→INSIDE、`03`→OUTSIDE，缺省 CENTER。实测 776/776 与浏览器真值一致。
- [x] **constraints（布局约束）**：字段 `0b`=vertical、`0c`=horizontal：`01`→END、`03`→CENTER、`04`→SCALE，字段缺省→START；两字段仅在该轴非默认值时出现（如 `0b 03 0c 03` 即垂直/水平皆 CENTER）。实测垂直 546/548、水平 546/548 与浏览器真值一致（2 例偏差为实例内部节点继承母版约束）。
- [x] **autoLayout 自动布局（flexMode/padding/itemSpacing/对齐/sizingMode）**：已破解并落地到 `geometry.autoLayout`。字段位于几何段内 `1c 07` 类型块（FRAME/INSTANCE/GROUP/BOOLEAN_OPERATION）中：`08 <v>`→flexMode（00=NONE/01=HORIZONTAL/02=VERTICAL）、`09 <紧凑浮点|00>`→itemSpacing、`0a 01<pt> 02<pr> 03<pb> 04<pl> 00`→padding（每边为 0 以单字节 `00` 存）、`0d <ma> 0e <ca>`→主轴/交叉轴对齐（0=FLEX_START/1=FLEX_END/2=CENTER/3=SPACING_BETWEEN）、锚点 `1e 00 [1f <0|1>] [20 <紧凑浮点|00>] 21 <ms> [22 <xs>]` 内 `21`→主轴 sizingMode、`22`→交叉轴 sizingMode（0=FIXED/1=AUTO，`22` 缺省时按 AUTO 处理）。实测（Ant Design 5.0，73620 条布局真值，逐根走真实 `parsePageTree`；另有 40225 个实例内部节点 `autoLayout` 为 null，不计入下表分母）：

| 字段 | 命中 | 错判 | 判空 | 命中率（命中/(命中+错判)） |
| --- | --- | --- | --- | --- |
| flexMode | 33302 | 37 | 0 | 99.89% |
| itemSpacing | 32664 | 658 | 17 | 98.03% |
| padding 上/右/下/左 | 32507 / 32525 / 32498 / 32527 | 647 / 629 / 656 / 627 | 185 | ≈98.0% |
| mainAxisAlignItems | 33081 | 0 | 258 | 100.00% |
| crossAxisAlignItems | 33014 | 67 | 258 | 99.80% |
| mainAxisSizingMode | 30126 | 190 | 3023 | 99.37% |
| crossAxisSizingMode | 29277 | 1039 | 3023 | 96.57% |

偏差集中在**实例内部节点**（id 含 `/`，其 `1c 07` 块省略布局字段、继承母版，autoLayout 为 null，共 40225 个）与**绑定了设计令牌**的节点（几何段内 `2a {"tokens":...}` 覆盖了内联值）。padding/itemSpacing 的错判高度集中——各字段的 top1 错判都是**同一批 608 个节点**（itemSpacing 二进制 `10`→真值 `0`、paddingTop 二进制 `1`→真值 `6`、paddingRight `3`→`6`…）。
  > **608 节点覆盖来源已定位（2026-09，结论：无可靠二进制判据，不回填）**：这批节点全部是 **DatePicker 组件库实例**（INSTANCE，真值 `fm=VERTICAL`）。它们的**整个布局块**（flexMode/itemSpacing/padding/对齐/sizingMode）与浏览器真值全不一致（仅 cornerRadius=6 正确，对应 `borderRadius` 令牌），且**母版继承与令牌都无法解释**——母版（如 `0:16302`）布局块内容与实例相同而真值也是覆盖值；实例段内 `2a` 令牌仅含 `borderRadius`（不涉及 itemSpacing）。候选判据均失败：全部节点带 `25 02` 标记 + `2a` 令牌，但**正确节点中同样组合有 6288 个**（据此判据召回 608 时的精确率仅 ~9%）。结论：布局值由组件库主题在**客户端渲染层**覆盖，二进制内联的是组件**定义值**、浏览器生效的是**覆盖值**，以现有 `/data` 素材找不到可靠判别依据。按「宁可判空也不猜错」原则**不回填**，维持输出二进制内联值。
- [x] **组件与样式资源（全部完成）**：颜色/文字/效果样式与组件四个工具已交付，并与浏览器真值**逐条一致**。
  - **组件库已实现（2026-09-20）**：`list_components` 交付。实测认知：MasterGo 的「组件」**没有独立编码表**，本质是「带自引用 ukey 的容器节点」——组件 id 就是真实图层节点 id（`getComponentListVal()` 的 id 均为真实节点 id）。判据 = 节点几何段内含 `1c 07` 容器块、**且**该块内含自引用 ukey（`+<selfId>\0`，无需 fileId 前缀，格式无关，legacy/modern 通用，零假阳性）；ukey 前缀 `<fileId>+<selfId>` 用于判定是否本文件（`isExternal`）。实测（火车票公开文件）：**96/96** 条 id/name/ukey/width/height 与浏览器 `getComponentListVal()` 真值一致（含组件集内子组件，`parentId` 记录组件集归属）。
  - **样式索引表**（颜色/效果/文字样式与变量**共用同一张表**）记录格式：
    `01 <id>\0 02 <name>\0 03 61 <c>\0 [04 <desc>\0] 05 <n> [子块] 00 00 [06 01] 07 <ukey>\0`
    - **`05 <n>` 才是类型判别式**：`1`=PAINT、`2`=EFFECT、`3`=TEXT、`6`=数值型（`CORNER_RADIUS`/`NUMBER`；实测 57/57 纯净、零杂音）。`6` 还要再看子块首字段 `05 06 01 <sub>` 才能二选一：`sub=3`→四值圆角、`sub=1`→单值数字。
    - ⚠️ `03 61 <c>`（a0/a1/aL…）**不是**类型：同一类型的 c 各不相同（Purple=aL、Yellow=a1、Success=aF 同为 PAINT），它只是一个序号
    - **锚点与放宽（2026-09）**：`<c>` 以 `a`(0x61) 开头是**主锚点**——节点记录长成 `01 id 02 name 03 c 04 类型名 05 n`，其 `05 <n>` 是**节点类型**、与样式编号撞车（去掉 `a` 要求后火车票 PAINT 候选从 90 涨到 362），故 `a` 不能整个去掉。但**文字样式存在整批非 `a` 开头的编码**（antd5 副本 29 条真值文字样式 c 全是 `ZJ`/`ZR`/`E`/`N`…），此前按 `03 61` 硬锚点导致**整张 modern 文字样式表读不出来**；现对 TEXT 放宽锚点，改由「子块必须完整解析到 `07 <ukey>`」佐证（非 TEXT 类型无可靠子块判据，仍要求 `a`）
    - **两套 ukey 编码**：新文件只存 `+<selfId>`（**不含 fileId**），旧文件存 `<fileId>+<selfId>`；`04 <desc>` 与 `06 01` 均可整体缺省（旧编码常见 `06 01`，新编码没有）
    - 定位锚点用 `07 <ukey>\0`（样式记录独有，可排除大量形似的节点记录：不过滤时新文件匹配 225 条，过滤后恰为 57 条真值）
    - 本文件判定**不能**只靠 `ukey.startsWith(fileId + "+")`：新编码下必然 0 命中（这正是 `list_styles` 曾经的漏检 bug）
  - **paint 定义表**：`01 <paintId>\0 02 <styleId>\0 03 61 30 00 04 00 08 <A><R><G><B>`，**通道顺序是 a,r,g,b**、每通道「0 值压成单字节 `00`、非 0 用 4 字节紧凑浮点」。⚠️ 曾按「首通道是基值 + r/g/b 定长 4 字节 + alpha 取 `09`」读取，只在 alpha=1 的样本上碰巧正确：任何**半透明或含 0 通道**的颜色都会解错（如 `08 00 00 00 00` 被读成 `r=6e-39`）。`09` 是另一个量（实测 1 / 0.65 / 0.45），**不是**颜色 alpha。antd5 逐值验证 288/288 SOLID 正确。⚠️ paint 图元 id 可**省略数字前缀**（形如 `:005`），用严格的 `^\d+:\d+$` 校验会把整条记录跳过，导致所有样式颜色解成 `null`。
  - **效果定义表**：`01 <effectId>\0 02 <refId>\0 03 61 <c> 00 04 00 05 <n> 08 <alpha><R><G><B> <09 <radius>> <0a <offsetX>> <0b <offsetY>> <0d <type>> <0e <2B>> <0f <spread>>`。0 值用单字节 `00`，非 0 用 4 字节紧凑浮点；`0d` 单字节 1=DROP_SHADOW、`0f`（spread）紧凑浮点，**负号=mantissa 最低字节 bit0 为 1**。`03 61` 后的 `<c>` 是**变长 C 字符串**（legacy 单字节如 `34`、antd5 多字节如 `4d 20 20 26`），须按 `readCstr` 读取而非硬编码单字节。
    - **顺序规则（关键）**：同一效果样式的多条效果项物理上**分散**在多个 `01 <effectId>` 定义记录里，且字节序与浏览器 API 真值**不一致**；需按每条 `01 <effectId>` 的**数字后缀降序**排序后才与真值完全对齐（antd5 34/34、90/90 项验证）。
    - **缺省规律（2026-09 破析）**：legacy 下 `09`/`0b` 会**整字段缺省**且缺省**不等于 0**，但 antd5（modern 编码）34 个效果样式 90 个效果项**全部含 09/0a/0b/0f**、无缺省反例 —— 说明缺省是 legacy 旧编码的历史行为。现按「字段出现则取值、未出现输出 null」处理。
  - **文字样式子块**（`05 03` 之后）：`02 <3B 字体族 id> 03 <字体名>\0 04 <紧凑浮点 fontSize> 05 <紧凑浮点 lineHeight> 06 <1B> 0b <1B> 0c <PostScript 名>\0 0e <紧凑浮点 fontSize×1.2> 0f <字体 hash>\0`。`0e` 恒为 fontSize×1.2（12→14、16→19、20→24、40→48 全部验证通过）。`06`/`0b` 在 13 个样式中恒为 `01`（对应 textCase=ORIGINAL），枚举语义无从取样故不输出。
    - **modern 布局（antd5 等，2026-09 破析）**：`03 <字体名>\0 04 <紧凑浮点 fontSize> [08 <紧凑浮点 letterSpacing>] 0c <PostScript 名>\0 12 <json 字体元数据>\0 13 <8B> …`。新增 `08`=**字间距**（**仅非 0 时出现**，0 则整字段缺省；单样本 `08 83 00 00 e0`=30 与浏览器真值一致，单位 PERCENT）。`08`/`12`/`13` 已纳入 `parseTextStyleBody`；modern 样式仅反解出 fontSize/字体/letterSpacing，lineHeight/hash 在该布局缺省。
    - ⚠️ 输出的 `fontName.family` 由 PostScript 名按最后一个 `-` 拆分，可能是**压缩形式**（二进制存 `OpenSans`，真值 API 返回 `Open Sans`）；需要精确字体名请用 `fontPostScriptName`。
  - 渐变样式（GRADIENT_LINEAR/RADIAL）已破解（2026-09）：渐变 paint 图元 `01 <selfId>\0 02 <refId>\0 03 61 <sub> 00 05 <kind> 08 …` 中 `<kind>` 判别类型（1=LINEAR、2=RADIAL），`08` 后是多色 stops + 手柄。紧凑数字约定 **0 值压成单字节 0x00、非 0 用 4 字节紧凑浮点**；stop 颜色按 **a,r,g,b** 顺序；stop0=`<color><position>`、其余= `01 <position> 02 <color>`；手柄 `0a 03 <h0> [04 <h1>]`（RADIAL 存两对、LINEAR 只存一对，第二个由轴默认推导未编码）。渐变 paint 的 refId 即所属样式 id，故按 refId 聚合到该样式。实测火车票 `渐变` 样式两笔渐变的 stops/handles 与浏览器真值**逐位一致**。
- [x] **变量（Variables）**：已交付 `list_variables`，实测 **57/57** 条 id/name/type 与浏览器 `variables.getVariables()` 真值一致。数值型变量（`05 06` = CORNER_RADIUS/NUMBER）**已破解**，`floatData` 逐值命中 antd5 真值（详见 ⑤ 节）。
  - **重大认知纠正**：MasterGo 的**「变量」与「样式」是同一批对象**。浏览器真值交叉验证：`getLocalPaintStyles()` + `getLocalTextStyles()` + `getLocalEffectStyles()` 的 id 集合与 `variables.getVariables()` 的 id 集合**双向完全包含**（各 57 个），变量 `type` 分布恰为 `{PAINT: 38, EFFECT: 6, TEXT: 13}`。即样式 API 是「按 type 过滤的视图」、变量 API 是「统一视图」，二者共用同一张索引表 —— **破解变量 = 破解样式**。
  - **`M:1` / `M:2` 是真实 id**（纠正旧说法）：真值 `getCollections()` 返回 `[{id:"M:1", name:"集合", isExternal:false, modes:[{id:"M:2", name:"模式 1"}]}]`，并非客户端凭空构造的 pseudo-id；变量组 id 形如 `M:1_Neutrals`、`M:1_外部/Carbon Neutral`。
  - 未输出：`scopes`（二进制内未定位到该字段）、`codeSyntax`、多模式值（本文件仅 1 个模式 `M:2`；数值型变量的该模式值已解出为 `floatData`）。
- [ ] **图片/切图导出**：节点导出为 PNG/SVG/PDF，可交付到本地目录。**⚠️ 暂不考虑**（`window.mg` 未见导出函数，功能缺口虽大但逆向难度高）——待开发者后期指明要求再做，见 NEXT.md。
- [x] **设计稿差异对比**：`diff_files` 已交付（2026-09-21）。基于 `get_page_tree` 输出做两份快照的节点 diff（纯内存，不依赖真值）。匹配策略 `match_by`：`id`（默认，同文件不同版本，id 稳定）或 `path`（跨文件，按「根→节点的名称路径」匹配，重名兄弟按出现次序加 `#n` 消歧；节点改名表现为 removed+added）。输出 added/removed/changed 三类变更，changed 带字段级明细（如 `geometry.x`、`name`、`type`，数字按 1e-6 容差）；`ignore` 可跳过 `name`/`type`/`geometry` 或 geometry 子字段；`max_changes` 控制返回条数。`npm run test:diff` 为纯内存自检（不依赖网络/二进制）。
- [x] **Cookie 过期检测 / 错误归一化**：`MasterGoError` + `toMasterGoError` 覆盖全部请求路径（含 `/data` 的 `arraybuffer` 错误体解码）。实测 `403 AccessDenied`（Cookie 失效 / 无权限）、`403 NotAllowAnonymousAccess`（文件未公开）、`NoDocumentPermission`、`NotFoundDocument`、`10003` 均给出可操作的中文提示；此前 `/data` 绕过归一化，失效时抛出**空消息**的原始 axios 错误，现已修复。
- [x] **打包发布**：`npm pack` / 单文件二进制（esbuild），免 npx tsx 依赖（已完成 2026-09-20：`package.json` 补 `bin`/`files`，`npm run build:bundle` 出 `dist/index.cjs`）

## 未解析内容 · 接手指南

以下的逆向方向均被**「缺少可供对照的真值样本」**阻塞：要么当前火车票文件里没有该特性，要么需要导出浏览器 API 真值才能定位二进制锚点。通用方法论（前几项已反复验证有效）是：

> **准备一份含目标特性的设计稿 → 在浏览器打开该文件 → 执行 JS 调用 `window.mg` API 导出「真值」JSON 存盘 → 同步把该文件 `/data/{fileKey}` 二进制整份存盘（约几十 MB）→ 在二进制中搜索真值里的特征字符串（ukey / collectionId / 样式名 / 组件名等）定位记录 → 写 probe 脚本对照解码 → 落地到 `node-tree.ts` + 新工具。**
>
> ✅ **真值导出链路已打通（2026-09-20）**：本项目的浏览器工具**支持在页面里执行任意 JS**，`window.mg` 是完整的 MasterGo 插件 API（99 个键），可直接调 `getLocalPaintStyles()` / `getLocalTextStyles()` / `getLocalEffectStyles()` / `getComponentListVal()` / `variables.*` 等导出真值。**旧文档「browser-skill 不支持任意页面 JS 求值、真值导出做不了」的断言已不成立。**
> 大 JSON 不必手工搬运：把真值挂到 `window.__T`，起一个本地接收器（`node .cache/post_server.cjs <out.json> 8787`，需回 `Access-Control-Allow-Origin: *`），再从页面 `fetch('http://127.0.0.1:8787/', { method:'POST', body: window.__T })` 即可 —— HTTPS 页面 POST 到 `127.0.0.1` 属 potentially trustworthy，不会被拦。
> ⚠️ 页面里 `a.download` + Blob 触发的**自动下载会被浏览器拦截**，不要走那条路。
> 💡 逆向时优先用「真值特征串」定位记录（如 `0:7861` 含 3 个阴影 → 定义表恰好 3 条），比盲扫锚点高效得多。

- **真值来源 API**（浏览器里 `window.mg`，多为已暴露的导出函数）：`getLocalPaintStyles()`（颜色，已用）、`getLocalTextStyles()`（文字）、`getLocalEffectStyles()`（效果）、`getComponentListVal()`（组件）、variables 相关（见 ⑤）。先用 `Object.keys(window.mg)` 罗列可用函数再挑。
- **连接浏览器**：chrome-devtools MCP（`server_name=mcp_plugin_Chrome_DevTools_chrome-devtools`）。先 `list_pages` 找到目标设计稿所在的标签页 id（火车票文件是 `pageId=2`），再 `evaluate_script` 传 `{ pageId, function: new Function(...) }`；注意**不要**传 `returnByValue`（不支持的参数）。
- **存盘路径**：入库真值统一放 `test/fixtures/truth_*.json`（如 `train_ticket_truth.json`、`truth_antd_modern.json`、`truth_mobile_kit.json`）；`/data` 二进制快照放 `.cache/*.bin`（**gitignore，不入库**）。probe 脚本放项目根目录、以 `probe_*.mts` 命名（**`.mjs` 跑不了 TS 类型标注**，`node --experimental-strip-types` 只认 `.mts`），验证后删除。
- **本文件文件级 key**：fileId/`documentId = 115278536821990`，`fileKey = 890c5c78-...`（从 `get_file_meta` 拿）。ukey 前缀 = `115278536821990+`（**这是旧编码**）。
- ⚠️ **ukey 有两套编码**：新文件（如「移动端界面设计」）的 ukey 只存 `+<selfId>`，**不含 fileId**。任何「按 ukey 前缀筛本文件」的写法都必须同时兼容两者，否则在新文件上必然 0 命中（`list_styles` 曾因此完全失效：真值 38 条、返回 0 条）。
- **移动端界面设计（私有，新编码参考文件）**：fileId `107389953208823`，fileKey `2b195a62-0d3e-40ee-b55f-59b607e729a0`。含颜色样式 38 / 文字样式 13 / 效果样式 6 / 变量 57 / 组件 144，是样式与变量解码的**主要真值来源**。⚠️ 该私有快照需登录 Cookie 才能下 `/data`；**Cookie 失效时服务端返回 403 `AccessDenied`（约 36 字节的 JSON 错误体），把它当成快照落盘会让守卫解出 0 条却「绿」**——`test:styles` 已加「小于 64KB 的快照一律判无效」的防护。

### ① 自动布局（autoLayout）约束 —— 已完成（2026-09）
- **结果**：已破解并落地到 `node-tree.ts` 的 `geometry.autoLayout`（`NodeAutoLayout` 接口 + `parseAutoLayout`）。
- **字段编码**（位于几何段内 `1c 07` 类型块，键号与外层几何段复用但作用域独立）：
  - `08 <v>` → flexMode：`00`=NONE、`01`=HORIZONTAL、`02`=VERTICAL
  - `09 <紧凑浮点 | 00>` → itemSpacing（`09 00`=0）
  - `0a 01<pt> 02<pr> 03<pb> 04<pl> 00` → padding（每边为 0 时以单字节 `00` 存）
  - `0d <ma> 0e <ca>` → main/crossAxisAlignItems：`0`=FLEX_START、`1`=FLEX_END、`2`=CENTER、`3`=SPACING_BETWEEN
  - 锚点 `1e 00 [1f <0|1>] [20 <紧凑浮点|00>] 21 <ms> [22 <xs>]` → `21`=mainAxisSizingMode、`22`=crossAxisSizingMode：`0`=FIXED、`1`=AUTO（`1d 01`/`1f <v>`/`20 <float|00>` 为可选前缀；`21` 恒存在，`22` 常缺省、缺省按 AUTO 处理）
- **真值与命中率**：以 Ant Design 5.0 稿（fileKey `eb0ea904-...`，真值 `ad_truth.json` 73620 条、二进制 `ad_src.bin` 105.8MB）对照，见 Roadmap 中 autoLayout 条目。**注意复现方式**：真值需按「所属根节点」分组、对每个根调 `parsePageTree` 后取节点（全量 473 个根约 35 分钟），单遍扫描无法覆盖实例内部节点。
- **已知局限**：实例内部节点（id 含 `/`）的 `1c 07` 块省略布局字段，`autoLayout` 为 null（继承母版）。sizingMode 残差（主轴 ≈0.7%、交叉轴 ≈3%）集中在含 `25 02` 标记的节点——疑似尺寸由父/母版继承或覆盖（layoutGrow/STRETCH），实测其真值并非都能由内联值或父节点继承还原（探针 `probe_sz18`）。曾试过在 `25 02`/`2a` 上抑制（置 null），但这只是把「猜错」换成「漏报」，原始错误数反而上升，故未采用。

### ② 文字样式表（Text Styles）—— ✅ 已完成（2026-09）
- **已实现**：`list_text_styles` 工具。实测「移动端界面设计」文件 **13/13** 条 id/name/fontSize/lineHeight 与浏览器 `getLocalTextStyles()` 真值完全一致。
- **关键结论（推翻本节旧推测）**：
  - 文字样式**不是**独立的一张表，而是与颜色/效果样式、变量**共用同一张「样式索引表」**，靠记录内的 `05 <n>` 判别类型（`3` = TEXT）。
  - 旧推测「`03 61 <subtype>` 的 subtype 就是类型」**是错的**：`03 61 <c>` 只是序号 —— 同为 PAINT 的样式 c 各不相同（Purple=aL、Yellow=a1、Success=aF）。
  - 火车票文件确实 0 个文字样式，但**新编码文件里有**；旧编码下 `04 <desc>` / `06 01` 可整体缺省，锚点需容忍。
- **文字样式子块**（`05 03` 之后，**legacy**）：
  `02 <3B 字体族 id> 03 <字体名>\0 04 <紧凑浮点 fontSize> 05 <紧凑浮点 lineHeight> 06 <1B> 0b <1B> 0c <PostScript 名>\0 0e <紧凑浮点 fontSize×1.2> 0f <字体 hash>\0`
- **modern 子块（antd5 等，2026-09）**：`[02 <3B>] [01 <1B>] 03 <字体名>\0 04 <fontSize> [08 <字间距>] 05 <lineHeight> … 0c <PostScript>\0 12 <json 字体元数据> 13 <8B> …`。⚠️ modern 记录**以 `01 <1B>` 开头**（legacy 是 `02 <3B>`），且 `04/05/08` 等数值字段遵循「0 值压成单字节 `00`」—— 此前按定长 4 字节读会把整块读崩。`08` 字间距仅非 0 时出现（antd5 取样：编辑器把字间距 0%→30% 后 `createTextStyle`，反解 `08 83 00 00 e0`=30 ✓）。放宽锚点 + 修 0 值读取后，antd5 真值 **29/29** 全覆盖、火车票库引用文字样式从 4 涨到 **10**（都是真实回收，见 `test:styles` 与 `test:regress` 基线）。子块解析以「走到 `07 <ukey>` 才算数」作非 `a` 锚点的佐证。
- **仍未解出**：`textCase` / `decoration` 枚举语义 —— 现有所有样式两个字段**全是同一个值**（ORIGINAL / NONE），无法验证枚举语义；`createTextStyle` 的 textCase/decor 参数被忽略、编辑器控件自动化难以稳定命中，故未取样到非默认值。textCase 相关字节 `06`/`0b` 恒为 `01`。

### ③ 效果样式表（Effect Styles）—— ✅ 已完成（2026-09，含已知局限）
- **已实现**：`list_effect_styles` 工具。**Ant Design 5 文件（antd5，34 样式 / 90 效果项）全量受检**：id/name 逐条一致，color/radius/offsetX/offsetY/type/spread **90/90 项与 `getLocalEffectStyles()` 真值完全一致**（含顺序）。legacy 火车票 6 样式回归仍 PASS。
- **关键结论**：效果样式的**值不在样式索引记录里**（那里只有 `05 02 00 00`），而在**独立的效果定义表**中，表内 `02 <refId>` 指向样式 id、`01 <effectId>` 是该效果项自身 id：
  `01 <effectId>\0 02 <refId>\0 03 61 <c> 00 04 00 05 <n> 08 <alpha><R><G><B> <09 <radius>> <0a <offsetX>> <0b <offsetY>> <0d <type>> <0e <2B>> <0f <spread>>`
  - 与 paint 定义表的区别：`04 00` 后**多一个 `05 <n>`**；0 值用单字节 `00` 表示，非 0 才写 4 字节紧凑浮点
  - `0d` 单字节类型（1=DROP_SHADOW）；`0f`（spread）紧凑浮点、**负号=mantissa 最低字节 bit0 为 1**
  - `03 61` 后的 `<c>` 是**变长 C 字符串**（antd5 多字节如 `4d 20 20 26`），不可硬编码为单字节
  - **顺序**：同一款式的效果项字节序与 API 真值不一致，按 `01 <effectId>` **数字后缀降序**排序后才对齐（34/34、90/90 验证）
- **缺省规律（2026-09 破析，旧「已知局限」已解决）**：legacy 旧编码下 `09`/`0b` 会**整字段缺省**且缺省≠0；但 **antd5（modern 编码）34 样式 / 90 个效果项全部含 `09`/`0a`/`0b`/`0f`、无缺省反例** —— 缺省是 legacy 的旧编码行为，非通用规律。现按「字段出现则取值、未出现则 null」输出。
- **另需取样**：`type` 仅取样到 1=DROP_SHADOW，INNER_SHADOW / LAYER_BLUR / BACKGROUND_BLUR 的 `0d` 字节值未验证；`0e` 的 2 字节语义仍未知。

### ④ 组件列表（Components）—— ✅ 已完成（2026-09-20）
- **已实现**：`list_components` 工具交付，按文件返回本地组件（id/name/ukey/isExternal/parentId/pageId/width/height）。
- **核心认知（推翻本节旧推测）**：MasterGo 的「组件」**没有独立编码表**，本质是「**带自引用 ukey 的容器节点**」——组件 id 就是真实图层节点 id（`getComponentListVal()` 返回的 id 在 `get_file_nodes` 全量节点里都能找到）。因此**无需专门的索引表**，直接扫节点树即可。
- **判据（已验证格式无关，legacy/modern 通用）**：节点几何段内含 `1c 07` 容器块，且该块内含自引用 ukey `+<selfId>\0`（**零假阳性**）。注意不能复用 `findContainerBlock`（它硬编码 `1c 07 01` modern 语义，组件容器的第 3 字节可为 01/03/09/0a），须在组件扫描内独立找 `1c 07`。
- **isExternal 判定**：读 ukey 前缀 —— 新编码只存 `+<selfId>`（本文件）、旧编码存 `<fileId>+<selfId>`（比较 fileId 是否等于当前文件）。
- **实测（2026-09 火车票公开文件）**：**96/96** 条 id/name/ukey/width/height 与浏览器 `getComponentListVal()` 真值一致（含组件集 COMPONENT_SET 内子组件，`parentId` 记录其归属组件集）。
- **已验证的连带能力**：`decodeModernContainer` / `get_page_tree` 里的 COMPONENT（几何段含 ukey）与 INSTANCE（`1a <componentId>` 指向已识别组件）识别；legacy 文件的 COMPONENT 识别（`b===0x07 && c===0x01 && hasSelfUkey`，复用零假阳性判据，火车票识别出 87 个 COMPONENT）。
- **未做 / 仍无可靠判据**：COMPONENT vs COMPONENT_SET 的二值判别（最优候选判别式精确率仅 79%，故 `list_components` 与 `get_page_tree` 均不区分、按「宁可判空不猜错」原则折叠为 COMPONENT）；组件封面图 / cover、description 未导出。

### ⑤ 变量（Variables / Design Tokens）—— ✅ 已完成（2026-09）
- **已实现**：`list_variables` 工具。实测 **57/57** 条 id/name/type 与浏览器 `variables.getVariables()` 真值一致。
- **数值型变量（`05 06` = CORNER_RADIUS / NUMBER）——2026-09 破解**：样式索引记录的子块布局
  `01 <sub> 02 <count> [<count> 个「紧凑浮点或 0」] 00 00 [06 01]`，`sub=3/count=4`→CORNER_RADIUS（四角各一值）、`sub=1/count=1`→NUMBER（单值），输出为 `floatData`。
  实测 antd5 副本 **12/12** 条与浏览器 `modes["M:2"][0].floatData` **逐值一致**（如 `Padding`=16、`Padding XL`=32、圆角 `全圆角`=[256000×4]），已写进 `test:styles` 的值级断言。⚠️ 圆角值并非 antd 令牌的直觉值（`基础` 真值是 6 不是 8），只能靠真值钉、不能凭 token 猜。
- **重大认知纠正（推翻本节旧推测）**：
  - **「变量」与「样式」是同一批对象**：`getLocalPaintStyles()` + `getLocalTextStyles()` + `getLocalEffectStyles()` 的 id 集合与 `variables.getVariables()` 的 id 集合**双向完全包含**（各 57 个），变量 type 分布恰为 `{PAINT:38, EFFECT:6, TEXT:13}`。样式 API 是「按 type 过滤的视图」，变量 API 是「统一视图」，**破解变量 = 破解样式**。
  - **`M:1` / `M:2` 是真实 id**，并非客户端凭空构造的 pseudo-id：真值 `getCollections()` 返回 `[{id:"M:1", name:"集合", isExternal:false, modes:[{id:"M:2", name:"模式 1"}]}]`；变量组 id 形如 `M:1_Neutrals`、`M:1_外部/Carbon Neutral`。
  - `window.mg.variables` 是**对象**（不是函数），含 `getCollections` / `getVariables` / `getModes` / `getGroupList` / `getVariableById` 等。
- **仍未解出**：`scopes`（真值中 PAINT 恒为 `fill/shapeFill/textFill/stroke`、其余为 `[]`，但二进制内未定位到该字段）、`codeSyntax`、多模式值（本文件仅 1 个模式 `M:2`，数值型的该模式值已解出为 `floatData`，PAINT/TEXT/EFFECT 的值走各自定义表）。

### 既成工具的可复用输出
- `get_page_tree` 的 `geometry` 已含 `fills/strokes/strokeWeight/strokeAlign/constraints/autoLayout/rotation/transform/x/y/width/height/cornerRadius`。
- **样式 / 变量类工具的统一模式**：`normalize(file) → getFileMeta → getLocalXxx(fileKey, fileId) → jsonOut`，在 `tools.ts` 里追加一个 `ToolDef` 即可。
- 解码逻辑集中在 `node-tree.ts`：`scanStyleIndex` 是颜色 / 文字 / 效果 / 变量**四个工具的共同底座**（按 `05 <n>` 判类型 + 按 ukey 判本文件）；`buildPaintTable`（颜色）、`scanEffectTable`（效果）、`parseTextStyleBody`（文字）各自解析值。
- 新增能力时请同步更新：`tools.ts` 的「当前已实现」注释、README 工具表与 Roadmap、`NEXT.md`。

## 注意事项

- 私有二进制格式为最小逆向，若 MasterGo 调整 `/data/{fileKey}` 结构，页面索引解析需同步更新（见 `page-index.ts` 注释）；
- Cookie 有有效期，失效后需重新登录浏览器复制（`.env` 中更新 `MG_COOKIE`）；
- 项目仅供内部使用，请遵守 MasterGo 服务条款与团队数据安全规范。