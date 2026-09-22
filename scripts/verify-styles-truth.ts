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
import { parsePageBlocks } from "../src/page-index.ts";
import {
  listLocalPaintStyles,
  listLocalTextStyles,
  listLocalEffectStyles,
  listLocalVariables,
  listTokenStyles,
} from "../src/node-tree.ts";

/** 真值里的族键（浏览器 getLocalXxxStyles 去掉前缀）→ 本实现的 type 名。 */
const FAM_TO_API_TYPE: Record<string, string> = {
  spacing: "SPACING",
  padding: "PADDING",
  cornerRadius: "CORNER_RADIUS",
  strokeWidth: "STROKE_WIDTH",
  grid: "GRID",
};

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
  /**
   * 记录数下限（含库引用/复制带入的全部样式）。
   * ⚠️ **不要改回精确相等**：多出来的记录是二进制里带的其他库样式，随源库增减而变，
   * 与解码正确性无关 —— 2026-09-22 实测远端源库变化，paint 294→291、vars 414→411，
   * 真值仍 290/290 全覆盖却判红。解码是否退化由「真值逐条覆盖」断言负责，
   * 这里只保证「没漏读」的下限。
   */
  minRecords: { paint: number; text: number; effect: number; vars: number };
  /** 可选的「样式族」真值（getLocalSpacingStyles / getLocalPaddingStyles / … 的导出） */
  tokenTruthPath?: string;
  /**
   * 只跑样式族视图，跳过 paint/text/effect/vars 的逐条核对。
   * 用于「为补某个样式族而专门现造」的小样本 —— 这类文件里根本没有其他样式，
   * 且体积只有 KB 级（见 loadBinary 的小文件阈值）。
   */
  tokenOnly?: boolean;
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
    // 下限取「真值条数」：解码至少要把真值全部读出来；上限不设，多的允许（其他库样式）。
    minRecords: { paint: 290, text: 29, effect: 34, vars: 365 },
    tokenTruthPath: "test/fixtures/truth_numeric_families.json",
  },
  {
    key: "mobile_kit",
    label: "移动端界面设计（私有，新 ukey 编码 `+<id>`）",
    fileId: "107389953208823",
    truthPath: "test/fixtures/truth_mobile_kit.json",
    defaultSnapshot: ".cache/mg_mobile_kit.bin",
    envVar: "MG_STYLE_SRC",
    public: false,
    minRecords: { paint: 38, text: 13, effect: 6, vars: 57 },
  },
  {
    key: "grid_stroke",
    label: "自建 GRID / STROKE_WIDTH 样本（公开，2026-09-22 用编辑器 UI 现造）",
    fileId: "205234583944753",
    fileKey: "bb3da168-0864-4eac-a22c-76f65f8e5772",
    truthPath: "test/fixtures/truth_grid_stroke.json",
    defaultSnapshot: ".cache/grid_sw.bin",
    envVar: "MG_STYLE_SRC_GRID",
    public: true,
    tokenOnly: true,
    minRecords: { paint: 0, text: 0, effect: 0, vars: 0 },
    tokenTruthPath: "test/fixtures/truth_grid_stroke.json",
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
  // 先断言「页面索引解出来了」：2026-09-22 的 P0（头部签名版本字节变化）会让解码整体
  // 静默退化成 0 条，此时后面那些「真值全覆盖」断言会变成对空集的平凡通过 —— 必须前置拦截。
  if (parsePageBlocks(buf).length === 0) {
    console.error("  ❌ 页面索引解析为 0 页（疑似 /data 头部签名漂移，见 README 注意事项）");
    totalFail++;
    continue;
  }
  if (s.tokenOnly) {
    console.log("  ⏭ 本样本只校验样式族（tokenOnly），跳过 paint/text/effect/vars");
  } else {
    totalFail += checkSample(s, JSON.parse(readFileSync(truthFile, "utf8")) as Truth, buf);
  }
  // 样式族视图（SPACING/PADDING/CORNER_RADIUS/STROKE_WIDTH/GRID）另有一份真值，可选
  if (s.tokenTruthPath) {
    const tf = path.join(ROOT, s.tokenTruthPath);
    if (!existsSync(tf)) {
      console.error(`  ❌ 缺少样式族真值 ${s.tokenTruthPath}`);
      totalFail++;
    } else {
      totalFail += checkTokenStyles(s, JSON.parse(readFileSync(tf, "utf8")), buf);
    }
  }
}

