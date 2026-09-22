/**
 * MasterGo 私有二进制 DSL（/data/{fileKey}?wv=v3.0.0）的轻量解析。
 *
 * 实测文件头部「页面索引」存在两种格式（2026-09 实测）：
 *   legacy（传统，如火车票）：
 *     1. 文件头部的首页面块：  \x03N\x01 <page_id> \x00 \x02 <page_name> \x00 ...
 *     2. 其余页面块：          \x07\x01\x08\x00\x09\x01\x00\x01 <page_id> \x00 \x02 <page_name> \x00 ...
 *   modern（较新，如 Ant Design 5.0 公开文件）：
 *     文件头签名 09 02 01 04 02 00 03 <pageCount>，其后线性排列
 *     <pageCount> 个页面块：01 <page_id> \x00 02 <page_name> \x00
 *
 * 先尝试 modern 头部索引；未命中则回退 legacy 双 marker 扫描，按 id 去重。
 * 注意：这是对私有格式的最小逆向，若后续页面块结构变化，可能需要同步调整。
 */

const MARKER_HEAD_PAGE = Buffer.from([0x03, 0x4e, 0x01]); // \x03N\x01
const MARKER_PAGE = Buffer.from([0x07, 0x01, 0x08, 0x00, 0x09, 0x01, 0x00, 0x01]);
const MODERN_HEAD = Buffer.from([0x09, 0x02, 0x01, 0x04, 0x02, 0x00, 0x03]);
/**
 * modern 头部签名的**后半段**：`01 04 02 00 03`，紧随其后 1 字节是 pageCount。
 *
 * ⚠️ 完整签名是 `09 <X> 01 04 02 00 03 <count>`，其中 **`<X>` 会变**：
 * 实测同一份 antd5 官方稿，2026-09-21 下载为 `09 02`，2026-09-22 下载为 `09 04`，
 * 而同一副本文件两次下载又是 `09 16`（`/data` 本就不可字节复现）。
 * 早期实现把整串写死成 `09 02 …`，于是**新下载的文件全部解析出 0 个页面** ——
 * 这是真实故障，不是测试问题。故此处只匹配后半段，`<X>` 视作可变、不作判据。
 * 签名固定出现在文件**起始处（偏移 0）**，因此按偏移校验而非全文搜索，避免误命中。
 */
const MODERN_HEAD_TAIL = Buffer.from([0x01, 0x04, 0x02, 0x00, 0x03]);

/** 读取以 \0 结尾的 utf8 字段；合法则返回 { value, next }，否则返回 null。 */
function readCString(buf: Buffer, p: number): { value: string; next: number } | null {
  const start = p;
  while (p < buf.length && buf[p] !== 0) p++;
  if (p >= buf.length) return null;
  return { value: buf.subarray(start, p).toString("utf8"), next: p + 1 };
}

/**
 * 解析 modern 格式头部页面索引。
 * 结构：<MODERN_HEAD> <pageCount> 后是 pageCount 个页面块，
 * 每个页面块以 01 <id>\0 02 <name>\0 开头，块后还附带 03/04/06 等附加字段，
 * 因此不能顺序紧邻解析，改为扫描式提取：在缓冲区中搜索 01 起始的合法页面块，
 * 直到凑齐 pageCount 个。任一步骤不合法则返回 null（由调用方回退 legacy 扫描）。
 */
function parseModernHeadIndex(buf: Buffer): Array<{ id: string; name: string }> | null {
  // 主判据：文件起始处的 `09 <X> 01 04 02 00 03 <count>`（X 可变，见 MODERN_HEAD_TAIL 注释）
  let p: number;
  if (buf.length > 8 && buf[0] === 0x09 && buf.subarray(2, 7).equals(MODERN_HEAD_TAIL)) {
    p = 7; // count 位于偏移 7
  } else {
    // 兜底：兼容历史上 X=02 的旧签名（全文搜索，行为与早期实现一致）
    const idx = buf.indexOf(MODERN_HEAD);
    if (idx === -1) return null;
    p = idx + MODERN_HEAD.length;
  }
  if (p >= buf.length) return null;
  const count = buf[p];
  if (count === 0 || count > 300) return null; // 异常 count 直接放弃
  p++;

  const pages: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  while (pages.length < count && p < buf.length) {
    const m = buf.indexOf(0x01, p);
    if (m === -1) break;
    const idField = readCString(buf, m + 1);
    if (!idField || !/^\d+:\d+$/.test(idField.value)) {
      p = m + 1;
      continue;
    }
    if (buf[idField.next] !== 0x02) {
      p = m + 1;
      continue;
    }
    const nameField = readCString(buf, idField.next + 1);
    if (!nameField || !nameField.value || seen.has(idField.value)) {
      p = m + 1;
      continue;
    }
    seen.add(idField.value);
    pages.push({ id: idField.value, name: nameField.value });
    p = nameField.next;
  }
  return pages.length === count ? pages : null;
}

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
  // 优先 modern 头部索引（新格式文件），未命中再回退 legacy 双 marker 扫描。
  const modern = parseModernHeadIndex(buf);
  if (modern) return modern;

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
