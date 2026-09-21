/**
 * diff 自检：验证 src/diff.ts 的纯 diff 逻辑（不依赖网络 / 真值 / 二进制）。
 *
 * 运行：
 *   npm run test:diff        （即 npx tsx scripts/verify-diff.ts）
 *
 * 覆盖：id 匹配（同文件版本）、path 匹配（跨文件同构）、ignore 字段、max_changes 截断。
 */
import { diffTrees } from "../src/diff.ts";
import type { TreeNode } from "../src/node-tree.ts";

let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) console.log(`ok   ${msg}`);
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
}

function node(id: string, name: string, parent: string | null, type: string | null, x = 0, y = 0): TreeNode {
  return {
    id,
    name,
    parent,
    typeRaw: null,
    anchor: null,
    type,
    geometry: {
      width: 100,
      height: 50,
      opacity: null,
      cornerRadius: null,
      x,
      y,
      positionSignResolved: true,
      rotation: 0,
      transform: { tx: x, ty: y, m00: 1, m01: 0, m10: 0, m11: 1 },
      fills: [],
      strokes: [],
      strokeWeight: null,
      strokeAlign: null,
      constraints: null,
      autoLayout: null,
    },
  };
}

// ---- 用例 1：id 匹配（同文件不同版本）----
{
  const A = [
    node("P", "页面", null, "PAGE"),
    node("N1", "按钮", "P", "RECTANGLE", 0, 0),
    node("N2", "旧文本", "P", "TEXT", 10, 20),
  ];
  const B = [
    node("P", "页面", null, "PAGE"),
    node("N1", "按钮", "P", "RECTANGLE", 16, 0), // x 0→16
    node("N3", "新文本", "P", "TEXT", 10, 20), // 替换 N2
  ];
  const r = diffTrees(A, B, { matchBy: "id", maxChanges: 0 });
  check(r.totalA === 3 && r.totalB === 3, "id: 两侧各 3 节点");
  check(r.removed === 1 && r.added === 1 && r.changed === 1 && r.unchanged === 1, "id: removed=1 added=1 changed=1 unchanged=1");
  const ch = r.changes.find((c) => c.change === "changed")!;
  check(ch?.key === "N1" && ch?.fields?.[0]?.path === "geometry.x" && ch.fields[0].old === 0 && ch.fields[0].new === 16, "id: N1 的 geometry.x 0→16");
  check(r.changes.some((c) => c.change === "removed" && c.key === "N2" && c.nodeIdA === "N2"), "id: N2 为 removed");
  check(r.changes.some((c) => c.change === "added" && c.key === "N3" && c.nodeIdB === "N3"), "id: N3 为 added");
}

// ---- 用例 2：path 匹配（跨文件，id 完全不同但结构同名）----
{
  const A = [
    node("p:1", "页面", null, "PAGE"),
    node("a:1", "头部", "p:1", "FRAME", 0, 0),
    node("a:2", "标题", "a:1", "TEXT", 4, 4),
    node("a:3", "列表", "p:1", "FRAME", 0, 80),
    node("a:4", "第一项", "a:3", "RECTANGLE", 0, 0),
    node("a:5", "第一项", "a:3", "RECTANGLE", 0, 24), // 重名兄弟，靠 #n 消歧
  ];
  const B = [
    node("q:1", "页面", null, "PAGE"),
    node("b:1", "头部", "q:1", "FRAME", 0, 0),
    node("b:2", "标题", "b:1", "TEXT", 4, 4),
    node("b:3", "列表", "q:1", "FRAME", 0, 80),
    node("b:4", "第一项", "b:3", "RECTANGLE", 2, 0), // x 0→2
    node("b:5", "第一项", "b:3", "RECTANGLE", 0, 24),
  ];
  const r = diffTrees(A, B, { matchBy: "path", maxChanges: 0 });
  check(r.removed === 0 && r.added === 0, "path: 无 removed/added（重名兄弟 #n 消歧生效）");
  check(r.changed === 1 && r.unchanged === 5, "path: changed=1（b:4 的 x）unchanged=5");
  const ch = r.changes.find((c) => c.change === "changed")!;
  check(ch.nodeIdA === "a:4" && ch.nodeIdB === "b:4" && ch.fields?.[0]?.path === "geometry.x", "path: 匹配到 a:4↔b:4 且 geometry.x 变化");
}

// ---- 用例 3：ignore 字段 ----
{
  const A = [node("P", "页面", null, "PAGE"), node("N1", "按钮", "P", "RECTANGLE", 0, 0)];
  const B = [node("P", "页面", null, "PAGE"), node("N1", "按钮", "P", "RECTANGLE", 99, 0)];
  // x 变化会同时体现在 geometry.x 与 geometry.transform.tx，两者一起忽略
  const r = diffTrees(A, B, { matchBy: "id", ignore: ["geometry.x", "geometry.transform.tx"], maxChanges: 0 });
  check(r.changed === 0 && r.unchanged === 2, "ignore: ['geometry.x', 'geometry.transform.tx'] 后 changed=0");
  const r2 = diffTrees(A, B, { matchBy: "id", ignore: ["geometry"], maxChanges: 0 });
  check(r2.changed === 0, "ignore: ['geometry'] 后 changed=0");
}

// ---- 用例 4：max_changes 截断 ----
{
  const A = [node("P", "页面", null, "PAGE"), node("N1", "一", "P", "RECTANGLE", 0, 0), node("N2", "二", "P", "RECTANGLE", 0, 0), node("N3", "三", "P", "RECTANGLE", 0, 0)];
  const B = [node("P", "页面", null, "PAGE"), node("N1", "一", "P", "RECTANGLE", 5, 0), node("N2", "二", "P", "RECTANGLE", 5, 0), node("N3", "三", "P", "RECTANGLE", 5, 0)];
  const r = diffTrees(A, B, { matchBy: "id", maxChanges: 2 });
  check(r.truncated === true && r.changes.length === 2, "maxChanges=2: truncated 且只返回 2 条");
  check(r.changed === 3, "maxChanges=2: 汇总计数仍是真实值 3");
}

console.log(failed === 0 ? "\nPASS: verify-diff 全部通过" : `\nFAIL: ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
