/**
 * 打包发布：用 esbuild 把运行时依赖（axios / zod / @modelcontextprotocol/sdk）全部打进
 * 单个自包含 CJS 文件 dist/index.cjs，带 shebang 可作 bin。
 *
 * 产物无需 node_modules、无需 tsx，MCP 客户端直接 `node dist/index.cjs` 即跑。
 * 用法：node scripts/build.mjs
 */
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/index.cjs",
  banner: { js: "#!/usr/bin/env node" },
  // 仅排除 node 原生模块；业务运行时依赖全部打进单文件
  external: ["node:fs", "node:path", "node:url", "node:stream", "node:util", "node:http", "node:https", "node:zlib", "node:buffer", "node:events", "node:crypto", "node:os", "node:net", "node:tls", "node:assert", "node:process"],
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

console.log("[build] 输出 dist/index.cjs");