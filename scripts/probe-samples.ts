import { readFileSync } from "node:fs";
import { parsePageBlocks } from "../src/page-index.ts";
import { parsePageTree, listLocalPaintStyles, listLocalTextStyles, listLocalEffectStyles } from "../src/node-tree.ts";

for (const [f, fileId] of [["proto_wireframe", "96410525459654"], ["miniapp_proto", "99512140822728"], ["antd5", "205140012617682"]] as const) {
  const buf = readFileSync(`.cache/${f}.bin`);
  const pages = parsePageBlocks(buf);
  let total = 0;
  const typeCount = new Map<string, number>();
  const pageSizes: Array<[string, number]> = [];
  for (const p of pages) {
    const tree = parsePageTree(buf, p.id);
    pageSizes.push([p.name, tree.nodes.length]);
    total += tree.nodes.length;
    for (const n of tree.nodes) {
      const t = n.type ?? "null";
      typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
    }
  }
  pageSizes.sort((a, b) => b[1] - a[1]);
  const paints = listLocalPaintStyles(buf, fileId);
  const texts = listLocalTextStyles(buf, fileId);
  const effects = listLocalEffectStyles(buf, fileId);
  console.log(`\n==== ${f} ====`);
  console.log(`pages=${pages.length} totalNodes=${total}`);
  console.log(`top pages: ${pageSizes.slice(0, 5).map(([n, c]) => `${n}(${c})`).join(" ")}`);
  console.log(`types: ${[...typeCount.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}:${c}`).join(" ")}`);
  console.log(`paint=${paints.length} text=${texts.length} effect=${effects.length}`);
  const grad = paints.filter((p) => p.paints?.some((pp) => pp.kind === "GRADIENT")).length;
  console.log(`gradientStyles=${grad}`);
  if (f === "miniapp_proto") {
    const buf = readFileSync(`.cache/${f}.bin`);
    const tree = parsePageTree(buf, pages[0].id);
    const nulls = tree.nodes.filter((n) => n.type === null);
    console.log(`null 节点样例:`);
    for (const n of nulls.slice(0, 12)) {
      console.log(`  ${n.id} name=${JSON.stringify(n.name)} typeRaw=${JSON.stringify(n.typeRaw)} parent=${n.parent}`);
    }
  }
}
