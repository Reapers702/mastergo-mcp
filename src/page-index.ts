/**
 * MasterGo 私有二进制 DSL（/data/{fileKey}?wv=v3.0.0）的轻量解析。
 *
 * 实测文件头部「页面块」存在两种形态（以 2026-09 火车票文件为准）：
 *   1. 文件头部的首页面块：  \x03N\x01 <page_id> \x00 \x02 <page_name> \x00 ...
 *   2. 其余页面块：          \x07\x01\x08\x00\x09\x01\x00\x01 <page_id> \x00 \x02 <page_name> \x00 ...
 *
 * 这里同时扫描两种 marker 提取全部页面列表（page_id + page_name），按 id 去重。
 * 注意：这是对私有格式的最小逆向，若后续页面块结构变化，可能需要同步调整。
 */

const MARKER_HEAD_PAGE = Buffer.from([0x03, 0x4e, 0x01]); // \x03N\x01
const MARKER_PAGE = Buffer.from([0x07, 0x01, 0x08, 0x00, 0x09, 0x01, 0x00, 0x01]);

/** 以指定 marker 为起点，尝试读取一个页面块（id + name）。合法则返回块尾位置，否则返回 -1。 */
function tryReadPage(buf: Buffer, marker: Buffer, m: number): { id: string; name: string; next: number } | null {
  let p = m + marker.length;
  const idStart = p;
  while (p < buf.length && buf[p] !== 0) p++;
  if (p >= buf.length) return null;
  const id = buf.subarray(idStart, p).toString("utf8");
  p++;
  if (!/^\d+:\d+$/.test(id)) return null;
  if (buf[p] !== 0x02) return null;
  p++;
  const nameStart = p;
  while (p < buf.length && buf[p] !== 0) p++;
  if (p >= buf.length) return null;
  const name = buf.subarray(nameStart, p).toString("utf8");
  if (!name) return null;
  return { id, name, next: p + 1 };
}

export function parsePageBlocks(buf: Buffer): Array<{ id: string; name: string }> {
  const pages: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();

  const scan = (marker: Buffer) => {
    let pos = 0;
    while (pos < buf.length) {
      const m = buf.indexOf(marker, pos);
      if (m === -1) break;
      const read = tryReadPage(buf, marker, m);
      if (read) {
        if (!seen.has(read.id)) {
          seen.add(read.id);
          pages.push({ id: read.id, name: read.name });
        }
        pos = read.next;
      } else {
        pos = m + 1;
      }
    }
  };

  scan(MARKER_HEAD_PAGE);
  scan(MARKER_PAGE);
  return pages;
}
