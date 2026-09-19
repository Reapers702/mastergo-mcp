/**
 * MasterGo 私有二进制 DSL（/data/{fileKey}）的节点树（父子层级）解析。
 *
 * 结论（2026-09 火车票文件，829 节点真值 100% 校验）：
 *   1. 每个真实节点的记录形如：
 *        01 <realId> \0 02 <parentId> \0 03 <typeCode> \0 04 <name> \0 <几何字段...>
 *      - 01：节点 id（可能带实例子路径，如 "10371:89225/1:20691"）
 *      - 02：父节点 id（本树的权威父子依据，实测 829/829 与浏览器真值一致）
 *      - 03：一个 2~4 字节的"类型码"（形如 "a0"/"a1"/"a[>"…，经验证**并非**节点类型单射，
 *        不做正规则判别的确定性依据，这里仅原样暴露）
 *      - 04：节点名称（实测 ~98% 与真值一致；INSTANCE 等可能缺省 04，名称来自组件）
 *   2. 页面根记录形如  09 01 00 01 <pageId> \0 02 <页面名> \0 ...
 *      （页面记录没有 02=parent，其 02 字段放的是页面名）
 *   3. 部分节点 02 为空（引用/占位形态），其真实父需回退到记录尾的 1b 锚点；
 *      页面最顶层节点（如 FRAME "new"）也无 02，父即页面 id。
 *
 * 局限：本文件只交付"父子层级 + 名称 + id + 锚点"这份可靠的树结构。
 * 节点**类型**的可靠解码仍需进一步逆向 0d..1a 几何字段语法，此处不擅自定论。
 * 已攻克类型：几何段内 first 1c 子块的原生字节即节点类型判别依据
 *   （实测 808 节点 100% 准确，见 decodeNodeType）。
 *
 * 已攻克 x/y 坐标符号位（2026-09，178x/177y 对照浏览器 API 真值 100%）：
 *   坐标为 18 块内 sub01/sub02 跟随的**带符号**紧凑浮点（decFloatSigned）。
 *   符号位即 24 位小端尾数最低字节 bit0：1→负，0→正。
 */

/**
 * 节点几何/布局属性。
 *
 * 已知可靠解码（实测与浏览器 API 真值一致）：
 *   - width / height：节点包围盒尺寸（字段 0e / 0f，紧凑浮点）
 *   - opacity：透明度 0..1（字段 0a，仅当 != 1 时存在）
 *   - cornerRadius：圆角（仅 RECTANGLE；几何段首个 1c 类型块内子块「01 04 + 4×浮点」，
 *     4 角一致则输出数值，否则输出 [r1,r2,r3,r4]）
 *   - strokeWeight：描边宽度（字段 10，位于 13 引用块之前；`10 00`=0 隐藏描边、
 *     4 字节紧凑浮点为权重、无该字段默认 1。实测 63/63 与浏览器真值一致）
 *   - strokeAlign：描边对齐（字段 13：`01`=CENTER、`02`=INSIDE、`03`=OUTSIDE，
 *     缺省 CENTER。实测 770/770 与浏览器真值一致）
 *   - constraints：布局约束（字段 0b=vertical、0c=horizontal：`01`=END、`03`=CENTER、
 *     `04`=SCALE，缺省 START。实测垂直 546/548、水平 546/548 与浏览器真值一致）
 *
 *   - 自动布局 autoLayout（2026-09 破解）：字段位于几何段内的 `1c 07` 类型块
 *     （FRAME/INSTANCE/GROUP/BOOLEAN_OPERATION）中，键号与几何段外层复用但作用域独立：
 *       `08 <v>`                              flexMode：00=NONE、01=HORIZONTAL、02=VERTICAL
 *       `09 <紧凑浮点 | 00>`                  itemSpacing（`09 00`=0）
 *       `0a 01<pt> 02<pr> 03<pb> 04<pl> 00`   padding（每边为 0 时以单字节 00 存）
 *       `0d <ma> 0e <ca>`                     主轴/交叉轴对齐：
 *                                             0=FLEX_START、1=FLEX_END、2=CENTER、3=SPACING_BETWEEN
 *       `1e 00 [1f <0|1>] [20 <紧凑浮点|00>] 21 <ms> [22 <xs>]`
 *                                             main/crossAxisSizingMode：0=FIXED、1=AUTO
 *     实测（Ant Design 5.0，33061 个含布局块节点）：flexMode 33024 命中 / 仅 37 错；
 *     sizingMode 主轴 ≈99.3%、交叉轴 ≈96.7% 命中。
 *
 * 已知局限：
 *   - autoLayout 的 itemSpacing/padding 约 2% 偏差，集中在绑定了设计令牌的实例节点
 *     （几何段内 `2a` 令牌 blob 在别处覆盖了二进制内联值）。
 *   - 实例内部节点（id 含 `/`）的 `1c 07` 块省略上述布局字段，autoLayout 为 null（继承母版）。
 *   - sizingMode 的残差（主轴约 0.7%、交叉轴约 3%）集中在含 `25 02` 标记的节点：该标记疑似
 *     「尺寸由父级/母版覆盖（如 layoutGrow/STRETCH）」，此时内联 21/22 与生效真值不一致。
 *   - constraints 在实例内部节点上取默认值，与浏览器继承自母版的真值存在少量偏差。
 *
 * 坐标符号已破解（2026-09，178/178 x 与 177/177 y 对照浏览器 API 真值一致）：
 *   18 块内 x/y 使用**带符号**紧凑浮点（decFloatSigned），符号位是 24 位小端尾数
 *   最低尾数字节 bit0：置 1 表示负、清 0 表示正。利用整数浮点尾数精度余量存储符号，
 *   解码时先清除该位还原纯幅度再决定正负。
 *
 * rotation / transform 已破解（2026-09，8 个 rotation 节点对照浏览器 relativeTransform 真值 100%）：
 *   18 块不只是 x/y：它容纳完整仿射变换。子 01=tx(x)、02=ty(y)，
 *   子 03..06 按 (m00, m11, m01, m10) 顺序打包 2×2 矩阵 m = [[s3,s5],[s6,s4]]。
 *   rotation = atan2(m10, m00)（单位度）。无旋转时子 03..06 省略（单位阵）。
 */
