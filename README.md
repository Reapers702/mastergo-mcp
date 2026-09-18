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
- [ ] **几何与布局属性**：节点位置（x/y）、尺寸、圆角、填充/描边、透明度、布局约束等
- [ ] **组件与样式资源**：读取文件级组件库、颜色/文字/效果样式
- [ ] **变量（Variables）**：Design Tokens 的读取与引用关系
- [ ] **图片/切图导出**：节点导出为 PNG/SVG/PDF，可交付到本地目录
- [ ] **设计稿差异对比**：两份文件/版本间节点 diff
- [ ] **Cookie 过期检测**：失效检测与登录引导提示
- [ ] **打包发布**：`npm pack` / 单文件二进制（esbuild），免 npx tsx 依赖

## 注意事项

- 私有二进制格式为最小逆向，若 MasterGo 调整 `/data/{fileKey}` 结构，页面索引解析需同步更新（见 `page-index.ts` 注释）；
- Cookie 有有效期，失效后需重新登录浏览器复制（`.env` 中更新 `MG_COOKIE`）；
- 项目仅供内部使用，请遵守 MasterGo 服务条款与团队数据安全规范。