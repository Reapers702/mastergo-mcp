/**
 * 「新鲜下载」冒烟检查：**刻意绕过一切缓存**重新下载公开样本，断言关键结构仍能解出。
 *
 * 为什么必须有这个脚本（2026-09-22 的真实 P0）：
 *   MasterGo 的 `/data/{fileKey}` 头部签名为 `09 <X> 01 04 02 00 03 <pageCount>`，
 *   其中 **`<X>` 不是常量** —— 同一份 antd5 官方稿 09-21 下载是 `09 02`、09-22 是 `09 04`。
 *   早期实现把整串写死成 `09 02 …`，于是**所有新下载的文件**都被判成 legacy：
 *   `list_pages` 返回 0 页、`get_file_nodes` 从 144055 条掉到 1 条。
 *
 *   这个 bug 能潜伏，是因为其余所有用例都吃 `~/.cache/mg` 的**旧快照**（X=02）：
 *   `test:regress` / `test:styles` / `test:e2e` 全部绿。**缓存挡住了格式漂移。**
 *
 * 因此本脚本是唯一「服务端格式变了我们能立刻知道」的检查：它不读也不写任何本地快照，
 * 直接现下现解。断言用**精确值**（不是 >0），因为该 P0 的静默退化恰恰表现为
 * 「数字变小但仍非 0」—— 宽松断言放它过去了。
 */
import axios from "axios";
import { parsePageBlocks } from "../src/page-index.ts";
import { parseNodeBlocks } from "../src/node-index.ts";

const BASE_URL = process.env.MG_BASE_URL || "https://mastergo.com";
/** Ant Design 5 官方公开文件（无需 Cookie）。 */
const FILE_KEY = "010e341a-0eae-49c9-a538-87932df0307d";
const FILE_ID = "205140012617682";
/** 实测基线：74 页 / 144055 节点；头部签名后半段。 */
const EXPECT_PAGES = 74;
const EXPECT_NODES = 144055;
const HEAD_TAIL = Buffer.from([0x01, 0x04, 0x02, 0x00, 0x03]);

let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) console.log(`ok   ${msg}`);
  else {
    console.error(`FAIL ${msg}`);
    failed++;
  }
}

async function main(): Promise<void> {
  console.log(`[fresh] 现下 ${FILE_ID}（不使用 ~/.cache/mg 任何快照）…`);
  // 刻意不走 MasterGoClient（它带 5 分钟 LRU），这里直接打接口，确保拿到的是「此刻的字节」
  const res = await axios.get(`${BASE_URL}/data/${FILE_KEY}`, {
    params: { wv: "v3.2.1" },
    responseType: "arraybuffer",
    timeout: 300_000,
    maxContentLength: Infinity,
  });
  const buf = Buffer.from(res.data as ArrayBuffer);
  console.log(`[fresh] 下载完成 ${(buf.length / 1048576).toFixed(1)}MB`);
  if (buf.length < 1_000_000) {
    console.error(`FAIL 下载结果仅 ${buf.length} 字节，不像完整二进制`);
    process.exit(1);
  }

  // 头部签名：`<X>` 可变，故只校验后半段；同时把原始字节打出来，便于漂移时定位
  const sig = [...buf.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  console.log(`[fresh] 头部 8 字节：${sig}`);
  check(
    buf.length > 8 && buf[0] === 0x09 && buf.subarray(2, 7).equals(HEAD_TAIL),
    "头部签名符合 modern 结构 `09 <X> 01 04 02 00 03`（<X> 可变）"
  );

  const pages = parsePageBlocks(buf);
  check(pages.length === EXPECT_PAGES, `页面索引解出 ${pages.length} 页（基线 ${EXPECT_PAGES}）`);
  check(
    pages.every((p) => /^\d+:\d+$/.test(p.id) && p.name.length > 0),
    "每页 id/name 均非空"
  );

  const blocks = parseNodeBlocks(buf);
  check(blocks.pages.length === EXPECT_PAGES, `节点索引页面数 ${blocks.pages.length}（基线 ${EXPECT_PAGES}）`);
  check(blocks.nodes.length === EXPECT_NODES, `节点总数 ${blocks.nodes.length}（基线 ${EXPECT_NODES}）`);

  console.log(failed === 0 ? "\nPASS: 新鲜下载结构校验通过" : `\nFAIL: ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[fresh] 异常:", err);
  process.exit(1);
});