export interface NodeTransform {
  /** 平移 tx（即 x 坐标） */
  tx: number;
  /** 平移 ty（即 y 坐标） */
  ty: number;
  /** 2×2 线性部分 m00 */
  m00: number;
  /** m01 */
  m01: number;
  /** m10 */
  m10: number;
  /** m11 */
  m11: number;
}

/** RGBA 颜色（0..1） */
export interface NodeColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * 单条填充 / 描边。
 *
 * 填料颜色存储于独立的「paint 定义」表中（见 buildPaintTable），节点记录内仅存一个
 * 引用 id（refId）。这里把表里解析出的 RGBA 关联回来。
 * kind 说明颜色可靠程度：SOLID 为 R/G/B/A 四通道紧凑浮点（已验证）；IMAGE/GRADIENT/
 * UNKNOWN 表示该 paint 表里没有内联纯色，color 为 null。
 */
export interface NodePaint {
  /** 节点记录内实际引用的 paint 引用 id（refId） */
  refId: string;
  kind: "SOLID" | "IMAGE" | "GRADIENT" | "UNKNOWN";
  /** 解析出的 RGBA；非 SOLID 可能为 null */
  color: NodeColor | null;
}

/**
 * 自动布局（Auto Layout）属性，2026-09 破解，实测与浏览器真值高度一致。
 *
 * 字段位于几何段内的 `1c 07` 类型块（FRAME/INSTANCE/GROUP/BOOLEAN_OPERATION）中，
 * 键号与几何段外层复用但作用域独立：
 *   - `08 <v>`                            flexMode：00=NONE、01=HORIZONTAL、02=VERTICAL
 *   - `09 <紧凑浮点 | 00>`                itemSpacing（主轴间距；`09 00`=0）
 *   - `0a 01<pt> 02<pr> 03<pb> 04<pl> 00` padding（四边内边距；每边为 0 以单字节 00 存）
 *   - `0d <ma> 0e <ca>`                   main/crossAxisAlignItems：
 *                                         0=FLEX_START、1=FLEX_END、2=CENTER、3=SPACING_BETWEEN
 *   - `1e 00 [1f <0|1>] [20 <紧凑浮点|00>] 21 <ms> [22 <xs>]`
 *                                         main/crossAxisSizingMode：0=FIXED、1=AUTO
 *                                         （21 为主轴恒存在；22 为交叉轴，缺省时按 AUTO 处理）
 *
 * 实例内部节点（id 含 `/`）的 `1c 07` 块省略上述字段（继承母版），此时 autoLayout 为 null。
 */
export interface NodeAutoLayout {
  /** 布局方向（08）：NONE / HORIZONTAL / VERTICAL */
  flexMode: "NONE" | "HORIZONTAL" | "VERTICAL";
  /** 主轴间距（09；`09 00` 表示 0） */
  itemSpacing: number | null;
  /** 上内边距（0a 子 01） */
  paddingTop: number | null;
  /** 右内边距（0a 子 02） */
  paddingRight: number | null;
  /** 下内边距（0a 子 03） */
  paddingBottom: number | null;
  /** 左内边距（0a 子 04） */
  paddingLeft: number | null;
  /** 主轴对齐（0d）：FLEX_START / FLEX_END / CENTER / SPACING_BETWEEN */
  mainAxisAlignItems: string | null;
  /** 交叉轴对齐（0e），枚举同主轴 */
  crossAxisAlignItems: string | null;
  /** 主轴尺寸模式（21）：AUTO / FIXED（0=FIXED、1=AUTO）；无 21 时为 null */
  mainAxisSizingMode: "AUTO" | "FIXED" | null;
  /** 交叉轴尺寸模式（22），枚举同主轴；22 缺省时按 AUTO 处理（实测缺省节点约 95% 真值为 AUTO） */
  crossAxisSizingMode: "AUTO" | "FIXED" | null;
}

export interface NodeGeometry {
  /** 节点包围盒宽度（无符号紧凑浮点解码，可靠） */
  width: number | null;
  /** 节点包围盒高度（可靠） */
  height: number | null;
  /** 透明度 0..1（可靠；只有 !=1 时才存在） */
  opacity: number | null;
  /** 圆角（仅 RECTANGLE；4 角一致为数值，否则 4 元数组） */
  cornerRadius: number | number[] | null;
  /** x 坐标（带符号，可靠） */
  x: number;
  /** y 坐标（带符号，可靠） */
  y: number;
  /** 坐标符号是否已解析（当前恒为 true，符号位已破解） */
  positionSignResolved: boolean;
  /** rotation（度，由 18 块变换矩阵 atan2 推导；无旋转为 0） */
  rotation: number;
  /** 完整仿射变换（含平移与 2×2 线性部分；无旋转时线性部分为单位阵） */
  transform: NodeTransform;
  /** 填充列表（颜色经 paint 表解析，见 NodePaint） */
  fills: NodePaint[];
  /** 描边列表 */
  strokes: NodePaint[];
  /** 描边宽度（紧凑浮点；未解码时为 null） */
  strokeWeight: number | null;
  /** 描边对齐（字段 13：01=CENTER、02=INSIDE、03=OUTSIDE；缺省 CENTER） */
  strokeAlign: "CENTER" | "INSIDE" | "OUTSIDE" | null;
  /** 布局约束（字段 0b=vertical、0c=horizontal：01=END、03=CENTER、04=SCALE；缺省 START） */
  constraints: { horizontal: string; vertical: string } | null;
  /** 自动布局属性（FRAME/INSTANCE/GROUP 等；无布局块时为 null） */
  autoLayout: NodeAutoLayout | null;
}