/** 布局网格对象（GRID 族的值载体，浏览器 `layoutGrids[]`）。 */
interface TruthLayoutGrid {
  gridType: string;
  color?: { r: number; g: number; b: number; a: number };
  sectionSize?: number;
  isVisible?: boolean;
  count?: number;
  gutterSize?: number;
  offset?: number;
  alignment?: string;
}

/** 样式族真值（浏览器 getLocalSpacingStyles / getLocalPaddingStyles / … 导出）。 */
interface TokenTruth {
  counts: Record<string, number>;
  families: Record<
    string,
    Array<{
      id: string;
      name: string;
      type: string;
      ukey: string;
      isExternal: boolean;
      /** 数值族（SPACING/PADDING/CORNER_RADIUS/STROKE_WIDTH）：如 `{spacing:[8]}`、`{width:[1,1,1,1]}` */
      value?: Record<string, number[]>;
      /** GRID 族专有 */
      layoutGrids?: TruthLayoutGrid[];
    }>
  >;
}

/**
 * 校验样式族视图：逐族比对**每条 id/name/值**，并要求解码条数 ≥ 真值条数。
 *
 * ⚠️ **不能按 isExternal 过滤来取「本文件」**：从团队库复制/另存出的文件（如 antd5 副本）
 * 二进制整批保留源库 ukey，这些记录全是 isExternal=true，而客户端把它们算作本文件样式。
 * 故这里直接用真值 id（selfId）配对，条数只设下限（多出来的是其他库样式，允许）。
 */
function checkTokenStyles(s: Sample, truth: TokenTruth, buf: Buffer): number {
  let fail = 0;
  const bad = (m: string) => { console.log("  ❌ " + m); fail++; };
  const all = listTokenStyles(buf, s.fileId) as unknown as Array<{
    id: string; name: string; type: string; ukey: string; sourceFileId: string; isExternal: boolean;
    values: number[] | null; layoutGrids?: TruthLayoutGrid[];
  }>;
  const gotCounts: Record<string, number> = {};
  for (const r of all) gotCounts[r.type] = (gotCounts[r.type] ?? 0) + 1;
  const bySelf = new Map(all.map((r) => [selfId(r.ukey), r]));
  let checked = 0;
  const famParts: string[] = [];
  for (const fam of Object.keys(truth.counts)) {
    const want = truth.counts[fam];
    const apiType = FAM_TO_API_TYPE[fam];
    if (!apiType) { bad(`样式族真值出现未知族 ${fam}`); continue; }
    const got = gotCounts[apiType] ?? 0;
    if (got < want) bad(`${apiType} 条数 ${got} < 真值 ${want}（疑似漏读）`);
    famParts.push(`${apiType} ${got}/${want}`);
    for (const w of truth.families[fam] ?? []) {
      const g = bySelf.get(w.id);
      if (!g) { bad(`${apiType} 漏掉 ${w.id} ${w.name}`); continue; }
      if (g.name !== w.name) bad(`${apiType} ${w.id} name ${JSON.stringify(g.name)} ≠ ${JSON.stringify(w.name)}`);
      if (g.type !== apiType) { bad(`${apiType} ${w.id} 类型 ${g.type} ≠ ${apiType}`); continue; }

      // STROKE_WIDTH：值子块 `02 <count> [紧凑浮点×count]`，比对四边宽度数组
      if (g.type === "STROKE_WIDTH") {
        const wantW = w.value?.width;
        const gotW = g.values;
        if (!wantW || !gotW || gotW.length !== wantW.length || !wantW.every((v, i) => near(v, gotW[i]))) {
          bad(`${apiType} ${w.id} ${w.name} 值 ${JSON.stringify(gotW)} ≠ 真值 ${JSON.stringify(wantW)}`);
        } else checked++;
        continue;
      }

      // GRID：值不在样式记录里，走 layoutGrids（字段默认值省略，故只比对真值出现的字段）
      if (g.type === "GRID") {
        const wantG = w.layoutGrids ?? [];
        const gotG = g.layoutGrids ?? [];
        if (gotG.length !== wantG.length) {
          bad(`${apiType} ${w.id} ${w.name} layoutGrids 条数 ${gotG.length} ≠ 真值 ${wantG.length}`);
          continue;
        }
        let gFail = 0;
        wantG.forEach((wg, i) => {
          const gg = gotG[i] as unknown as Record<string, unknown>;
          for (const f of ["gridType", "sectionSize", "isVisible", "count", "gutterSize", "offset", "alignment"]) {
            const expect = (wg as unknown as Record<string, unknown>)[f];
            if (expect === undefined) continue;
            if (gg[f] !== expect) {
              bad(`${apiType} ${w.id} ${w.name} layoutGrids[${i}].${f} ${JSON.stringify(gg[f])} ≠ ${JSON.stringify(expect)}`);
              gFail++;
            }
          }
          if (wg.color) {
            const gc = (gg.color ?? {}) as Record<string, number>;
            for (const c of ["r", "g", "b", "a"]) {
              if (!near(gc[c] ?? NaN, wg.color![c as "r"])) {
                bad(`${apiType} ${w.id} ${w.name} layoutGrids[${i}].color.${c} ${gc[c]} ≠ ${wg.color![c as "r"]}`);
                gFail++;
              }
            }
          }
        });
        if (gFail === 0) checked++;
        continue;
      }

      const key = Object.keys(w.value ?? {})[0];
      const want2 = (w.value ?? {})[key];
      const got2 = g.values;
      if (!want2 || !got2 || got2.length !== want2.length || !want2.every((v, i) => near(v, got2[i]))) {
        bad(`${apiType} ${w.id} ${w.name} 值 ${JSON.stringify(got2)} ≠ 真值 ${JSON.stringify(want2)}`);
      } else checked++;
    }
  }
  console.log(`  ${fail === 0 ? "✅" : "❌"} 样式族（记录数/真值）：${famParts.join("、")}；逐条核对 ${checked} 条`);
  return fail;
}

