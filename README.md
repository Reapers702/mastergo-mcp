# mastergo-mcp

基于 MasterGo **网页接口（Web API）** 完全自研的内部 MCP Server（Node.js + TypeScript），用于在 AI 客户端（Cursor / Trae / Claude Desktop 等）中读取 MasterGo 设计稿数据。

> **设计原则**：本项目**完全自行实现**，通过 MasterGo 网页接口（`/api/v1/...`、`/data/...`）逆向实现 MCP 能力，**不使用、不依赖官方 MCP 网关（`/mcp/*`）**——官方 Magic MCP 需要付费席位（研发席位 / Magic MCP）。本项目仅需一个浏览器登录态的 Cookie 即可访问，**无需额外付费**。

## 特性

- **单 Cookie 认证**：浏览器 Cookie（`gfsessionid=...`）即可访问文件元信息与页面列表，无需个人访问令牌、无需付费席位
- **私有二进制逆向**：解析 `/data/{fileKey}` 的 MasterGo 私有二进制格式，提取文件内全部页面列表（双 marker 逆向）
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

### 推荐工作流

1. `get_file_meta` 获取文件基本信息，拿到 `fileKey`；
2. `list_pages` 拿到页面列表，确定目标页面（如 `10371:87078`）。

> 更多读取能力见下方 Roadmap，正在通过网页二进制自研逐步加入。

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
  tools.ts        # MCP 工具定义与参数
```

## 待实现能力（Roadmap · 均基于网页接口自研）

- [ ] **图层/节点深度读取**：二进制 DSL 的完整节点树解码（当前仅提取页面索引）
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