export interface TreeNode {
  id: string;
  name: string;
  parent: string | null;
  /** 03 字段原始类型码（见文件头说明，不保证为类型判别） */
  typeRaw: string | null;
  /** 记录尾 1b 锚点（通常是页面 id） */
  anchor: string | null;
  /** 解码后的节点类型（见文件头说明）；未知为 null */
  type: string | null;
  /** 几何/布局属性（含可靠字段与坐标幅度） */
  geometry: NodeGeometry;
}

export interface PageTree {
  pageId: string;
  root: TreeNode;
  nodes: TreeNode[];
  /** id -> 直接子节点，按字节出现顺序 */
  children: Record<string, TreeNode[]>;
}

/** 匹配节点 id：形如 10371:87078 或 10371:89225/1:20691 */
const ID_RE = /^\d+:\d+(?:\/\d+:\d+)*$/;

/** 从 p 起读取一个以 \0 结尾的 UTF-8 字符串 */
function readCstr(buf: Buffer, p: number): { s: string; next: number } | null {
  if (p < 0 || p >= buf.length) return null;
  let e = p;
  while (e < buf.length && buf[e] !== 0) e++;
  return { s: buf.subarray(p, e).toString("utf8"), next: e + 1 };
}

/** 解析单个 `01 <id>\0` 节点记录：读 02/03/04 字段，返回 {id,parent,name,typeRaw,pos,geomPos} */
interface RawRec {
  id: string;
  parent: string | null;
  name: string;
  typeRaw: string | null;
  pos: number;
  geomPos: number;
  anchor: string | null;
}

function parseRawRecord(buf: Buffer, pos: number): RawRec {
  const p0 = pos + 1;
  const c = readCstr(buf, p0);
  const id = c ? c.s : "";
  let p = c ? c.next : p0;
  let parent: string | null = null;
  let name = "";
  let typeRaw: string | null = null;

  // 读 02/03/04 字段（最多 8 个）
  for (let k = 0; k < 8; k++) {
    if (p >= buf.length) break;
    const key = buf[p];
    if (key === 0x02 || key === 0x03 || key === 0x04) {
      const v = readCstr(buf, p + 1);
      if (!v) break;
      if (key === 0x02) {
        if (v.s === "") parent = null; // 空 02：占位，父走 1b
        else if (ID_RE.test(v.s)) parent = v.s;
        else name = v.s; // 页面记录：02 放的是页面名
      } else if (key === 0x03) typeRaw = v.s;
      else if (key === 0x04) name = v.s;
      p = v.next;
    } else break;
  }
  const geomPos = p;

  // 空父时回退：向后找最近 1b 锚点
  let anchor: string | null = null;
  if (parent === null || !anchor) {
    const end = Math.min(buf.length, p + 400);
    for (let s = p; s < end; s++) {
      if (buf[s] === 0x1b && s + 1 < buf.length) {
        const a = readCstr(buf, s + 1);
        if (a && ID_RE.test(a.s)) { anchor = a.s; break; }
      }
    }
  }
  return { id, parent, name, typeRaw, pos, geomPos, anchor };
}

/**
 * 解码节点类型：在几何段 [geomPos, end) 内找第一个合法的 1c 子块，
 * 其原生字节即类型判别依据。实测 808 节点 100% 准确。
 * 页面根（PAGE）走 09 页面级记录，不在此判别，返回 null。
 */
const TYPE_1C: Record<number, string> = {
  0x08: "TEXT",
  0x04: "ELLIPSE",
  0x03: "RECTANGLE",
  0x0a: "SLICE",
  0x02: "LINE",
  0x01: "PEN",
};

function decodeNodeType(buf: Buffer, geomPos: number, end: number): string | null {
  for (let p = geomPos; p + 1 < end; p++) {
    if (buf[p] !== 0x1c) continue;
    const b = buf[p + 1];
    const leaf = TYPE_1C[b];
    if (leaf) return leaf;
    if (b === 0x07) {
      const c = buf[p + 2];
      if (c === 0x06) return "INSTANCE";
      if (c === 0x03 || c === 0x09 || c === 0x0a) return "FRAME";
      if (c === 0x01 && buf[p + 3] === 0x00) {
        const e = buf[p + 4];
        if (e === 0x09 || e === 0x0a) return "GROUP";
        if (e === 0x02) return "BOOLEAN_OPERATION";
      }
    }
  }
  return null;
}

/**
 * 解码 MasterGo 紧凑浮点：4 字节 = 1 字节 tag（有偏指数）+ 3 字节小端尾数。
 *   value = (2^24 + intLE) * 2^(tag - 151)
 *
 * 无符号版本：intLE 直接取 24 位，可表达幅度，但**不含符号**。
 * 适用于 width/height/opacity/cornerRadius 等仅取正值的字段（参见 decFloat）。
 */
function decFloat(buf: Buffer, p: number): number {
  const tag = buf[p];
  const intLE = buf[p + 3] * 65536 + buf[p + 2] * 256 + buf[p + 1];
  return (0x1000000 + intLE) * Math.pow(2, tag - 151);
}

/**
 * 解码 MasterGo 紧凑浮点的**带符号**变体：用于 18 块内的坐标 x/y。
 * 符号位 = 最低尾数字节（m1，即 p+1）的 bit0：
 *   - bit0 == 1 → 负（解码前先清除该位，还原纯幅度）
 *   - bit0 == 0 → 正
 * 利用整数浮点尾数的精度余量存符号 bit。实测 178/178 x、177/177 y 与浏览器 API 真值一致。
 */
function decFloatSigned(buf: Buffer, p: number): number {
  const tag = buf[p];
  let intLE = buf[p + 3] * 65536 + buf[p + 2] * 256 + buf[p + 1];
  const neg = (intLE & 1) === 1;
  if (neg) intLE &= ~1; // 清除符号位，取回纯幅度尾数
  const v = (0x1000000 + intLE) * Math.pow(2, tag - 151);
  return neg ? -v : v;
}

/** tag 合理范围护栏：太大/太小都视为非紧凑浮点字段 */
function plausibleTag(tag: number): boolean {
  return tag >= 0x60 && tag <= 0xa0;
}

