/**
 * 设计稿节点树差异对比（纯函数，不依赖网络 / 真值）。
 *
 * 输入两份页面的节点数组（来自 `parsePageTree` 的 `PageTree.nodes`，均为本页子树节点），
 * 输出结构化 diff：新增 / 删除 / 修改三类变更，修改带字段级明细。
 *
 * 匹配策略（matchBy）：
 *   - "id"（默认）：按节点 id 匹配。适合同一文件的不同版本（id 稳定）、或 id 可对齐的场景。
 *   - "path"：按「从页面根到节点的名称路径」匹配，重名兄弟节点按出现次序追加 `#n` 消歧。
 *     适合跨文件对比（不同文件 id 完全不同，但图层结构同名同构）。
 *     注意：节点改名会表现为 removed + added（新名路径对不上），属预期行为。
 *
 * 比较范围：name / type / geometry（递归对象级对比，数值按 1e-6 容差）。
 * ignore 可整体跳过字段（"name"、"type"、"geometry"），或按点路径前缀跳过
 * geometry 子字段（如 "geometry.x"、"geometry.fills"）。
 */

import type { TreeNode } from "./node-tree.js";

export type DiffMatchBy = "id" | "path";
export type DiffChangeKind = "added" | "removed" | "changed";

export interface DiffOptions {
  matchBy: DiffMatchBy;
  /** 忽略字段：如 "name"、"type"、"geometry"、"geometry.x"（支持前缀匹配） */
  ignore?: string[];
  /** 最多返回的变更条数，默认 200；0 表示不限制 */
  maxChanges?: number;
}

export interface FieldChange {
  /** 差异字段路径，如 "geometry.x"、"name" */
  path: string;
  old: unknown;
  new: unknown;
}

export interface DiffEntry {
  change: DiffChangeKind;
  /** 匹配键：matchBy=id 时为节点 id；matchBy=path 时为名称路径 */
  key: string;
  nodeIdA: string | null;
  nodeIdB: string | null;
  nameA: string | null;
  nameB: string | null;
  typeA: string | null;
  typeB: string | null;
  /** 仅 change=changed 时存在 */
  fields?: FieldChange[];
}

export interface DiffResult {
  matchBy: DiffMatchBy;
  totalA: number;
  totalB: number;
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  /** 变更条目（removed → added → changed 分组，组内按 key 排序） */
  changes: DiffEntry[];
  truncated: boolean;
}

const NUM_EPS = 1e-6;

/** 计算 id → 名称路径（重名兄弟按出现次序追加 `#n` 消歧） */
function buildPathKeys(nodes: TreeNode[]): Map<string, string> {
  const ids = new Set(nodes.map((n) => n.id));
  const key = new Map<string, string>();
  // 同级同名出现次数（按节点序），键 = parent + \0 + name
  const nameOcc = new Map<string, number>();
  for (const n of nodes) {
    const parent = n.parent != null && ids.has(n.parent) ? n.parent : null;
    const pKey = parent != null ? key.get(parent) ?? "" : "";
    const name = n.name !== "" ? n.name : `<${n.type ?? "unknown"}>`;
    const occKey = `${parent ?? "\u0000"}\u0000${name}`;
    const occ = nameOcc.get(occKey) ?? 0;
    nameOcc.set(occKey, occ + 1);
    const label = occ > 0 ? `${name}#${occ}` : name;
    key.set(n.id, pKey ? `${pKey}/${label}` : label);
  }
  return key;
}

function buildKeyMap(
  nodes: TreeNode[],
  matchBy: DiffMatchBy
): Map<string, TreeNode> {
  const map = new Map<string, TreeNode>();
  if (matchBy === "id") {
    for (const n of nodes) map.set(n.id, n);
    return map;
  }
  const pathKeys = buildPathKeys(nodes);
  for (const n of nodes) {
    const k = pathKeys.get(n.id);
    if (k != null) map.set(k, n);
  }
  return map;
}

