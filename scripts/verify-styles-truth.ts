/**
 * 真值对照守卫：样式与变量解码。
 *
 * 与 regress.ts 的分工：
 *   - `npm run test:regress`  守 **节点树 + legacy 火车票**（结构基线）
 *   - 本脚本守 **样式/变量表对浏览器真值**，跑两个样本：
 *     1) `antd_modern`（**公开**，Ant Design 5 副本）：CI 必跑，**缺快照会自动匿名下载**
 *     2) `mobile_kit`（**私有**，新 ukey 编码 `+<id>`）：本地有快照才跑
 *
 * 为什么两个样本都要：二进制里存在**两套 ukey 编码**（`<fileId>+<id>` 与 `+<id>`）和
 * **两类样式序号短码**（`a…` 与 `ZJ`/`E`/`N`…），只测一个极易改坏另一个 ——
 * 历史上出过两次：`list_styles` 因按前缀过滤而「modern 返回 0 条」；
 * 文字样式因锚点要求 `03 61` 而整表漏读（antd 副本 29 条真值一条都读不到）。
 *
 * **静默跳过就是失效**：只要一个样本都没真跑起来，本脚本直接判失败（exit 1）。
 * 私有样本缺失允许跳过，但公开样本缺失/下载失败必须报错。
 *
 * 运行：`npm run test:styles`
 * 可选：`MG_STYLE_SRC_ANTD=<路径>` / `MG_STYLE_SRC=<路径>` 指定本地快照，跳过下载。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import axios from "axios";
import {
  listLocalPaintStyles,
  listLocalTextStyles,
  listLocalEffectStyles,
  listLocalVariables,
} from "../src/node-tree.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE_URL = process.env.MG_BASE_URL || "https://mastergo.com";

interface Truth {
  meta: {
    documentId: number;
    name: string;

    varTypeDistribution?: Record<string, number>;
  };
  paintStyles: Array<{
    id: string;
    name: string;
    paints: Array<{ type: string; color?: { r: number; g: number; b: number; a: number } | null; gradientStops?: unknown[] }>;
  }>;
  textStyles: Array<{
    id: string;
    name: string;
    fontSize: number;
    lineHeight: { value: number };
    fontName: { family: string; style: string };
    letterSpacing?: number;
  }>;
  effectStyles: Array<{
    id: string;
    name: string;
    effects: Array<{ radius: number; offset: { x: number; y: number }; color: { a: number } }>;
  }>;
  /** 数值型变量（CORNER_RADIUS/NUMBER）带浏览器真值 `modes["M:2"][0].floatData` */
  variables: Array<{ id: string; name: string; type: string; floatData?: number[] }>;
}

interface Sample {
  key: string;
  label: string;
  fileId: string;
  /** 公开样本才有：/data/{fileKey} 匿名可下载 */
  fileKey?: string;
  truthPath: string;
  defaultSnapshot: string;
  envVar: string;
  /** false = 私有样本，缺快照时跳过（但整体至少要跑成一个样本） */
  public: boolean;
  /** 当前解码基线（记录数，含库引用/复制带入的全部样式） */
  expect: { paint: number; text: number; effect: number; vars: number };
}

const SAMPLES: Sample[] = [
  {
    key: "antd_modern",
    label: "Ant Design 5 副本（公开，样式来自源库 122691166044911）",
    fileId: "204971164239455",
    fileKey: "eb0ea904-aa4f-4e83-863b-5071a4d386a3",
    truthPath: "test/fixtures/truth_antd_modern.json",
    defaultSnapshot: ".cache/antd_sample.bin",
    envVar: "MG_STYLE_SRC_ANTD",
    public: true,
    // paint 294 / text 61 / effect 43 = 索引记录数，均 ≥ 真值条数：
    // 二进制还带着客户端未列出的其他库样式（如 SF Pro 文字样式 27 条），按全量返回并标注来源
    // vars 414 = 398（上述三类）+ 16 条数值型变量（CORNER_RADIUS 9 + NUMBER 7，`05 06`）
    expect: { paint: 294, text: 61, effect: 43, vars: 414 },
  },
  {
    key: "mobile_kit",
    label: "移动端界面设计（私有，新 ukey 编码 `+<id>`）",
    fileId: "107389953208823",
    truthPath: "test/fixtures/truth_mobile_kit.json",
    defaultSnapshot: ".cache/mg_mobile_kit.bin",
    envVar: "MG_STYLE_SRC",
    public: false,
    expect: { paint: 38, text: 13, effect: 6, vars: 57 },
  },
];