/** 单个 paint 的颜色信息（表项） */
interface PaintEntry {
  color: NodeColor;
  kind: "SOLID" | "IMAGE" | "GRADIENT" | "UNKNOWN";
}

/**
 * 全量构建「paint 定义表」（2019 火车票文件实测 987 条）。
 *
 * 每个 fill/stroke 的填料颜色不在节点记录内联，而是存放在独立的 paint 定义记录里：
 *       01 <selfId> \0 02 <refId> \0 03 61 30 \0 00 08 <A> <R> <G> <B> [09 <A'>]
 *   - 01/02 是两个等价 id（selfId 与 refId）；节点记录里用 refId 引用。
 *   - `08` 后依次是 4 个紧凑浮点：先一个恒为 1 的 alpha 基值，再 R、G、B。
 *     若 paint 带整体不透明度（fill 的 alpha），则在 `09` 子块后追加第 5 个浮点。
 *   - 最终颜色 = {r: R, g: G, b: B, a: A'}（A' 缺省为 1）。
 *
 * 实测：882 个 SOLID 节点的 RGBA 与浏览器 API 真值完全一致（仅个别半透明边界浮点误差）。
 * 非 SOLID（IMAGE/GRADIENT）paint 无内联纯色，kind 记为对应类型、color 为 null。
 *
 * @returns Map，键同时含 selfId 与 refId。
 */
function buildPaintTable(buf: Buffer): Map<string, PaintEntry> {
  const table = new Map<string, PaintEntry>();
  // 扫描 `03 61 30 00` 锚点，兼容两种 paint 表条目格式：
  //   1. 紧凑：`03 61 30 00 08 <4×紧凑浮点>`                 （i+4 = 08）
  //   2. 扩展：`03 61 30 00 04 00 05 00 06 01 07 00 08 <...>` （i+4 = 04 00，08 在 i+11）
  // 扩展格式原漏扫（实测 5481:060533 等 SOLID paint 表条目用扩展格式，导致样式 selfId
  // 在 paintMap 中查不到，listLocalPaintStyles 误判为 GRADIENT）。
  for (let i = 0; i + 4 < buf.length; i++) {
    if (!(buf[i] === 0x03 && buf[i + 1] === 0x61 && buf[i + 2] === 0x30 && buf[i + 3] === 0x00)) continue;
    // 定位 08 字段：紧凑直接 i+4；扩展在 [i+6, i+24) 范围内查找
    let off08 = -1;
    if (buf[i + 4] === 0x08) {
      off08 = i + 4;
    } else if (buf[i + 4] === 0x04 && buf[i + 5] === 0x00) {
      for (let k = i + 6; k < i + 24 && k + 4 < buf.length; k++) {
        if (buf[k] === 0x08) { off08 = k; break; }
      }
    }
    if (off08 < 0) continue;
    // 回溯到 paint 头 `01 <selfId>\0 02 <refId>\0`，要求 refId 结尾正好指着 anchor（03）
    let selfId: string | null = null;
    let refId: string | null = null;
    for (let j = i - 1; j >= Math.max(0, i - 100); j--) {
      if (buf[j] !== 0x01) continue;
      const ca = readCstr(buf, j + 1);
      if (!ca || !ID_RE.test(ca.s)) continue;
      if (buf[ca.next] !== 0x02) continue;
      const cb = readCstr(buf, ca.next + 1);
      if (!cb || !ID_RE.test(cb.s) || cb.next !== i) continue;
      selfId = ca.s;
      refId = cb.s;
      break;
    }
    if (!selfId || !refId) continue;
    // 解 08 后的 RGBA
    let p = off08 + 1;
    const f = (): number => {
      const tag = buf[p];
      const v = (0x1000000 + buf[p + 3] * 65536 + buf[p + 2] * 256 + buf[p + 1]) * Math.pow(2, tag - 151);
      p += 4;
      return v;
    };
    f(); // 跳过 alpha 基值（恒约 1）
    const col: NodeColor = { r: f(), g: f(), b: f(), a: 1 };
    if (buf[p] === 0x09) {
      const tag = buf[p + 1];
      col.a = (0x1000000 + buf[p + 4] * 65536 + buf[p + 3] * 256 + buf[p + 2]) * Math.pow(2, tag - 151);
    }
    const entry: PaintEntry = { color: col, kind: "SOLID" };
    table.set(selfId, entry);
    if (refId !== selfId) table.set(refId, entry);
  }
  return table;
}

/**
 * 在几何段窗口内，定位 `<key> <紧凑浮点>` 字段（值落在 [lo, hi] 内才采信）。
 * 逐字节扫不可靠（几何段还有未知 key），改用"key + 合法 tag + 值域"三重护栏。
 */
function findFloatField(
  buf: Buffer,
  from: number,
  end: number,
  key: number,
  lo: number,
  hi: number
): number | null {
  const stop = Math.min(end, from + 256);
  for (let i = from; i + 5 <= stop; i++) {
    if (buf[i] !== key || !plausibleTag(buf[i + 1])) continue;
    const v = decFloat(buf, i + 1);
    if (v >= lo && v <= hi) return v;
  }
  return null;
}

/** 主轴/交叉轴对齐枚举（0d/0e 字段） */
const AXIS_ALIGN: Record<number, string> = {
  0: "FLEX_START",
  1: "FLEX_END",
  2: "CENTER",
  3: "SPACING_BETWEEN",
};

/**
 * 解析自动布局属性（编码细节见 NodeAutoLayout 注释）。
 * 仅当几何段内存在 `1c 07` 类型块且块内含 `08 <v 0..2> 09 ...` 时返回对象；
 * 否则返回 null（RECTANGLE/TEXT 等无自动布局，或实例内部节点继承母版）。
 */