async function loadBinary(s: Sample, snapshot: string): Promise<Buffer> {
  if (existsSync(snapshot)) {
    const buf = readFileSync(snapshot);
    // 36 字节的 `{"code":"AccessDenied"}` 也曾被当成快照落盘，太小的一律视为无效。
    // tokenOnly 样本（现造的小文件）本身就只有 KB 级，故阈值单独放宽 —— 但仍要挡住
    // AccessDenied 那种错误响应，靠「头部签名 + 页面索引能解出」在调用方把关。
    const minBytes = s.tokenOnly ? 512 : 64 * 1024;
    if (buf.length < minBytes) {
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
  const minDownloaded = s.tokenOnly ? 512 : 1_000_000;
  if (buf.length < minDownloaded) throw new Error(`下载结果仅 ${buf.length} 字节，不像完整二进制`);
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
  for (const [k, got, min] of [
    ["paint", paint.length, s.minRecords.paint],
    ["text", text.length, s.minRecords.text],
    ["effect", effect.length, s.minRecords.effect],
    ["vars", vars.length, s.minRecords.vars],
  ] as const) {
    if (got < min) bad(`${k} 记录数 ${got} < 下限 ${min}（疑似漏读或解码退化）`);
  }

  // sourceFileId / isExternal 必须与 ukey 前缀自洽
  for (const r of [...paint, ...text, ...effect, ...vars]) {
    if (r.sourceFileId !== prefixOf(r.ukey)) bad(`${r.id} sourceFileId ${r.sourceFileId} ≠ ukey 前缀 ${prefixOf(r.ukey)}`);
    if (r.isExternal !== (r.sourceFileId !== s.fileId)) bad(`${r.id} isExternal 与 sourceFileId 不一致`);
  }

  // ---- 颜色样式 ----
  {
    const bySelf = new Map(paint.map((g) => [selfId(g.ukey), g]));
    const failBefore = fail;
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
    const icon = fail === failBefore ? "✅" : "❌";
    console.log(`  ${icon} 颜色：真值 ${truth.paintStyles.length} 条全覆盖（其中 SOLID 逐值 ${solid}）`);
  }

  // ---- 文字样式 ----
  {
    const bySelf = new Map(text.map((g) => [selfId(g.ukey), g]));
    const failBefore = fail;
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
    console.log(`  ${fail === failBefore ? "✅" : "❌"} 文字：真值 ${truth.textStyles.length} 条全覆盖（显式字间距 ${ls} 条）`);
  }

  // ---- 效果样式 ----
  {
    const bySelf = new Map(effect.map((g) => [selfId(g.ukey), g]));
    const failBefore = fail;
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
    console.log(`  ${fail === failBefore ? "✅" : "❌"} 效果：真值 ${truth.effectStyles.length} 条全覆盖（效果项 ${items}，${nulls} 个字段因二进制缺省为 null）`);
  }

  // ---- 变量 ----
  {
    const bySelf = new Map(vars.map((g) => [selfId(g.ukey), g]));
    const failBefore = fail;
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
      `  ${fail === failBefore ? "✅" : "❌"} 变量：真值 ${truth.variables.length} 条全覆盖` +
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
