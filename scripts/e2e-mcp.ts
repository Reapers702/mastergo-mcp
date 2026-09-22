/**
 * 端到端验证：以真实 MCP 客户端身份，通过 JSON-RPC over stdio 与打包产物
 * `dist/index.cjs` 通信，把 10 个工具的关键路径全部走一遍。
 *
 * 运行：
 *   npm run build:bundle   # 先确保 dist/index.cjs 是最新产物
 *   npm run test:e2e       # （即 npx tsx scripts/e2e-mcp.ts）
 *
 * 使用公开文件（Ant Design 5.0 官方设计稿，modern 格式，无需 Cookie）：
 * 首次会全量下载 /data（~106MB），进程内 5 分钟缓存复用，
 * get_page_tree / diff_files 不再重复下载。
 */

import { spawn } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");

/**
 * 产物新鲜度防护：e2e spawn 的是 dist/index.cjs，而 dist/ 已 gitignore。
 * 本地若忘记 build:bundle，e2e 会拿**旧代码**跑，报出令人误判为「解码坏了」的失败
 *（实测踩过：bundle 停在 09-21、源码已到 09-22，list_styles 返回 0 条）。
 * 这里在启动前比对 mtime，过期就直接提示重建，而不是让人去查逆向逻辑。
 */
function assertBundleFresh(): void {
  if (!existsSync(BUNDLE)) {
    console.error(`[e2e] ❌ 找不到 ${BUNDLE}，请先运行：npm run build:bundle`);
    process.exit(1);
  }
  const bundleTime = statSync(BUNDLE).mtimeMs;
  const srcDir = path.join(ROOT, "src");
  const stale = readdirSync(srcDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ f, t: statSync(path.join(srcDir, f)).mtimeMs }))
    .filter((s) => s.t > bundleTime);
  if (stale.length > 0) {
    console.error(
      `[e2e] ❌ dist/index.cjs 比 ${stale.length} 个源文件旧（如 ${stale
        .slice(0, 3)
        .map((s) => s.f)
        .join(", ")}）—— e2e 会拿旧产物跑出假失败。\n` +
        `      请先运行：npm run build:bundle`
    );
    process.exit(1);
  }
}

const FILE_ID = "205140012617682"; // Ant Design 5.0（公开，modern 格式，74 页）
const FILE_KEY = "010e341a-0eae-49c9-a538-87932df0307d";

const ALL_TOOLS = [
  "get_file_meta",
  "list_pages",
  "get_file_nodes",
  "get_page_tree",
  "list_styles",
  "list_text_styles",
  "list_effect_styles",
  "list_variables",
  "list_components",
  "diff_files",
];

let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) console.log(`ok   ${msg}`);
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
}

/** 简单的 JSON-RPC stdio 客户端 */
class McpStdioClient {
  private child = spawn("node", [BUNDLE], { stdio: ["pipe", "pipe", "inherit"] });
  private pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  ready: Promise<void>;

  constructor() {
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // 忽略非 JSON 输出
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg);
      }
    });
    this.ready = new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`请求超时：${method}`));
        }
      }, 150_000);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  kill(): void {
    this.child.kill();
  }
}

function callResult(msg: any): any {
  const content = msg.result?.content ?? [];
  const text = content.find((c: any) => c.type === "text")?.text ?? "";
  return JSON.parse(text);
}

async function main(): Promise<void> {
  assertBundleFresh();
  const c = new McpStdioClient();
  await c.ready;

  // 1. initialize
  const init = await c.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e-verify", version: "0.0.1" },
  });
  check(!!init.result?.capabilities?.tools, "initialize 返回 capabilities.tools");
  c.notify("notifications/initialized");

  // 2. tools/list —— 断言 10 个工具全部注册
  const list = await c.send("tools/list");
  const names = (list.result?.tools ?? []).map((t: any) => t.name).sort();
  check(
    JSON.stringify(names) === JSON.stringify([...ALL_TOOLS].sort()),
    `tools/list 共 ${names.length} 个工具且集合一致`
  );

  // 3. get_file_meta
  const meta = callResult(await c.send("tools/call", { name: "get_file_meta", arguments: { file: FILE_ID } }));
  check(meta.fileKey === FILE_KEY, `get_file_meta 返回 fileKey=${meta.fileKey}`);

  // 4. list_pages（首次触发全量下载 ~106MB，后续 get_page_tree/diff_files 复用缓存）
  const pages = callResult(await c.send("tools/call", { name: "list_pages", arguments: { file: FILE_ID } }));
  check(
    Array.isArray(pages.pages) && pages.pages.length >= 10,
    `list_pages 返回 ${pages.pages?.length} 个页面（antd5 共 74 页）`
  );
  const [p1, p2] = pages.pages as Array<{ id: string; name: string }>;

  // 5. get_page_tree（第一页）
  const tree = callResult(await c.send("tools/call", { name: "get_page_tree", arguments: { file: FILE_ID, page: p1.id } }));
  check(typeof tree.totalNodes === "number" && tree.totalNodes > 0, `get_page_tree totalNodes=${tree.totalNodes}`);
  check(Array.isArray(tree.nodes) && tree.nodes.length > 0, "get_page_tree nodes 非空");

  // 6. diff_files（第一页 vs 第二页，id 匹配）
  const diff = callResult(
    await c.send("tools/call", {
      name: "diff_files",
      arguments: { file_a: FILE_ID, page_a: p1.id, file_b: FILE_ID, page_b: p2.id },
    })
  );
  check(diff.matchBy === "id", "diff_files matchBy=id");
  check(
    [diff.totalA, diff.totalB, diff.added, diff.removed, diff.changed, diff.unchanged].every((n) => typeof n === "number"),
    `diff_files 汇总字段齐全（totalA=${diff.totalA} totalB=${diff.totalB} added=${diff.added} removed=${diff.removed} changed=${diff.changed}）`
  );
  check(Array.isArray(diff.changes), "diff_files changes 为数组");

  // 7. get_file_nodes（限量 5，验证全量索引入口）
  const nodes = callResult(await c.send("tools/call", { name: "get_file_nodes", arguments: { file: FILE_ID, limit: 5 } }));
  check(typeof nodes.totalNodes === "number" && nodes.totalNodes > 0, `get_file_nodes totalNodes=${nodes.totalNodes}`);

  // 8. list_styles（antd5 现代编码样式表：全部是团队库 ukey，2026-09 起按来源标注而非吞掉）
  const styles = callResult(await c.send("tools/call", { name: "list_styles", arguments: { file: FILE_ID } }));
  check(Array.isArray(styles.styles), `list_styles 返回 ${styles.styles?.length} 条`);
  check(styles.styles?.length > 100, `list_styles 条数 ${styles.styles?.length} 应 > 100（库引用样式不再被过滤）`);
  check(
    styles.styles?.every((s: any) => typeof s.sourceFileId === "string" && s.sourceFileId.length > 0),
    "每条样式都带 sourceFileId 来源标注"
  );
  check(styles.styles?.some((s: any) => s.name && !/^[0-9]+:[0-9A-Za-z]+$/.test(s.name)), "样式名可正常读出（非 id）");

  c.kill();
  console.log(failed === 0 ? "\nPASS: e2e 全链路验证通过" : `\nFAIL: ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e 异常:", err);
  process.exit(1);
});
