/**
 * MasterGo 私有二进制 DSL（/data/{fileKey}）的节点索引解析。
 *
 * 结论（2026-09 实测，legacy 火车票 + modern Ant Design 5.0）：
 *   - 全量 /data 数据可达 47MB+（旧实现只拉前 8MB，只覆盖了文件头部的页面索引，
 *     而绝大多数节点记录位于 8MB 之后，因此必须全量拉取）。
 *   - 两套节点记录结构：
 *     legacy：定长 marker 后跟一段「节点记录」：
 *         <prefix> <node_id> \x00 \x02 <node_name> \x00
 *       - prefix = \x07\x01\x08\x00\x09\x01\x00\x01  → 该记录是「页面」（page）
 *       - prefix = \x09\x01\x00\x01                → 该记录是「普通节点」（图层/组/实例…）
 *     modern：以 `01 <node_id>\0` 起始的线性记录，02=parent（空/非 id 则为页面名）、
 *       `03 <typeRaw>`、`04 <name>`；文件头有签名 `09 02 01 04 02 00 03 <count>`。
 *   - 节点名可能是真实名称，也可能形如 "316:11748"（组件实例引用），此处照原样保留。
 *
 * 此模块只做「可靠、零推断」的全量节点索引（id + 名称，去重、按文档顺序）。
 * 父子层级、节点类型、几何等仍待更深逆向，暂不在此交付。
 *
 * 注意：结构为对私有格式的最小逆向；若页面/节点块字节结构变化，可能需要同步调整。
 */

const NODE_MARKER = Buffer.from([0x09, 0x01, 0x00, 0x01]);
const PAGE_PREFIX = Buffer.from([0x07, 0x01, 0x08, 0x00]);
const MODERN_HEAD = Buffer.from([0x09, 0x02, 0x01, 0x04, 0x02, 0x00, 0x03]);
const ID_RE = /^\d+:\d+(?:\/\d+:\d+)*$/;

import { parsePageBlocks } from "./page-index.js";

/** 从 p 起读取一个以 \0 结尾的 UTF-8 字符串；合法则返回 {s,next}，否则返回 null。 */
function readCstr(buf: Buffer, p: number): { s: string; next: number } | null {
  if (p < 0 || p >= buf.length) return null;
  let e = p;
  while (e < buf.length && buf[e] !== 0) e++;
  return { s: buf.subarray(p, e).toString("utf8"), next: e + 1 };
}

/**
 * 解析 modern 格式节点索引。
 *
 * 页面列表**不在此判定**（正文里「02 非 id」的记录既可能是页面名也可能是实例引用名，
 * 会大面积误判页面），直接复用 parsePageBlocks 的头部索引；节点扫描与
 * node-tree.ts 的 parsePageTree 共用同一 `01 <id>\0` 语义，排除页面 id 即可，
 * name 优先取 `04` 字段，回退 `02` 字段的非 id 值（实例引用名等）。
 */
function parseModernNodeBlocks(buf: Buffer): ParsedNodeBlocks {
  const pages = parsePageBlocks(buf);
  const pageIds = new Set(pages.map((p) => p.id));
  const nodes = new Map<string, string>();

  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x01) continue;
    const idField = readCstr(buf, i + 1);
    if (!idField || idField.s.length < 3 || idField.s.length > 64 || !ID_RE.test(idField.s)) continue;
    if (idField.next >= buf.length) continue;
    const nx = buf[idField.next];
    if (nx !== 0x02 && nx !== 0x03 && nx !== 0x04) continue;
    if (pageIds.has(idField.s)) {
      i = idField.next; // 页面记录：id/name 由头部索引提供
      continue;
    }

    let p = idField.next;
    let name = "";
    let fallbackName = "";
    for (let k = 0; k < 8; k++) {
      if (p >= buf.length) break;
      const key = buf[p];
      if (key === 0x02) {
        const v = readCstr(buf, p + 1);
        if (!v) break;
        p = v.next;
        if (v.s === "") continue; // 空父占位
        if (!ID_RE.test(v.s) && !fallbackName) fallbackName = v.s; // 非 id 值（实例引用名等）
      } else if (key === 0x03) {
        const v = readCstr(buf, p + 1);
        if (!v) break;
        p = v.next;
      } else if (key === 0x04) {
        const v = readCstr(buf, p + 1);
        if (!v) break;
        name = v.s;
        p = v.next;
        break;
      } else break;
    }
    if (!name) name = fallbackName;
    if (!name) continue;
    if (!nodes.has(idField.s)) nodes.set(idField.s, name);
    i = idField.next; // 跳到 id 末尾，避免 O(n²)
  }

  return {
    pages,
    nodes: [...nodes.entries()].map(([id, name]) => ({ id, name })),
  };
}

/** 从 marker 之后读取一段记录：<id> \0 \x02 <name> \0；合法则返回 {id,name,next} */
function tryReadRecord(
  buf: Buffer,
  p: number
): { id: string; name: string; next: number } | null {
  const idStart = p;
  while (p < buf.length && buf[p] !== 0) p++;
  if (p >= buf.length) return null;
  const id = buf.subarray(idStart, p).toString("utf8");
  p++;
  if (buf[p] !== 0x02) return null;
  p++;
  const ns = p;
  while (p < buf.length && buf[p] !== 0) p++;
  if (p >= buf.length) return null;
  const name = buf.subarray(ns, p).toString("utf8");
  if (!name) return null;
  return { id, name, next: p + 1 };
}

export interface NodeRecord {
  id: string;
  name: string;
}

export interface ParsedNodeBlocks {
  pages: NodeRecord[];
  nodes: NodeRecord[];
}

export function parseNodeBlocks(buf: Buffer): ParsedNodeBlocks {
  // modern 格式以文件头签名 `09 02 01 04 02 00 03 <count>` 判别（对 legacy 无此签名）。
  if (buf.indexOf(MODERN_HEAD) >= 0) return parseModernNodeBlocks(buf);

  const pages = new Map<string, string>();
  const nodes = new Map<string, string>();

  let pos = 0;
  while (pos < buf.length) {
    const m = buf.indexOf(NODE_MARKER, pos);
    if (m === -1) break;
    const isPage = m >= PAGE_PREFIX.length && buf.subarray(m - PAGE_PREFIX.length, m).equals(PAGE_PREFIX);
    const rec = tryReadRecord(buf, m + NODE_MARKER.length);
    if (rec) {
      const target = isPage ? pages : nodes;
      if (!target.has(rec.id)) target.set(rec.id, rec.name);
      pos = rec.next;
    } else {
      pos = m + 1;
    }
  }

  return {
    pages: [...pages.entries()].map(([id, name]) => ({ id, name })),
    nodes: [...nodes.entries()].map(([id, name]) => ({ id, name })),
  };
}