/** 递归对象级比较；只收集叶级差异（对象/数组逐字段下钻，标量直接比较） */
function compareValues(
  a: unknown,
  b: unknown,
  path: string,
  ignore: string[],
  out: FieldChange[]
): void {
  if (ignore.some((ig) => ig === path || path.startsWith(ig + "."))) return;

  // 标量（或 null/undefined）
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    const av = a === undefined ? null : a;
    const bv = b === undefined ? null : b;
    if (av === bv) return;
    if (typeof av === "number" && typeof bv === "number" && Math.abs(av - bv) <= NUM_EPS) return;
    out.push({ path, old: av, new: bv });
    return;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : [];
    const bb = Array.isArray(b) ? b : [];
    const len = Math.max(aa.length, bb.length);
    for (let i = 0; i < len; i++) {
      compareValues(aa[i], bb[i], `${path}[${i}]`, ignore, out);
    }
    return;
  }

  // 普通对象：取并集字段
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const k of keys) {
    compareValues(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
      path ? `${path}.${k}` : k,
      ignore,
      out
    );
  }
}

export function diffTrees(
  nodesA: TreeNode[],
  nodesB: TreeNode[],
  opts: DiffOptions
): DiffResult {
  const ignore = opts.ignore ?? [];
  const maxChanges = opts.maxChanges ?? 200;

  const mapA = buildKeyMap(nodesA, opts.matchBy);
  const mapB = buildKeyMap(nodesB, opts.matchBy);

  const removed: DiffEntry[] = [];
  const added: DiffEntry[] = [];
  const changed: DiffEntry[] = [];
  let unchanged = 0;

  for (const [key, na] of mapA) {
    const nb = mapB.get(key);
    if (!nb) {
      removed.push({
        change: "removed",
        key,
        nodeIdA: na.id,
        nodeIdB: null,
        nameA: na.name,
        nameB: null,
        typeA: na.type,
        typeB: null,
      });
      continue;
    }
    if (ignore.some((ig) => ig === "name")) {
      // name 忽略时仍比较 type / geometry
    } else if (na.name !== nb.name) {
      changed.push({
        change: "changed",
        key,
        nodeIdA: na.id,
        nodeIdB: nb.id,
        nameA: na.name,
        nameB: nb.name,
        typeA: na.type,
        typeB: nb.type,
        fields: [{ path: "name", old: na.name, new: nb.name }],
      });
      continue;
    }
    if (ignore.some((ig) => ig === "type")) {
      // type 忽略
    } else if ((na.type ?? null) !== (nb.type ?? null)) {
      changed.push({
        change: "changed",
        key,
        nodeIdA: na.id,
        nodeIdB: nb.id,
        nameA: na.name,
        nameB: nb.name,
        typeA: na.type,
        typeB: nb.type,
        fields: [{ path: "type", old: na.type ?? null, new: nb.type ?? null }],
      });
      continue;
    }
    if (!ignore.some((ig) => ig === "geometry")) {
      const fields: FieldChange[] = [];
      compareValues(na.geometry, nb.geometry, "geometry", ignore, fields);
      if (fields.length > 0) {
        changed.push({
          change: "changed",
          key,
          nodeIdA: na.id,
          nodeIdB: nb.id,
          nameA: na.name,
          nameB: nb.name,
          typeA: na.type,
          typeB: nb.type,
          fields,
        });
        continue;
      }
    }
    unchanged++;
  }

  for (const [key, nb] of mapB) {
    if (!mapA.has(key)) {
      added.push({
        change: "added",
        key,
        nodeIdA: null,
        nodeIdB: nb.id,
        nameA: null,
        nameB: nb.name,
        typeA: null,
        typeB: nb.type,
      });
    }
  }

  // 分组内按 key 排序，输出稳定可读
  const sortByKey = (xs: DiffEntry[]) => xs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  sortByKey(removed);
  sortByKey(added);
  sortByKey(changed);

  const all = [...removed, ...added, ...changed];
  const truncated = maxChanges > 0 && all.length > maxChanges;
  const changes = truncated ? all.slice(0, maxChanges) : all;

  return {
    matchBy: opts.matchBy,
    totalA: nodesA.length,
    totalB: nodesB.length,
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    unchanged,
    changes,
    truncated,
  };
}
