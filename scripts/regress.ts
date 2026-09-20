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
import { parsePageTree, listLocalPaintStyles, listLocalTextStyles } from "../src/node-tree.ts";

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

  const stylesOk = checkStyles(buf);
  const gradOk = checkNodeGradFills(buf);
  if (!ok || !stylesOk || !gradOk) process.exit(1);
}

/**
 * 样式解码守卫：火车票（legacy 编码）文件本地的颜色样式。
 *
 * 基线（README 既有记录）：4 个本地 paint 样式；该文件 0 个文字样式、0 个效果样式。
 *
 * 这条守卫的意义：legacy 与 modern 是**两套 ukey 编码**，只测其中一个极易改坏另一个 ——
 * 历史上的 `list_styles` 漏检 bug 正是「在新编码上返回 0 条、在旧编码上看起来完全正常」。
 */
const EXPECTED_STYLES: Array<{ id: string; name: string; kind: string }> = [
  { id: "5377:50013", name: "渐变", kind: "GRADIENT" },
  { id: "5481:060489", name: "f1f4fb", kind: "SOLID" },
  { id: "5481:060533", name: "1", kind: "SOLID" },
  { id: "5481:060542", name: "2", kind: "SOLID" },
];

function checkStyles(buf: Buffer): boolean {
  const fileId = "115278536821990";
  const styles = listLocalPaintStyles(buf, fileId);
  const texts = listLocalTextStyles(buf, fileId);

  console.log(`[regress] 样式解码回归（legacy 编码）`);
  console.log(`  paint 样式 = ${styles.length}（基线 ${EXPECTED_STYLES.length}）`);
  console.log(`  文字样式   = ${texts.length}（基线 0）`);

  let ok = styles.length === EXPECTED_STYLES.length && texts.length === 0;
  for (const want of EXPECTED_STYLES) {
    const got = styles.find((s) => s.id === want.id);
    if (!got) {
      console.log(`  ❌ 缺少样式 ${want.id} ${want.name}`);
      ok = false;
      continue;
    }
    if (got.name !== want.name) {
      console.log(`  ❌ ${want.id} name: got=${JSON.stringify(got.name)} want=${JSON.stringify(want.name)}`);
      ok = false;
    }
    if (got.paints[0]?.kind !== want.kind) {
      console.log(`  ❌ ${want.id} kind: got=${got.paints[0]?.kind} want=${want.kind}`);
      ok = false;
    }
    // legacy 编码的 ukey 必须带 fileId 前缀，且被判定为本文件（未被误当外部引用）
    if (!got.ukey.startsWith(fileId + "+")) {
      console.log(`  ❌ ${want.id} ukey 前缀异常: ${got.ukey}`);
      ok = false;
    }
  }
  console.log(ok ? "  ✅ PASS" : "  ❌ FAIL");
  return ok;
}

/**
 * 节点级渐变 fill 守卫（2026-09）。
 *
 * 背景：节点记录里 `15 <refId>`（图元 fill）若 refId 命中渐变 paint 表，应直接复用渐变解码，
 * 输出 type/gradientStops/gradientHandlePositions，而不是退回 paintMap 得到 UNKNOWN/null。
 *
 * 基线（火车票公开文件「定稿5：首页火车票卡片」页面 1984:13313）：20 个渐变 fill 节点；
 * 抽查 3914:24830（RECTANGLE）的 fill 为 GRADIENT_LINEAR 双 stop、含手柄。
 */
function checkNodeGradFills(buf: Buffer): boolean {
  const pageId = "1984:13313";
  const tree = parsePageTree(buf, pageId);
  let gradNodes = 0;
  let unknownFills = 0;
  let ok = true;

  for (const n of tree.nodes) {
    const fills = n.geometry?.fills ?? [];
    for (const p of fills) {
      if (p.kind === "GRADIENT") gradNodes++;
      else if (p.kind === "UNKNOWN") unknownFills++;
    }
  }

  console.log(`[regress] 节点渐变 fill 解码回归`);
  console.log(`  gradient fill 项 = ${gradNodes}（基线 ≥ 20）`);
  console.log(`  UNKNOWN fill 项  = ${unknownFills}`);

  if (gradNodes < 20) {
    console.log(`  ❌ gradient fill 项过少（${gradNodes}）`);
    ok = false;
  }

  const probe = tree.nodes.find((n) => n.id === "3914:24830");
  const gp = probe?.geometry?.fills?.find((p) => p.kind === "GRADIENT");
  if (!gp || gp.type !== "GRADIENT_LINEAR" || !gp.gradientStops || gp.gradientStops.length < 2 || !gp.gradientHandlePositions) {
    console.log(`  ❌ 抽查节点 3914:24830 渐变 fill 结构异常: ${JSON.stringify(gp?.type)}`);
    ok = false;
  }

  console.log(ok ? "  ✅ PASS" : "  ❌ FAIL");
  return ok;
}

main().catch((err) => {
  console.error("[regress] 运行失败：", err);
  process.exit(1);
});