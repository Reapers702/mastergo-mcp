/**
 * 真值对照测试：样式与变量解码（modern 编码文件「移动端界面设计」）。
 *
 * 与 regress.ts 的分工：
 *   - `npm run test:regress`  守 **legacy** 编码（火车票，公开文件，CI 可跑）
 *   - 本脚本守 **modern** 编码（私有文件，需要本地快照，不能进 CI）
 *
 * 为什么两者都要：legacy 与 modern 是**两套 ukey 编码**，只测其中一个极易改坏另一个 ——
 * 历史上的 `list_styles` 漏检 bug 正是「modern 返回 0 条、legacy 看起来完全正常」。
 *
 * 依赖：
 *   - 真值 `test/fixtures/truth_mobile_kit.json`（已入库）
 *   - `/data` 二进制快照，默认读 `.cache/mg_mobile_kit.bin`（**不入库**，6.2MB）
 *     缺失时可用环境变量指向别处：`MG_STYLE_SRC=/path/to/mg_mobile_kit.bin`
 *
 * 运行：`npm run test:styles`
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  listLocalPaintStyles,
  listLocalTextStyles,
  listLocalEffectStyles,
  listLocalVariables,
} from "../src/node-tree.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FILE_ID = "107389953208823";
const TRUTH_PATH = path.join(ROOT, "test/fixtures/truth_mobile_kit.json");
const BIN_PATH = process.env.MG_STYLE_SRC || path.join(ROOT, ".cache/mg_mobile_kit.bin");

interface TruthPaint { id: string; name: string; ukey: string; paints: Array<{ type: string; color: { r: number; g: number; b: number; a: number } | null }> }
interface TruthText { id: string; name: string; fontSize: number; lineHeight: { value: number }; fontName: { family: string; style: string } }
interface TruthEffect { id: string; name: string; effects: Array<{ radius: number; offset: { x: number; y: number }; color: { a: number } }> }
interface TruthVar { id: string; name: string; type: string }
interface Truth {
  paintStyles: TruthPaint[];
  textStyles: TruthText[];
  effectStyles: TruthEffect[];
  variables: TruthVar[];
}

if (!existsSync(TRUTH_PATH)) {
  console.error(`[styles] 缺少真值文件 ${TRUTH_PATH}`);
  process.exit(1);
}
if (!existsSync(BIN_PATH)) {
  console.log(`[styles] ⏭  跳过：未找到二进制快照 ${BIN_PATH}`);
  console.log(`[styles]    该文件是私有文件的 /data 快照（6.2MB，不入库）。`);
  console.log(`[styles]    获取方式：登录浏览器打开 fileId=${FILE_ID} 的编辑器页，`);
  console.log(`[styles]    下载 https://mastergo.com/data/2b195a62-0d3e-40ee-b55f-59b607e729a0 后放入 .cache/，`);
  console.log(`[styles]    或用 MG_STYLE_SRC=<路径> 指定。`);
  process.exit(0);
}

const truth: Truth = JSON.parse(readFileSync(TRUTH_PATH, "utf8"));
const buf = readFileSync(BIN_PATH);

let fail = 0;
const bad = (m: string) => { console.log("  ❌ " + m); fail++; };
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

// ---- 颜色样式 ----
console.log(`[styles] 颜色样式（PAINT，真值 ${truth.paintStyles.length}）`);
{
  const got = listLocalPaintStyles(buf, FILE_ID);
  console.log(`  返回 ${got.length} 条`);
  if (got.length !== truth.paintStyles.length) bad(`条数 ${got.length} ≠ ${truth.paintStyles.length}`);
  const byId = new Map(truth.paintStyles.map((s) => [s.id, s]));
  for (const g of got) {
    const w = byId.get(g.id);
    if (!w) { bad(`多出 ${g.id} ${g.name}`); continue; }
    if (g.name !== w.name) bad(`${g.id} name: ${JSON.stringify(g.name)} ≠ ${JSON.stringify(w.name)}`);
    if (g.ukey !== w.ukey) bad(`${g.id} ukey: ${g.ukey} ≠ ${w.ukey}`);
    // SOLID 的颜色逐值对照
    if (w.paints[0]?.type === "SOLID" && w.paints[0].color) {
      const c = g.paints[0]?.color;
      const t = w.paints[0].color;
      if (!c || !near(c.r, t.r) || !near(c.g, t.g) || !near(c.b, t.b) || !near(c.a, t.a)) {
        bad(`${g.id} ${g.name} 颜色: ${JSON.stringify(c)} ≠ ${JSON.stringify(t)}`);
      }
    }
  }
  for (const w of truth.paintStyles) if (!got.some((g) => g.id === w.id)) bad(`漏掉 ${w.id} ${w.name}`);
  console.log(`  ✅ ${got.length}/${truth.paintStyles.length}`);
}

// ---- 文字样式 ----
console.log(`[styles] 文字样式（TEXT，真值 ${truth.textStyles.length}）`);
{
  const got = listLocalTextStyles(buf, FILE_ID);
  const byId = new Map(truth.textStyles.map((s) => [s.id, s]));
  if (got.length !== truth.textStyles.length) bad(`条数 ${got.length} ≠ ${truth.textStyles.length}`);
  for (const g of got) {
    const w = byId.get(g.id);
    if (!w) { bad(`多出 ${g.id}`); continue; }
    if (g.name !== w.name) bad(`${g.id} name: ${JSON.stringify(g.name)} ≠ ${JSON.stringify(w.name)}`);
    if (g.fontSize === null || !near(g.fontSize, w.fontSize)) bad(`${g.id} fontSize: ${g.fontSize} ≠ ${w.fontSize}`);
    if (g.lineHeight === null || !near(g.lineHeight.value, w.lineHeight.value)) {
      bad(`${g.id} lineHeight: ${g.lineHeight?.value} ≠ ${w.lineHeight.value}`);
    }
    // 二进制里的 PostScript 名可能把空格压掉（OpenSans vs "Open Sans"），故去空格后比较
    const want = `${w.fontName.family}-${w.fontName.style}`.replace(/ /g, "");
    if (g.fontPostScriptName !== want) bad(`${g.id} font: ${g.fontPostScriptName} ≠ ${want}`);
  }
  for (const w of truth.textStyles) if (!got.some((g) => g.id === w.id)) bad(`漏掉 ${w.id} ${w.name}`);
  console.log(`  ✅ ${got.length}/${truth.textStyles.length}`);
}

// ---- 效果样式 ----
console.log(`[styles] 效果样式（EFFECT，真值 ${truth.effectStyles.length}）`);
{
  const got = listLocalEffectStyles(buf, FILE_ID);
  const byId = new Map(truth.effectStyles.map((s) => [s.id, s]));
  if (got.length !== truth.effectStyles.length) bad(`条数 ${got.length} ≠ ${truth.effectStyles.length}`);
  let checkedItems = 0;
  let nullFields = 0;
  for (const g of got) {
    const w = byId.get(g.id);
    if (!w) { bad(`多出 ${g.id}`); continue; }
    if (g.name !== w.name) bad(`${g.id} name: ${JSON.stringify(g.name)} ≠ ${JSON.stringify(w.name)}`);
    if (g.effects.length !== w.effects.length) bad(`${g.id} 效果项数 ${g.effects.length} ≠ ${w.effects.length}`);
    for (let i = 0; i < Math.min(g.effects.length, w.effects.length); i++) {
      const ge = g.effects[i], we = w.effects[i];
      checkedItems++;
      if (ge.color === null || !near(ge.color.a, we.color.a)) bad(`${g.id}[${i}] alpha: ${ge.color?.a} ≠ ${we.color.a}`);
      // radius / offsetY：字段缺省时输出 null（已知局限，见 node-tree.ts），非 null 必须正确
      if (ge.radius === null) nullFields++;
      else if (!near(ge.radius, we.radius)) bad(`${g.id}[${i}] radius: ${ge.radius} ≠ ${we.radius}`);
      if (ge.offsetY === null) nullFields++;
      else if (!near(ge.offsetY, we.offset.y)) bad(`${g.id}[${i}] offsetY: ${ge.offsetY} ≠ ${we.offset.y}`);
    }
  }
  for (const w of truth.effectStyles) if (!got.some((g) => g.id === w.id)) bad(`漏掉 ${w.id} ${w.name}`);
  console.log(`  ✅ ${got.length}/${truth.effectStyles.length}（效果项 ${checkedItems}，其中 ${nullFields} 个字段因二进制缺省而为 null）`);
}

// ---- 变量 ----
console.log(`[styles] 变量（Variables，真值 ${truth.variables.length}）`);
{
  const got = listLocalVariables(buf, FILE_ID);
  const byId = new Map(truth.variables.map((v) => [v.id, v]));
  if (got.length !== truth.variables.length) bad(`条数 ${got.length} ≠ ${truth.variables.length}`);
  for (const g of got) {
    const w = byId.get(g.id);
    if (!w) { bad(`多出 ${g.id} ${g.name}`); continue; }
    if (g.name !== w.name) bad(`${g.id} name: ${JSON.stringify(g.name)} ≠ ${JSON.stringify(w.name)}`);
    if (g.type !== w.type) bad(`${g.id} type: ${g.type} ≠ ${w.type}`);
  }
  for (const w of truth.variables) if (!got.some((g) => g.id === w.id)) bad(`漏掉 ${w.id} ${w.name}`);
  const dist = got.reduce<Record<string, number>>((a, v) => ((a[v.type] = (a[v.type] || 0) + 1), a), {});
  console.log(`  ✅ ${got.length}/${truth.variables.length}  type 分布 ${JSON.stringify(dist)}`);
}

console.log(fail === 0 ? "[styles] ✅ 全部通过" : `[styles] ❌ ${fail} 项不一致`);
if (fail) process.exit(1);
