/**
 * 回归测试：节点树类型解码正确性守卫。
 *
 * 目标：火车票文件（公开，legacy 格式）的节点类型解码不退化。
 * 基线：随仓库入库的真值 train_ticket_truth.json（829 条，字段名 type），
 *       parsePageTree 逐 PAGE 根扫描全部节点，断言命中率达标、0 错判。
 *
 * 注意（/data 特性）：
 *   - 火车票文件 isPublic:true，**匿名即可下载**，CI 也能跑（无需 Cookie）。
 *   - /data 响应**不可字节复现**且**忽略 Range**，因此回归必须按「结构/类型」比对，
 *     不能 md5 / 整文件 diff。
 *
 * 运行：
 *   npm run test:regress
 *
 * 可选：本地已有快照时通过环境变量 MG_REGRESS_SRC 指向它，避免重复下载 47MB：
 *   MG_REGRESS_SRC="C:\\Users\\Reaper\\AppData\\Local\\Temp\\Trae\\tools\\mg_src.bin" npm run test:regress
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import axios from "axios";
import { parsePageTree } from "../src/node-tree.ts";

// ---- 文件常量（火车票，公开）----
const FILE_KEY = "890c5c78-a533-4751-91ef-06e3fbb70d5e";
const BASE_URL = "https://mastergo.com";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 命中率阈值：低于此值失败（当前基线 828/828 = 100%，加个小裕量防未来退化影响置信） */
const HIT_RATIO_THRESHOLD = 0.99;
/** 允许的错判数硬上限：当前 0，任何新增错判都应被当成回归失败 */
const MAX_MISS = 0;

interface TruthNode {
  id: string;
  // ad_truth.json 用 t，mng_alltruth.json 用 type，统一兼容
  type?: string;
  t?: string;
  [k: string]: unknown;
}

/** 加载真值：返回 { id -> type }，以及全部 PAGE 根 id */
function loadTruth(): { pageRoots: string[]; typeOf: Map<string, string> } {
  const fp = path.join(__dirname, "..", "test", "fixtures", "train_ticket_truth.json");
  const raw = JSON.parse(readFileSync(fp, "utf8")) as { nodes: TruthNode[] };
  const pageRoots = new Set<string>();
  const typeOf = new Map<string, string>();
  for (const n of raw.nodes) {
    const t = n.type ?? n.t;
    if (!t) continue;
    typeOf.set(n.id, t);
    if (t === "PAGE") pageRoots.add(n.id);
  }
  return { pageRoots: [...pageRoots], typeOf };
}

/** 获取 /data 二进制：优先本地快照（MG_REGRESS_SRC），否则实时下载 */
async function fetchDataBinary(): Promise<Buffer> {
  const snapshot = process.env.MG_REGRESS_SRC;
  if (snapshot) {
    if (!existsSync(snapshot)) throw new Error(`MG_REGRESS_SRC 指向的文件不存在：${snapshot}`);
    return readFileSync(snapshot);
  }
  console.log(`[regress] 实时下载 /data/${FILE_KEY}（~47MB，首次较慢）...`);
  const res = await axios.get(`${BASE_URL}/data/${FILE_KEY}`, {
    params: { wv: "v3.2.1" },
    responseType: "arraybuffer",
    timeout: 120_000,
  });
  const buf = Buffer.from(res.data as ArrayBuffer);
  // 可选：缓存一份到本机，便于下次用 MG_REGRESS_SRC 复用
  const cache = process.env.MG_REGRESS_CACHE;
  if (cache) {
    writeFileSync(cache, buf);
    console.log(`[regress] 已缓存二进制到 ${cache}`);
  }
  return buf;
}

/** 断言类型命中返回 { hit, miss, missingTruth, checked }，不直接断言，交给 main */
function evaluate(buf: Buffer) {
  const { pageRoots, typeOf } = loadTruth();
  let checked = 0;
  let hit = 0;
  let miss = 0;
  let missingTruth = 0;
  const missExamples: string[] = [];

  for (const pageId of pageRoots) {
    const tree = parsePageTree(buf, pageId);
    for (const node of tree.nodes) {
      if (node.id === pageId) continue; // 页面根自身不做类型判别
      const want = typeOf.get(node.id);
      if (want === undefined) { missingTruth++; continue; }
      checked++;
      if (node.type === want) hit++;
      else {
        miss++;
        if (missExamples.length < 15) missExamples.push(`${node.id} want=${want} got=${node.type}`);
      }
    }
  }
  return { checked, hit, miss, missingTruth, missExamples };
}

async function main() {
  const buf = await fetchDataBinary();
  const r = evaluate(buf);
  const ratio = r.checked ? r.hit / r.checked : 1;

  console.log(`[regress] 节点类型解码回归`);
  console.log(`  checked   = ${r.checked}`);
  console.log(`  hit       = ${r.hit}`);
  console.log(`  miss      = ${r.miss}`);
  console.log(`  missingTruth(闲置) = ${r.missingTruth}`);
  console.log(`  命中率    = ${(ratio * 100).toFixed(2)}%  (阈值 ${HIT_RATIO_THRESHOLD * 100}%)`);
  if (r.miss && r.missExamples.length) {
    console.log("  错判示例：");
    for (const ex of r.missExamples) console.log("    " + ex);
  }

  const ok = r.miss <= MAX_MISS && ratio >= HIT_RATIO_THRESHOLD;
  console.log(ok ? "  ✅ PASS" : "  ❌ FAIL");
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error("[regress] 运行失败：", err);
  process.exit(1);
});