function parseAutoLayout(buf: Buffer, geomPos: number, end: number): NodeAutoLayout | null {
  const stop = Math.min(end, geomPos + 512);
  let b1 = -1;
  for (let i = geomPos; i + 1 < stop; i++) {
    if (buf[i] === 0x1c && buf[i + 1] === 0x07) {
      b1 = i;
      break;
    }
  }
  if (b1 < 0) return null;
  const bs = b1 + 2;
  const be = Math.min(end, bs + 200);

  // flexMode(08) + itemSpacing(09)：`08 <v 0..2> 09 <紧凑浮点 | 00>`
  let fmv: number | null = null;
  let isv: number | null = null;
  let padStart = -1;
  for (let i = bs; i + 3 < be; i++) {
    if (buf[i] !== 0x08) continue;
    if (buf[i + 1] > 0x02) continue;
    if (buf[i + 2] !== 0x09) continue;
    fmv = buf[i + 1];
    const q = i + 3;
    if (buf[q] === 0x00) {
      isv = 0;
      padStart = q + 1;
    } else if (plausibleTag(buf[q])) {
      isv = decFloat(buf, q);
      padStart = q + 4;
    }
    break;
  }
  if (fmv === null) return null;
  const flexMode = fmv === 1 ? "HORIZONTAL" : fmv === 2 ? "VERTICAL" : "NONE";

  // padding(0a)：`0a 01<pt> 02<pr> 03<pb> 04<pl> 00`，每边为 0 时以单字节 00 存
  let pad: number[] | null = null;
  let padEnd = -1;
  if (padStart >= 0) {
    for (let i = padStart; i + 6 < be; i++) {
      if (buf[i] !== 0x0a) continue;
      let q = i + 1;
      const vals: number[] = [];
      let good = true;
      for (let k = 1; k <= 4; k++) {
        if (buf[q] !== k) {
          good = false;
          break;
        }
        q++;
        if (buf[q] === 0x00) {
          vals.push(0);
          q += 1;
        } else if (plausibleTag(buf[q])) {
          vals.push(decFloat(buf, q));
          q += 4;
        } else {
          good = false;
          break;
        }
      }
      if (good && buf[q] === 0x00) {
        pad = vals;
        padEnd = q + 1;
        break;
      }
    }
  }

  // alignItems(0d/0e)：`0d <ma> 0e <ca>`（枚举 0..3）
  let ma: string | null = null;
  let ca: string | null = null;
  if (padEnd > 0) {
    for (let i = padEnd; i + 3 < be; i++) {
      if (buf[i] === 0x0d && buf[i + 1] <= 0x03 && buf[i + 2] === 0x0e && buf[i + 3] <= 0x03) {
        ma = AXIS_ALIGN[buf[i + 1]] ?? null;
        ca = AXIS_ALIGN[buf[i + 3]] ?? null;
        break;
      }
    }
  }

  // sizingMode(21/22)：锚点 `1e 00 [1f <0|1>] [20 <紧凑浮点|00>] 21 <ms> [22 <xs>]`
  // 21=主轴 sizingMode、22=交叉轴 sizingMode（0=FIXED、1=AUTO）。
  // 21 恒存在；22 常缺省，缺省时按 AUTO 处理（实测缺省节点约 95% 真值为 AUTO）。
  // 实测准确率：主轴 ≈99.3%，交叉轴 ≈96.7%（残差集中在含 `25 02` 继承/覆盖标记的节点）。
  let ms: "AUTO" | "FIXED" | null = null;
  let xs: "AUTO" | "FIXED" | null = null;
  for (let i = bs; i + 4 < be; i++) {
    if (buf[i] !== 0x1e || buf[i + 1] !== 0x00) continue;
    let q = i + 2;
    if (buf[q] === 0x1f && buf[q + 1] <= 1) q += 2;
    if (buf[q] === 0x20) {
      if (buf[q + 1] === 0x00) q += 2;
      else if (plausibleTag(buf[q + 1])) q += 5;
      else continue;
    }
    if (buf[q] !== 0x21) continue;
    const cMs = buf[q + 1] === 1 ? "AUTO" : buf[q + 1] === 0 ? "FIXED" : null;
    if (cMs === null) continue;
    q += 2;
    let cXs: "AUTO" | "FIXED" = "AUTO";
    if (buf[q] === 0x22 && (buf[q + 1] === 1 || buf[q + 1] === 0)) {
      cXs = buf[q + 1] === 1 ? "AUTO" : "FIXED";
      q += 2;
    }
    ms = cMs;
    xs = cXs;
    break;
  }

  return {
    flexMode,
    itemSpacing: isv,
    paddingTop: pad ? pad[0] : null,
    paddingRight: pad ? pad[1] : null,
    paddingBottom: pad ? pad[2] : null,
    paddingLeft: pad ? pad[3] : null,
    mainAxisAlignItems: ma,
    crossAxisAlignItems: ca,
    mainAxisSizingMode: ms,
    crossAxisSizingMode: xs,
  };
}

/**
 * 解析节点几何/布局属性（见 NodeGeometry 注释的属性语义与局限）。
 * @param type 节点的已解码类型（用于 RECTANGLE 的圆角定位）
 * @param paintMap 全量 paint 定义表（用于解析 fill/stroke 颜色；为 null 时不解析）
 */