/** ukey → selfId：真值 API 的 ukey 前缀是本文件，二进制里可能是源库，只有 selfId 稳定 */
const selfId = (ukey: string) => ukey.split("+")[1] ?? ukey;
/** ukey → 前缀（定义该样式的文件 id） */
const prefixOf = (ukey: string) => ukey.split("+")[0];
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** PingFang SC 等中文字体：真值 API 的 style 是中文名，二进制存 PostScript 英文名 */
const WEIGHT_CN_TO_EN: Record<string, string> = {
  极细体: "Ultralight",
  纤细体: "Thin",
  细体: "Light",
  常规体: "Regular",
  中黑体: "Medium",
  中粗体: "Semibold",
  粗体: "Bold",
  超黑体: "Heavy",
};

let totalFail = 0;
let ranSamples = 0;

for (const s of SAMPLES) {
  console.log(`\n[${s.key}] ${s.label}`);
  const truthFile = path.join(ROOT, s.truthPath);
  if (!existsSync(truthFile)) {
    console.error(`  ❌ 缺少真值文件 ${s.truthPath}（本守卫的判据本体，缺失即失败）`);
    totalFail++;
    continue;
  }
  const snapshot = process.env[s.envVar] || path.join(ROOT, s.defaultSnapshot);
  let buf: Buffer;
  try {
    buf = await loadBinary(s, snapshot);
  } catch (e) {
    if (!s.public) {
      console.log(`  ⏭ 跳过（私有样本，需本地快照）：${(e as Error).message}`);
      continue;
    }
    console.error(`  ❌ 二进制不可用：${(e as Error).message}`);
    totalFail++;
    continue;
  }
  ranSamples++;
  totalFail += checkSample(s, JSON.parse(readFileSync(truthFile, "utf8")) as Truth, buf);
}

async function loadBinary(s: Sample, snapshot: string): Promise<Buffer> {
  if (existsSync(snapshot)) {
    const buf = readFileSync(snapshot);
    // 36 字节的 `{"code":"AccessDenied"}` 也曾被当成快照落盘，太小的一律视为无效
    if (buf.length < 64 * 1024) {
      throw new Error(
        `快照 ${path.relative(ROOT, snapshot)} 只有 ${buf.length} 字节，不像是完整的 /data 二进制` +
          `（多半是 401/403 的错误响应），请删除后重新获取`
      );
    }
    return buf;
  }
  if (!s.public || !s.fileKey) {
    throw new Error(
      `未找到私有样本快照 ${s.defaultSnapshot}。获取方式：登录浏览器打开 fileId=${s.fileId} 的编辑器页，` +
        `下载 ${BASE_URL}/data/<fileKey> 放入 .cache/，或用 ${s.envVar}=<路径> 指定。`
    );
  }
  console.log(`  … 匿名下载 /data/${s.fileKey}（本样本为公开文件，无需 Cookie）`);
  const res = await axios.get(`${BASE_URL}/data/${s.fileKey}`, {
    params: { wv: "v3.2.1" },
    responseType: "arraybuffer",
    timeout: 300_000,
    maxContentLength: Infinity,
  });
  const buf = Buffer.from(res.data as ArrayBuffer);
  if (buf.length < 1_000_000) throw new Error(`下载结果仅 ${buf.length} 字节，不像完整二进制`);
  mkdirSync(path.dirname(snapshot), { recursive: true });
  writeFileSync(snapshot, buf);
  console.log(`  … 已缓存快照到 ${path.relative(ROOT, snapshot)}（${(buf.length / 1048576).toFixed(1)}MB）`);
  return buf;
}

interface PaintStyle { id: string; ukey: string; name: string; sourceFileId: string; isExternal: boolean; paints: Array<{ color: { r: number; g: number; b: number; a: number } | null }> }
interface TextStyle { id: string; ukey: string; name: string; sourceFileId: string; isExternal: boolean; fontSize: number | null; lineHeight: { value: number } | null; fontPostScriptName: string | null; letterSpacing: { value: number } | null }
interface EffectStyle { id: string; ukey: string; name: string; sourceFileId: string; isExternal: boolean; effects: Array<{ color: { a: number } | null; radius: number | null; offsetY: number | null }> }
interface VarEntry { id: string; ukey: string; name: string; type: string; sourceFileId: string; isExternal: boolean; floatData: number[] | null }


