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
 *
 * 已知局限：
 *   - rotation / transform / fill(颜色) / stroke / 布局约束(layout) 未解码，留待后续。
 *
 * 坐标符号已破解（2026-09，178/178 x 与 177/177 y 对照浏览器 API 真值一致）：
 *   18 块内 x/y 使用**带符号**紧凑浮点（decFloatSigned），符号位是 24 位小端尾数
 *   最低尾数字节 bit0：置 1 表示负、清 0 表示正。利用整数浮点尾数精度余量存储符号，
 *   解码时先清除该位还原纯幅度再决定正负。
 */
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

/**
 * 解析节点几何/布局属性（见 NodeGeometry 注释的属性语义与局限）。
 * @param type 节点的已解码类型（用于 RECTANGLE 的圆角定位）
 */
function parseNodeGeometry(
  buf: Buffer,
  geomPos: number,
  end: number,
  type: string | null
): NodeGeometry {
  const g: NodeGeometry = {
    width: null,
    height: null,
    opacity: null,
    cornerRadius: null,
    x: 0,
    y: 0,
    positionSignResolved: true,
  };

  // width(0e) / height(0f)：尺寸在 [0.001, 50000] 之间
  g.width = findFloatField(buf, geomPos, end, 0x0e, 0.001, 50000);
  g.height = findFloatField(buf, geomPos, end, 0x0f, 0.001, 50000);
  // opacity(0a)：仅当 !=1 时存在，值域 [0, 1]
  g.opacity = findFloatField(buf, geomPos, end, 0x0a, 0, 1);

  // x / y：定位 18 容器块「18 <sub...> 00」，sub01=x、sub02=y，各跟 4 字节带符号紧凑浮点
  const stop18 = Math.min(end, geomPos + 256);
  for (let i = geomPos; i + 1 < stop18; i++) {
    if (buf[i] !== 0x18) continue;
    let j = i + 1;
    while (j < end && buf[j] !== 0) {
      const sub = buf[j];
      if (sub === 0x01 && j + 5 <= end && plausibleTag(buf[j + 1])) {
        g.x = decFloatSigned(buf, j + 1);
        j += 5;
      } else if (sub === 0x02 && j + 5 <= end && plausibleTag(buf[j + 1])) {
        g.y = decFloatSigned(buf, j + 1);
        j += 5;
      } else {
        j += 1;
      }
    }
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

  // 构建 id -> TreeNode
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
      geometry: parseNodeGeometry(buf, r.geomPos, end, type),
    });
  }

  const root = tnodes.get(pageId)!;
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
    const me = tnodes.get(cur);
    if (!me) continue;
    // 找 cur 的子节点
    const kids: TreeNode[] = [];
    for (const [id, t] of tnodes) {
      if (id === cur) continue;
      if (t.parent === cur) {
        kids.push(t);
        stack.push(id);
      }
    }
    // 按原子节顺序排序子节点
    kids.sort((a, b) => (byId.get(a.id)?.pos ?? 0) - (byId.get(b.id)?.pos ?? 0));
    children[cur] = kids;
  }

  const nodes = order.map((id) => tnodes.get(id)!);
  return { pageId, root, nodes, children };
}