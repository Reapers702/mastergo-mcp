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
 */

export interface TreeNode {
  id: string;
  name: string;
  parent: string | null;
  /** 03 字段原始类型码（见文件头说明，不保证为类型判别） */
  typeRaw: string | null;
  /** 记录尾 1b 锚点（通常是页面 id） */
  anchor: string | null;
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

/** 解析单个 `01 <id>\0` 节点记录：读 02/03/04 字段，返回 {id,parent,name,typeRaw,pos} */
interface RawRec {
  id: string;
  parent: string | null;
  name: string;
  typeRaw: string | null;
  pos: number;
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
  return { id, parent, name, typeRaw, pos, anchor };
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

  // 构建 id -> TreeNode
  const tnodes = new Map<string, TreeNode>();
  for (const [id, r] of byId) {
    let parent = r.parent;
    if (parent === null && r.anchor && r.anchor === pageId) {
      parent = pageId; // 页面顶层节点
    }
    tnodes.set(id, {
      id,
      name: r.name,
      parent,
      typeRaw: r.typeRaw,
      anchor: r.anchor,
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