function parseNodeGeometry(
  buf: Buffer,
  geomPos: number,
  end: number,
  type: string | null,
  paintMap?: Map<string, PaintEntry>
): NodeGeometry {
  const g: NodeGeometry = {
    width: null,
    height: null,
    opacity: null,
    cornerRadius: null,
    x: 0,
    y: 0,
    positionSignResolved: true,
    rotation: 0,
    transform: { tx: 0, ty: 0, m00: 1, m01: 0, m10: 0, m11: 1 },
    fills: [],
    strokes: [],
    strokeWeight: null,
    strokeAlign: null,
    constraints: null,
    autoLayout: null,
  };

  // width(0e) / height(0f)：尺寸在 [0.001, 50000] 之间
  g.width = findFloatField(buf, geomPos, end, 0x0e, 0.001, 50000);
  g.height = findFloatField(buf, geomPos, end, 0x0f, 0.001, 50000);
  // opacity(0a)：仅当 !=1 时存在，值域 [0, 1]
  g.opacity = findFloatField(buf, geomPos, end, 0x0a, 0, 1);

  // strokeWeight（描边宽度，2026-09 破解，63/63 与浏览器真值一致）：
  //   位于几何段内、13 引用块（`13 01/02/03`）之前，key=0x10：
  //     `10 00`                → 0（隐藏描边，无可见边框）
  //     `10 <4字节紧凑浮点>`   → 权重值
  //     无 10 字段             → 默认 1
  {
    let swStop = Math.min(end, geomPos + 256);
    for (let i = geomPos; i + 1 < swStop; i++) {
      if (buf[i] === 0x13 && (buf[i + 1] === 0x01 || buf[i + 1] === 0x02 || buf[i + 1] === 0x03)) {
        swStop = i;
        break;
      }
    }
    for (let i = geomPos; i + 2 <= swStop; i++) {
      if (buf[i] !== 0x10) continue;
      if (buf[i + 1] === 0x00) { g.strokeWeight = 0; break; }
      const v = decFloat(buf, i + 1);
      if (plausibleTag(buf[i + 1]) && v > 0 && v <= 5000) { g.strokeWeight = v; break; }
    }
    if (g.strokeWeight === null) g.strokeWeight = 1; // 默认 1
  }

  // strokeAlign（描边对齐，字段 13，2026-09 破解，770/770 与浏览器真值一致）：
  //   `13 01` → CENTER、`13 02` → INSIDE、`13 03` → OUTSIDE；无 13 字段 → 默认 CENTER。
  //   注：几何段内其它 13 字节（浮点尾数误撞）因后随字节非 01/02/03 会被跳过。
  g.strokeAlign = "CENTER";
  {
    const stop = Math.min(end, geomPos + 256);
    for (let i = geomPos; i + 1 < stop; i++) {
      if (buf[i] !== 0x13) continue;
      const v = buf[i + 1];
      if (v === 0x01) { g.strokeAlign = "CENTER"; break; }
      if (v === 0x02) { g.strokeAlign = "INSIDE"; break; }
      if (v === 0x03) { g.strokeAlign = "OUTSIDE"; break; }
    }
  }

  // constraints（布局约束，2026-09 破解）：
  //   字段 0b=vertical、0c=horizontal，枚举 `01`=END、`03`=CENTER、`04`=SCALE；字段缺省=START。
  //   两字段仅在该轴为非默认值时出现（如 `0b 03 0c 03` → 垂直/水平皆 CENTER）。
  //   实测垂直 546/548、水平 546/548 与浏览器真值一致；偏差为实例内部节点继承母版约束。
  {
    const stop = Math.min(end, geomPos + 16);
    const dec = (v: number | undefined): string =>
      v === 0x01 ? "END" : v === 0x03 ? "CENTER" : v === 0x04 ? "SCALE" : "START";
    let vv: number | undefined;
    let hv: number | undefined;
    for (let i = geomPos; i + 1 < stop; i++) {
      if (buf[i] === 0x0b && buf[i + 1] <= 0x05) vv = buf[i + 1];
      else if (buf[i] === 0x0c && buf[i + 1] <= 0x05) hv = buf[i + 1];
    }
    g.constraints = { horizontal: dec(hv), vertical: dec(vv) };
  }

  // x / y 与完整仿射变换：18 块「18 <子块...> 00」。
  //   子 01=tx(x)、02=ty(y)（各 4 字节带符号紧凑浮点）
  //   子 03..06 按 (m00, m11, m01, m10) 顺序打包 2×2 矩阵 → m = [[s3,s5],[s6,s4]]
  //   值为 0 的子以单字节 00 标志存放，非 0 以 4 字节带符号紧凑浮点存放；块以 00 结束。
  const stop18 = Math.min(end, geomPos + 256);
  for (let i = geomPos; i + 1 < stop18; i++) {
    if (buf[i] !== 0x18) continue;
    let j = i + 1;
    const subs: Record<number, number> = {};
    while (j < end && buf[j] !== 0) {
      const sub = buf[j];
      const tag = buf[j + 1];
      if (sub >= 1 && sub <= 6 && j + 5 <= end && plausibleTag(tag)) {
        subs[sub] = decFloatSigned(buf, j + 1);
        j += 5;
      } else if (sub >= 3 && sub <= 6 && tag === 0x00) {
        subs[sub] = 0; // 0 值以单字节 00 标志存放
        j += 2;
      } else {
        j += 1;
      }
    }
    g.x = subs[1] ?? 0;
    g.y = subs[2] ?? 0;
    // 矩阵子 03..06 为 (m00, m11, m01, m10)；缺省为单位阵
    const m00 = subs[3] ?? 1;
    const m11 = subs[4] ?? 1;
    const m01 = subs[5] ?? 0;
    const m10 = subs[6] ?? 0;
    g.rotation = (Math.atan2(m10 || 0, m00 || 0) * 180) / Math.PI;
    g.transform = { tx: g.x, ty: g.y, m00, m01, m10, m11 };
    break; // 已定位首个 18 块
  }

  // cornerRadius（仅 RECTANGLE）：首个 1c 类型块后接「01 04 + 4×紧凑浮点」
  if (type === "RECTANGLE") {
    const stop = Math.min(end, geomPos + 256);
    for (let i = geomPos; i + 2 < stop; i++) {
      if (buf[i] !== 0x1c || buf[i + 1] !== 0x03) continue;
      const c1 = buf[i + 2];
      const c2 = buf[i + 3];
      if (c1 === 0x01 && c2 === 0x04 && i + 4 + 16 <= end) {
        // 4 个角各为 4 字节紧凑浮点；任一 tag 不合理或值非法则整体判为无法解析
        let bad = false;
        const rs = [0, 1, 2, 3].map((k): number => {
          const p = i + 4 + k * 4;
          if (!plausibleTag(buf[p])) bad = true;
          const v = decFloat(buf, p);
          if (!Number.isFinite(v) || v < 0 || v > 9999) bad = true;
          return v;
        });
        if (!bad) {
          // 4 角一致给单值，否则 4 元数组
          const allEq = rs.every((r) => Math.abs(r - rs[0]) < 0.001);
          g.cornerRadius = allEq ? rs[0] : rs;
        }
      }
      break;
    }
  }

  // fills / strokes：提取几何段内的 paint 引用 id 并经 paintMap 关联颜色。
  //   图元：`15 <refId>\0` 视为 fill，`16/17 <refId>\0` 视为 stroke（含 inline paint）。
  //   TEXT：`09 01 02 02 03 <refId>\0` 承载 fill 引用。
  // 实测（2019 火车票）：153 个 SOLID fill 节点中 142 个经此路径 RGBA 与浏览器真值一致，
  // 剩余为渐变/实例内部引用/半透明边界等边缘场景。
  if (paintMap) {
    const stopP = Math.min(end, geomPos + 512);
    for (let i = geomPos; i + 1 < stopP; i++) {
      const k = buf[i];
      let refId: string | null = null;
      let target: NodePaint[] | null = null;
      if (i + 5 < stopP && k === 0x09 && buf[i + 1] === 0x01 && buf[i + 2] === 0x02 && buf[i + 3] === 0x02 && buf[i + 4] === 0x03) {
        const c = readCstr(buf, i + 5);
        if (c && ID_RE.test(c.s)) { refId = c.s; target = g.fills; i = c.next - 1; }
      } else if ((k === 0x15 || k === 0x16 || k === 0x17) && buf[i + 1] !== 0) {
        const c = readCstr(buf, i + 1);
        if (c && ID_RE.test(c.s)) {
          refId = c.s;
          target = k === 0x15 ? g.fills : g.strokes;
          i = c.next - 1;
        }
      }
      if (refId === null || target === null) continue;
      const entry = paintMap.get(refId);
      target.push({
        refId,
        kind: entry ? entry.kind : "UNKNOWN",
        color: entry ? entry.color : null,
      });
    }
  }

  // autoLayout：位于几何段内 `1c 07` 类型块，编码见 NodeAutoLayout 注释。
  g.autoLayout = parseAutoLayout(buf, geomPos, end);

  return g;
}

