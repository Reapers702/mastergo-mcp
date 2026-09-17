# mastergo-mcp

基于 MasterGo **网页接口**自研的内部 MCP Server（Node.js + TypeScript），用于在 AI 客户端（Cursor / Trae / Claude Desktop 等）中读取 MasterGo 设计稿数据。

> 官方 MasterGo MCP 服务需要付费（研发席位 / Magic MCP）。本项目通过网页 API + 私有二进制逆向，**无需额外席位**即可读取文件元信息和页面列表；读取完整画布 DSL 时仍依赖个人访问令牌（与官方能力一致，权限受账号席位约束）。

## 特性

- **双认证**：个人访问令牌（`X-MG-UserAccessToken`）或浏览器 Cookie（`gfsessionid=...`）
- **无需付费席位**：Cookie 即可访问网页 API，并逆向解析 `/data/{fileKey}` 私有二进制提取全部页面列表
- **5 分钟 LRU 缓存 + in-flight 去重**：相同请求并发复用，避免重复网络开销
- **URL 智能解析**：直接粘贴设计稿 URL（含 `?page_id=` / `?layer_id=`）即可使用

## 快速开始

```bash
npm install
npm run build
```

### 认证方式（二选一）

| 方式 | 环境变量 | 可访问能力 |
| --- | --- | --- |
| 个人访问令牌 | `MG_MCP_TOKEN=mg_xxx` | 全部能力（含 `/mcp/*` 网关 DSL，需账号开通对应席位） |
| 浏览器 Cookie | `MG_COOKIE="gfsessionid=xxx; ..."` | 文件元信息 + 页面列表（无需席位） |

Cookie 获取：登录 mastergo.com 后，打开浏览器开发者工具 → Network → 任意请求的 Request Headers 中复制 `Cookie` 整段值。

### 启动

```bash
# 方式一：环境变量
MG_MCP_TOKEN=mg_xxx npx tsx src/index.ts

# 方式二：命令行参数
npx tsx src/index.ts --token mg_xxx --cookie "gfsessionid=..." --url https://mastergo.com
```

### 配置到 AI 客户端

以 Cursor / Claude Desktop 等支持 MCP 的客户端为例，在 MCP 配置中新增：

```json
{
  "mcpServers": {
    "mastergo": {
      "command": "npx",
      "args": ["tsx", "/绝对路径/mastergo-mcp/src/index.ts"],
      "env": {
        "MG_MCP_TOKEN": "mg_xxx",
        "MG_COOKIE": "gfsessionid=xxx; ..."
      }
    }
  }
}
```

## 已实现工具

| 工具 | 说明 | 认证 |
| --- | --- | --- |
| `get_file_meta` | 文件元信息：名称、团队、项目、fileKey、权限、负责人 | 令牌或 Cookie |
| `list_pages` | 文件内全部页面列表（页面 ID + 页面名）。有令牌走 `/mcp/*` 网关；否则 Cookie 逆向解析二进制索引 | 令牌或 Cookie |
| `get_design_sections` | **主读取工具**：分区列表 → 按 `sectionIndex` 逐个取分区完整 DSL（图层/样式/文本） | 需令牌 |
| `get_page_layers` | 枚举页面下全部图层摘要（id/name/type/depth/childrenCount/宽高） | 需令牌 |
| `get_node_dsl` | 回退工具：单个节点完整 DSL | 需令牌 |

### 推荐工作流

1. `get_file_meta` 获取文件基本信息；
2. `list_pages` 拿到页面列表，确定目标页面（如 `10371:87078`）；
3. `get_design_sections` 传入含 `?page_id=` 的 URL，先取分区列表，再逐个 `sectionIndex` 拉取完整 DSL；
4. 必要时用 `get_page_layers` 枚举图层 / `get_node_dsl` 回退读取单节点。

## 权限说明（重要）

- 文件元信息、页面列表：**Cookie 即可，无需付费**（已实测验证：`GET /api/v1/documents/{fileId}` 与 `/data/{fileKey}` 均可用 Cookie 访问）；
- `/mcp/*` 网关（DSL、分区、图层枚举）：**必须携带个人访问令牌**。令牌是否具备读取权限取决于账号席位：实测返回 `permissions["local-mcp-read"] = false` 时（未开通研发席位），即便有令牌 `/mcp/*` 也会返回权限不足。生成令牌：MasterGo → 个人设置 → 安全设置 → 个人访问令牌。

## 项目结构

```
src/
  index.ts        # MCP Server 入口（Stdio 传输）
  config.ts       # 配置加载（命令行参数 + 环境变量）
  mastergo.ts     # HTTP 客户端：网页 API + /mcp/* 网关 + 缓存
  page-index.ts   # 私有二进制页面索引解析（双 marker 逆向）
  tools.ts        # 5 个 MCP 工具定义与参数
```

## 待实现能力（Roadmap）

- [ ] **图层/节点深度读取优化**：二进制 DSL 的完整节点树解码（当前仅提取页面索引）
- [ ] **组件与样式资源**：读取文件级组件库、颜色/文字/效果样式
- [ ] **变量（Variables）**：Design Tokens 的读取与引用关系
- [ ] **图片/切图导出**：节点导出为 PNG/SVG/PDF，可交付到本地目录
- [ ] **设计稿差异对比**：两份文件/版本间节点 diff
- [ ] **Token 自动刷新**：Cookie 过期检测与登录引导提示
- [ ] **打包发布**：`npm pack` / 单文件二进制（esbuild），免 npx tsx 依赖

## 注意事项

- 私有二进制格式为最小逆向，若 MasterGo 调整 `/data/{fileKey}` 结构，页面索引解析需同步更新（见 `page-index.ts` 注释）；
- Cookie 有有效期，失效后需重新登录浏览器复制；
- 项目仅供内部使用，请遵守 MasterGo 服务条款与团队数据安全规范。