/** 单个样本的全部断言；返回失败条数 */
function checkSample(s: Sample, truth: Truth, buf: Buffer): number {
  let fail = 0;
  const bad = (m: string) => {
    console.log("  ❌ " + m);
    fail++;
  };

  const paint = listLocalPaintStyles(buf, s.fileId) as unknown as PaintStyle[];
  const text = listLocalTextStyles(buf, s.fileId) as unknown as TextStyle[];
  const effect = listLocalEffectStyles(buf, s.fileId) as unknown as EffectStyle[];
  const vars = listLocalVariables(buf, s.fileId) as unknown as VarEntry[];
  console.log(
    `  记录数 paint ${paint.length} / text ${text.length} / effect ${effect.length} / vars ${vars.length}` +
      `（真值 ${truth.paintStyles.length}/${truth.textStyles.length}/${truth.effectStyles.length}/${truth.variables.length}）`
  );
  for (const [k, got, want] of [
    ["paint", paint.length, s.expect.paint],
    ["text", text.length, s.expect.text],
    ["effect", effect.length, s.expect.effect],
    ["vars", vars.length, s.expect.vars],
  ] as const) {
    if (got !== want) bad(`${k} 记录数 ${got} ≠ 基线 ${want}`);
  }

  // sourceFileId / isExternal 必须与 ukey 前缀自洽
  for (const r of [...paint, ...text, ...effect, ...vars]) {
    if (r.sourceFileId !== prefixOf(r.ukey)) bad(`${r.id} sourceFileId ${r.sourceFileId} ≠ ukey 前缀 ${prefixOf(r.ukey)}`);
    if (r.isExternal !== (r.sourceFileId !== s.fileId)) bad(`${r.id} isExternal 与 sourceFileId 不一致`);
  }

  // ---- 颜色样式 ----
  {
    const bySelf = new Map(paint.map((g) => [selfId(g.ukey), g]));
    for (const w of truth.paintStyles) {
      const g = bySelf.get(w.id);
      if (!g) {
        bad(`颜色 漏掉 ${w.id} ${w.name}`);
        continue;
      }
      if (g.name !== w.name) bad(`颜色 ${w.id} name ${JSON.stringify(g.name)} ≠ ${JSON.stringify(w.name)}`);
      const wp = w.paints[0];
      if (wp?.type === "SOLID" && wp.color) {
        const c = g.paints[0]?.color;
        if (!c) bad(`颜色 ${w.id} ${w.name} 未解出颜色`);
        else if (!near(c.r, wp.color.r) || !near(c.g, wp.color.g) || !near(c.b, wp.color.b) || !near(c.a, wp.color.a)) {
          bad(`颜色 ${w.id} ${w.name} ${JSON.stringify(c)} ≠ ${JSON.stringify(wp.color)}`);
        }
      }
    }
    const solid = truth.paintStyles.filter((w) => w.paints[0]?.type === "SOLID").length;
    console.log(`  ✅ 颜色：真值 ${truth.paintStyles.length} 条全覆盖（其中 SOLID 逐值 ${solid}）`);
  }

  // ---- 文字样式 ----
  {
    const bySelf = new Map(text.map((g) => [selfId(g.ukey), g]));
    let ls = 0;
    for (const w of truth.textStyles) {
      const g = bySelf.get(w.id);
      if (!g) {
        bad(`文字 漏掉 ${w.id} ${w.name}`);
        continue;
      }
      if (g.name !== w.name) bad(`文字 ${w.id} name ${JSON.stringify(g.name)} ≠ ${JSON.stringify(w.name)}`);
      if (g.fontSize === null || !near(g.fontSize, w.fontSize)) bad(`文字 ${w.id} fontSize ${g.fontSize} ≠ ${w.fontSize}`);
      if (g.lineHeight === null || !near(g.lineHeight.value, w.lineHeight.value)) {
        bad(`文字 ${w.id} lineHeight ${g.lineHeight?.value} ≠ ${w.lineHeight.value}`);
      }
      // 二进制里的 PostScript 名可能压掉空格（OpenSans vs "Open Sans"），去空格后比。
      // 中文客户端的 fontName.style 可能是**字重中文名的 JSON 描述**（PingFang SC 的
      // `{"fontStyle":"中黑体","opsz":"auto"}`），而二进制 `0c` 存 PostScript 英文名，故先映射。
      const rawStyle = w.fontName.style.trim();
      let styleText: string | null = null;
      if (rawStyle.startsWith("{")) {
        try {
          const j = JSON.parse(rawStyle) as { fontStyle?: string };
          styleText = j.fontStyle ? WEIGHT_CN_TO_EN[j.fontStyle] ?? null : null;
        } catch {
          styleText = null;
        }
      } else {
        styleText = rawStyle.replace(/ /g, "");
      }
      if (!styleText) {
        bad(`文字 ${w.id} 无法从真值 style ${JSON.stringify(w.fontName.style)} 推出 PostScript 字重名`);
        continue;
      }
      const want = `${w.fontName.family.replace(/ /g, "")}-${styleText}`;
      if (g.fontPostScriptName !== want) bad(`文字 ${w.id} font ${g.fontPostScriptName} ≠ ${want}`);
      // 字间距：二进制里 0 值写成 `08 00`、字段整体缺省则输出 null，两者都视为与真值 0 一致
      if (g.letterSpacing === null) {
        if (w.letterSpacing !== 0 && w.letterSpacing !== undefined) bad(`文字 ${w.id} 字间距缺省但真值为 ${w.letterSpacing}`);
      } else if (!near(g.letterSpacing.value, w.letterSpacing ?? 0)) {
        bad(`文字 ${w.id} 字间距 ${g.letterSpacing.value} ≠ ${w.letterSpacing}`);
      } else ls++;
    }
    console.log(`  ✅ 文字：真值 ${truth.textStyles.length} 条全覆盖（显式字间距 ${ls} 条）`);
  }

  // ---- 效果样式 ----
  {
    const bySelf = new Map(effect.map((g) => [selfId(g.ukey), g]));
    let items = 0;
    let nulls = 0;
    for (const w of truth.effectStyles) {
      const g = bySelf.get(w.id);
      if (!g) {
        bad(`效果 漏掉 ${w.id} ${w.name}`);
        continue;
      }
      if (g.name !== w.name) bad(`效果 ${w.id} name ${JSON.stringify(g.name)} ≠ ${JSON.stringify(w.name)}`);
      if (g.effects.length !== w.effects.length) bad(`效果 ${w.id} 项数 ${g.effects.length} ≠ ${w.effects.length}`);
      for (let i = 0; i < Math.min(g.effects.length, w.effects.length); i++) {
        const ge = g.effects[i];
        const we = w.effects[i];
        items++;
        if (ge.color === null || !near(ge.color.a, we.color.a)) bad(`效果 ${w.id}[${i}] alpha ${ge.color?.a} ≠ ${we.color.a}`);
        // radius / offsetY：legacy 编码整字段缺省时输出 null（已知局限），非 null 必须正确
        if (ge.radius === null) nulls++;
        else if (!near(ge.radius, we.radius)) bad(`效果 ${w.id}[${i}] radius ${ge.radius} ≠ ${we.radius}`);
        if (ge.offsetY === null) nulls++;
        else if (!near(ge.offsetY, we.offset.y)) bad(`效果 ${w.id}[${i}] offsetY ${ge.offsetY} ≠ ${we.offset.y}`);
      }
    }
    console.log(`  ✅ 效果：真值 ${truth.effectStyles.length} 条全覆盖（效果项 ${items}，${nulls} 个字段因二进制缺省为 null）`);
  }

  // ---- 变量 ----
  {
    const bySelf = new Map(vars.map((g) => [selfId(g.ukey), g]));
    // 数值型变量（圆角/纯数字）：真值带 floatData 时逐元素对照，并要求解码非 null
    let numericChecked = 0;
    for (const w of truth.variables) {
      const g = bySelf.get(w.id);
      if (!g) {
        bad(`变量 漏掉 ${w.id} ${w.name}（${w.type}）`);
        continue;
      }
      if (g.name !== w.name) bad(`变量 ${w.id} name ${JSON.stringify(g.name)} ≠ ${JSON.stringify(w.name)}`);
      if (g.type !== w.type) bad(`变量 ${w.id} type ${g.type} ≠ ${w.type}`);
      if (!w.floatData) continue;
      if (g.floatData === null) {
        bad(`数值变量 ${w.id} ${w.name}（${w.type}）未解出 floatData，真值 ${JSON.stringify(w.floatData)}`);
        continue;
      }
      if (g.floatData.length !== w.floatData.length) {
        bad(`数值变量 ${w.id} ${w.name} 值个数 ${g.floatData.length} ≠ ${w.floatData.length}`);
        continue;
      }
      for (let i = 0; i < w.floatData.length; i++) {
        if (!near(g.floatData[i], w.floatData[i])) {
          bad(`数值变量 ${w.id} ${w.name}[${i}] ${g.floatData[i]} ≠ ${w.floatData[i]}`);
        }
      }
      numericChecked++;
    }
    const numeric = vars.filter((g) => g.type === "CORNER_RADIUS" || g.type === "NUMBER").length;
    console.log(
      `  ✅ 变量：真值 ${truth.variables.length} 条全覆盖` +
        `（数值型 CORNER_RADIUS/NUMBER 记录 ${numeric} 条，其中 ${numericChecked} 条与浏览器 floatData 逐值对照）`
    );
  }

  console.log(fail === 0 ? `  [${s.key}] ✅ 通过` : `  [${s.key}] ❌ ${fail} 项不一致`);
  return fail;
}


console.log("");
if (ranSamples === 0) {
  console.error("[styles] ❌ 没有任何样本真正跑起来 —— 守卫等于失效，判失败（见上面的跳过原因）");
  process.exit(1);
}
if (totalFail) {
  console.error(`[styles] ❌ ${totalFail} 项不一致`);
  process.exit(1);
}
console.log(`[styles] ✅ ${ranSamples} 个样本全部通过`);