/**
 * 从全量 /data 二进制中解析出以 pageId 为根的节点树。
 * 扫描所有 `01 <id>\0` 节点记录，依据 02=parent 构建父子链接，再以 pageId 为根收拢子树。
 */
export function parsePageTree(buf: Buffer, pageId: string): PageTree {
  const byId = new Map<string, RawRec>();

  // 全量扫描（47MB 量级，单次线性，足够快）
  // 节点记录以 0x01 起始；用它后跟的 id 形如 \d+:\d+ 判定
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x01) continue;
    // 读取候选 id
    let e = i + 1;
    while (e < buf.length && buf[e] !== 0) e++;
    if (e >= buf.length) continue;
    if (e - (i + 1) < 3 || e - (i + 1) > 64) continue; // 长度护栏
    const cand = buf.subarray(i + 1, e).toString("utf8");
    if (!ID_RE.test(cand)) continue;
    // 避免把别的字段里的 id 误当记录：要求紧跟的是 02/03/04 之一
    if (e + 1 >= buf.length) continue;
    const nx = buf[e + 1];
    if (nx !== 0x02 && nx !== 0x03 && nx !== 0x04) continue;
    if (byId.has(cand)) continue; // 保留首次出现的规范记录
    const rec = parseRawRecord(buf, i);
    byId.set(cand, rec);
    i = e; // 跳到 id 末尾继续，避免 O(n²)
  }

  const pageRec = byId.get(pageId);
  if (!pageRec) throw new Error(`二进制中未找到页面记录：${pageId}`);

  // 计算每个记录的几何段结束（= 下一个节点记录 pos），用于类型解码的边界
  const byPos = [...byId.values()].sort((a, b) => a.pos - b.pos);
  const geomEnd = new Map<string, number>();
  for (let i = 0; i < byPos.length; i++) {
    const next = i + 1 < byPos.length ? byPos[i + 1].pos : buf.length;
    geomEnd.set(byPos[i].id, next);
  }

  // 构建节点对象（含一面 paint 表用于 fill/stroke 颜色）
  const paintMap = buildPaintTable(buf);
  const tnodes = new Map<string, TreeNode>();
  for (const [id, r] of byId) {
    let parent = r.parent;
    if (parent === null && r.anchor && r.anchor === pageId) {
      parent = pageId; // 页面顶层节点
    }
    const end = geomEnd.get(id) ?? buf.length;
    const type = decodeNodeType(buf, r.geomPos, end);
    tnodes.set(id, {
      id,
      name: r.name,
      parent,
      typeRaw: r.typeRaw,
      anchor: r.anchor,
      type,
      geometry: parseNodeGeometry(buf, r.geomPos, end, type, paintMap),
    });
  }

  const root = tnodes.get(pageId)!;
  // 预建 parent → children 映射：一次线性归组，避免对每个节点都遍历全部节点（O(n²) → O(n)）。
  const childrenOf = new Map<string, TreeNode[]>();
  for (const t of tnodes.values()) {
    if (t.parent === null || t.parent === t.id) continue; // 跳过页面根与自引用
    const arr = childrenOf.get(t.parent);
    if (arr) arr.push(t);
    else childrenOf.set(t.parent, [t]);
  }
  // 按原子节顺序排序每个父节点的子节点
  const posOf = (id: string): number => byId.get(id)?.pos ?? 0;
  for (const arr of childrenOf.values()) arr.sort((a, b) => posOf(a.id) - posOf(b.id));

  // 只保留能一路回溯到 pageId 的节点（本页子树）
  const keep = new Set<string>();
  const stack = [pageId];
  const children: Record<string, TreeNode[]> = {};
  const order: string[] = [];
  while (stack.length) {
    const cur = stack.pop()!;
    if (keep.has(cur)) continue;
    keep.add(cur);
    order.push(cur);
    if (!tnodes.has(cur)) continue;
    const kids = childrenOf.get(cur) ?? [];
    for (const k of kids) stack.push(k.id);
    children[cur] = kids;
  }

  const nodes = order.map((id) => tnodes.get(id)!);
  return { pageId, root, nodes, children };
}

