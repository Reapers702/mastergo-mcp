/**
 * MasterGo 私有二进制 DSL（/data/{fileKey}）的节点索引解析。
 *
 * 结论（2026-09 火车票文件实测）：
 *   - 全量 /data 数据约 47MB（旧实现只拉前 8MB，只覆盖了文件头部的页面索引，
 *     而绝大多数节点记录位于 8MB 之后，因此必须全量拉取）。
 *   - 文件中反复出现定长 marker 后跟一段「节点记录」：
 *         <prefix> <node_id> \x00 \x02 <node_name> \x00
 *     - prefix = \x07\x01\x08\x00\x09\x01\x00\x01  → 该记录是「页面」（page）
 *     - prefix = \x09\x01\x00\x01                → 该记录是「普通节点」（图层/组/实例…）
 *     （页面记录其实包含普通节点 marker，故用「marker 前 4 字节是否为 \x07\x01\x08\x00」区分）
 *   - 节点名可能是真实名称，也可能形如 "316:11748"（组件实例引用），此处照原样保留。
 *
 * 此模块只做「可靠、零推断」的全量节点索引（id + 名称，去重、按文档顺序）。
 * 父子层级、节点类型、几何等仍待更深逆向，暂不在此交付。
 *
 * 注意：结构为对私有格式的最小逆向；若页面/节点块字节结构变化，可能需要同步调整。
 */

const NODE_MARKER = Buffer.from([0x09, 0x01, 0x00, 0x01]);
const PAGE_PREFIX = Buffer.from([0x07, 0x01, 0x08, 0x00]);

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