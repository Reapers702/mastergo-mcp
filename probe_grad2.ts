// 探针：确认火车票文件里是否有真渐变（决定逆向主战场）
import { readFileSync } from "node:fs";
import { listLocalPaintStyles } from "./src/node-tree.js";

const FILE_ID = "115278536821990";
const buf = readFileSync(".cache/train_ticket.bin");
console.log("bytes:", buf.length);

// 1. 火车票本地 paint 样式（含 kind）
const styles = listLocalPaintStyles(buf, FILE_ID);
console.log("paint styles:", styles.length);
for (const s of styles) {
  console.log(JSON.stringify({ id: s.id, name: s.name, kind: s.paints[0].kind, color: s.paints[0].color }));
}

// 2. 看节点级 fill 真值里有没有渐变
const t = JSON.parse(readFileSync("test/fixtures/train_ticket_truth.json", "utf8"));
console.log("truth keys:", Object.keys(t), "count:", t.count);
let nGrad = 0, gradSamples: any[] = [];
const walk = (o: any) => {
  if (!o) return;
  if (Array.isArray(o)) { o.forEach(walk); return; }
  if (typeof o === "object") {
    const s = JSON.stringify(o);
    if (/GRADIENT/i.test(s) && s.length < 3000) { gradSamples.push(o); nGrad++; }
    Object.values(o).forEach(walk);
  }
};
walk(t);
console.log("gradient-shaped truth objects:", nGrad);
for (const g of gradSamples.slice(0, 6)) console.log("  ", JSON.stringify(g));