/**
 * 文件级 paint 样式（颜色样式）。
 *
 * 实测（2026-09 火车票文件，4 个本地 paint 样式与浏览器 getLocalPaintStyles() 真值一致）：
 *   - id / name / ukey 与真值完全一致（4/4 命中）
 *   - SOLID 样式的 RGBA 颜色经 paint 定义表（buildPaintTable）查询 refId=selfId 获取，
 *     与浏览器 API 真值一致
 *   - 渐变样式（GRADIENT_LINEAR/RADIAL）暂只标记 kind，color 为 null
 *     （渐变 stops 多色解码暂未实现，留待后续）
 *
 * collectionId 默认 "M:1"、collectionName 默认 "集合"：实测本文件 4 个本地 paint 样式
 * 全部归属同一 collection（"M:1" / "集合"），但二进制中**没有独立 collection 表**存储
 * 这两字段（搜 "115278536821990+M:" 0 命中），疑似 MasterGo 客户端对每个文件默认构造
 * 一个 collection。本实现先按约定硬编码，若未来发现多 collection 文件需调整。
 */
export interface PaintStyle {
  /** 样式 id（selfId，形如 "5481:060533"） */
  id: string;
  /** 样式名（如 "f1f4fb"、"渐变"、"1"、"2"） */
  name: string;
  /** 样式类型，目前仅支持 "PAINT" */
  type: "PAINT";
  /** collectionId（本文件默认 "M:1"） */
  collectionId: string;
  /** collectionName（本文件默认 "集合"） */
  collectionName: string;
  /** ukey（fileId+selfId） */
  ukey: string;
  /** 是否来自外部文件（本文件扫描时按 ukey 前缀筛掉外部，恒为 false） */
  isExternal: boolean;
  /** 样式包含的 paint 列表（SOLID 给 color，渐变等 color 为 null） */
  paints: NodePaint[];
}

/**
 * 扫描二进制中所有 paint 样式聚合记录，返回**本文件定义**的 paint 样式列表。
 *
 * Paint 样式聚合记录格式（2026-09 破解，4/4 本地样式与浏览器 API 真值一致）：
 *       01 <selfId> \0 02 <name> \0 03 61 <subtype> \0 [04 00] 05 01 00 00 06 01 07 <ukey> \0 08 ...
 *   - 01：样式 selfId（如 "5481:060533"）
 *   - 02：样式名（如 "f1f4fb"）
 *   - 03 61 <subtype>：类型 PAINT（0x61='a'），subtype 0x40+ 是样式聚合记录独有
 *     （paint 表条目 subtype=0x30，节点记录 typeRaw 也叫 a1/a2 等但不会同时有
 *     `05 01 00 00 06 01 07 <ukey>` 后缀）
 *   - 04 00：可选 flag 字段（部分样式有，含义未知）
 *   - 05 01 00 00 06 01：固定字节，疑似 version/flag
 *   - 07 <ukey>：ukey = fileId+selfId（如 "115278536821990+5481:060533"）
 *   - 08 <???>：paint 子项引用（结构复杂，暂不解；颜色走 paint 定义表查 selfId）
 *
 * 锚点：`03 61 <subtype> 00 [04 00] 05 01 00 00 06 01 07 <ukey>`，精准区分 paint 样式
 * 聚合记录 vs 节点记录（节点 typeRaw 也叫 aX 但没有此后缀）。
 *
 * 本文件样式筛选用 ukey 前缀匹配 fileId+'+'：ukey 形如 "115278536821990+<selfId>" 是本文件
 * 定义，其他 ukey 前缀（如 "87978417736562+..."）是外部样式引用（来自团队库/组件库）。
 *
 * @param buf /data 二进制
 * @param fileId 数字 documentId（如 115278536821990），用于筛本文件 ukey 前缀
 */
export function listLocalPaintStyles(buf: Buffer, fileId: string): PaintStyle[] {
  const paintMap = buildPaintTable(buf);
  const prefix = fileId + "+";
  const styles: PaintStyle[] = [];

  for (let i = 0; i + 11 < buf.length; i++) {
    if (!(buf[i] === 0x03 && buf[i + 1] === 0x61 && buf[i + 3] === 0x00)) continue;
    let p = i + 4;
    if (buf[p] === 0x04 && buf[p + 1] === 0x00) p += 2;
    if (
      !(buf[p] === 0x05 && buf[p + 1] === 0x01 && buf[p + 2] === 0x00 &&
        buf[p + 3] === 0x00 && buf[p + 4] === 0x06 && buf[p + 5] === 0x01 && buf[p + 6] === 0x07)
    ) continue;
    // 回溯找 01 <id>\0 02 <name>\0
    let selfId: string | null = null;
    let name: string | null = null;
    for (let j = i - 1; j >= Math.max(0, i - 200); j--) {
      if (buf[j] !== 0x01) continue;
      const ca = readCstr(buf, j + 1);
      if (!ca || !ID_RE.test(ca.s)) continue;
      if (buf[ca.next] !== 0x02) continue;
      const cb = readCstr(buf, ca.next + 1);
      if (!cb || cb.next !== i) continue;
      selfId = ca.s;
      name = cb.s;
      break;
    }
    if (!selfId || !name) continue;
    const ukey = readCstr(buf, p + 7);
    if (!ukey || !ukey.s.startsWith(prefix)) continue; // 只取本文件样式

    // 查 paint 定义表：SOLID 样式 selfId 是 paint 表条目的 refId，
    // buildPaintTable 已建 selfId+refId 双索引，可直接查 selfId 拿 RGBA。
    const entry = paintMap.get(selfId);
    const kind: NodePaint["kind"] = entry ? entry.kind : "GRADIENT";
    const paints: NodePaint[] = [
      {
        refId: selfId,
        kind,
        color: entry ? entry.color : null,
      },
    ];
    styles.push({
      id: selfId,
      name,
      type: "PAINT",
      collectionId: "M:1",
      collectionName: "集合",
      ukey: ukey!.s,
      isExternal: false,
      paints,
    });
  }
  return styles;
}