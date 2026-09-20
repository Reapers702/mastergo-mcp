/**
 * MCP 工具实现（基于 MasterGo **网页接口**自研，不依赖官方 MCP 网关 /mcp/*）。
 *
 * 认证：浏览器 Cookie（MG_COOKIE）即可；无需付费席位 / 个人访问令牌。
 * 当前已实现（8 个）：
 *   - get_file_meta：文件元信息（/api/v1/documents/{id}）
 *   - list_pages：页面列表（解析 /data/{fileKey} 私有二进制索引）
 *   - get_file_nodes：全量节点索引（页面 + 全部名节点的 id/名称，可搜索过滤）
 *   - get_page_tree：节点树（父子层级 + 类型 + 几何/布局属性 + 颜色/描边）
 *   - list_styles：文件本地颜色样式（PAINT）
 *   - list_text_styles：文件本地文字样式（TEXT）
 *   - list_effect_styles：文件本地效果样式（EFFECT，阴影/模糊）
 *   - list_variables：文件本地变量（Design Tokens；实测与「样式」是同一批对象）
 * 仍待加入：组件库（COMPONENT/COMPONENT_SET）、图片/切图导出。
 *
 * 样式与变量共用一张「样式索引表」，其类型判别式是记录内的 `05 <n>`：
 * n=1 → PAINT、n=2 → EFFECT、n=3 → TEXT（实测 57/57 纯净）。详见 node-tree.ts。
 */

import { z } from "zod";
import type { MasterGoClient } from "./mastergo.js";
import { MasterGoError, extractIdsFromUrl } from "./mastergo.js";

export interface ToolDef {
  name: string;
  description: string;
  params: z.ZodRawShape;
  run: (client: MasterGoClient, args: Record<string, unknown>) => Promise<string>;
}

function normalize(fileIdOrUrl: string): { fileId: string; layerId?: string } {
  if (/^https?:\/\//.test(fileIdOrUrl)) return extractIdsFromUrl(fileIdOrUrl);
  return { fileId: fileIdOrUrl };
}

function jsonOut(data: unknown, indent = 2): string {
  return JSON.stringify(data, null, indent);
}

export function buildTools(): ToolDef[] {
  return [
    {
      name: "get_file_meta",
      description:
        "获取 MasterGo 设计文件的元信息（名称、团队、所属项目、fileKey、权限等）。" +
        "参数 file 可传文件 ID（如 115278536821990）或完整 URL（https://mastergo.com/file/{id}）。" +
        "认证：浏览器 Cookie（MG_COOKIE）即可。",
      params: {
        file: z
          .string()
          .describe("MasterGo 文件 ID 或完整文件 URL（必填）"),
      },
      run: async (client, args) => {
        const { fileId } = normalize(String(args.file));
        const data = await client.getFileMeta(fileId);
        const pick: Record<string, unknown> = {
          id: data.data?.id,
          name: data.data?.name,
          teamId: data.data?.teamId,
          projectId: data.data?.projectId,
          fileKey: data.data?.fileKey,
          owner: data.data?.ownerName,
          createAt: data.data?.createAt,
          updateAt: data.data?.updateAt,
          docRole: data.data?.docRole,
          permissions: data.data?.permissions,
        };
        return jsonOut(pick);
      },
    },

    {
      name: "list_pages",
      description:
        "列出 MasterGo 设计文件中的页面列表（页面 ID + 页面名）。" +
        "通过浏览器 Cookie 访问 /data/{fileKey} 私有二进制，解析文件头部页面索引块获取。" +
        "参数 file 可传文件 ID 或完整 URL。",
      params: {
        file: z.string().describe("MasterGo 文件 ID 或完整文件 URL（必填）"),
      },
      run: async (client, args) => {
        const { fileId } = normalize(String(args.file));
        const meta = await client.getFileMeta(fileId);
        const fileKey: string | undefined = meta.data?.fileKey;
        if (!fileKey) throw new MasterGoError("无法获取 fileKey，请检查文件 ID 与访问权限");
        const pages = await client.getFilePageList(fileKey);
        return jsonOut({ source: "web-data-index", fileId, fileKey, totalPages: pages.length, pages });
      },
    },

    {
      name: "get_file_nodes",
      description:
        "列出 MasterGo 设计文件的全量节点索引（页面 + 全部名节点）。" +
        "通过浏览器 Cookie 全量下载 /data/{fileKey} 私有二进制并解析得出（可能需下载数十 MB）。" +
        "绝大多数图层/节点记录位于文件头部 8MB 之后，因此这是读取节点/图层的第一步。" +
        "可选参数 search 按节点名子串过滤，limit 限制返回条数。" +
        "注意：本工具只返回节点的 id 与名称索引；需要类型/父子层级/几何请用 get_page_tree。",
      params: {
        file: z.string().describe("MasterGo 文件 ID 或完整文件 URL（必填）"),
        search: z
          .string()
          .optional()
          .describe("节点名子串过滤（可选），例如搜索某个页面/组件名"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe("最多返回的节点条数（可选，默认 200；0 表示不限制则返回全部，可能较大）"),
      },
      run: async (client, args) => {
        const { fileId } = normalize(String(args.file));
        const meta = await client.getFileMeta(fileId);
        const fileKey: string | undefined = meta.data?.fileKey;
        if (!fileKey) throw new MasterGoError("无法获取 fileKey，请检查文件 ID 与访问权限");

        const { pages, nodes } = await client.getFileNodes(fileKey);
        const search = args.search ? String(args.search) : undefined;
        const limit = typeof args.limit === "number" ? args.limit : 200;

        const filtered = search
          ? nodes.filter((n) => n.name.includes(search))
          : nodes;
        const matched = filtered.length;
        const output = limit > 0 ? filtered.slice(0, limit) : filtered;

        return jsonOut({
          source: "web-data-node-index",
          fileId,
          fileKey,
          totalPages: pages.length,
          totalNodes: nodes.length,
          search,
          matched,
          returned: output.length,
          pages,
          nodes: output,
        });
      },
    },

    {
      name: "get_page_tree",
      description:
        "获取指定页面的节点树：节点 id、名称、类型、父节点 id、几何/布局属性、父子层级结构（可遍历整棵图层树）。" +
        "通过浏览器 Cookie 全量下载 /data/{fileKey} 私有二进制，依据节点记录 02=parent 重建层级、" +
        "依据几何段首个 1c 子块字节判别节点类型（TEXT/FRAME/GROUP/RECTANGLE/ELLIPSE/LINE/PEN/" +
        "SLICE/INSTANCE/BOOLEAN_OPERATION），并自动适配 MasterGo 先后使用过的两套容器编码：" +
        "legacy（早期文件）实测 828/829 = 99.9%；modern（较新文件）只解出实测精确的 " +
        "GROUP/COMPONENT/COMPONENT_SET/INSTANCE，其余容器返回 null 而不猜错。" +
        "几何属性 geometry 含可靠的 width/height/opacity/cornerRadius（圆角仅 RECTANGLE）" +
        "与 x/y 坐标（带符号，positionSignResolved 恒为 true）、rotation（角度）/transform（仿射矩阵）、" +
        "fills/strokes（RGBA 纯色，经 paint 定义表解析）、strokeWeight（描边宽度，实测 63/63 与浏览器一致）、" +
        "strokeAlign（描边对齐，实测 776/776 与浏览器一致）、constraints（布局约束 horizontal/vertical，" +
        "实测 546/548 与浏览器一致）、autoLayout（自动布局：flexMode/itemSpacing/padding 四边/" +
        "mainAxisAlignItems/crossAxisAlignItems/mainAxisSizingMode/crossAxisSizingMode；实测（Ant Design 5.0，" +
        "73620 条布局真值）flexMode 33302/33339 = 99.89%、主轴对齐 100%、itemSpacing 与 padding ≈98%、" +
        "主轴 sizingMode 99.37%、交叉轴 sizingMode 96.57%；实例内部节点 autoLayout 为 null，继承母版）。" +
        "颜色仅保证 SOLID 填料（kind='SOLID'）；IMAGE/GRADIENT/UNKNOWN 物件 color 为 null。" +
        "参数 file 传文件 ID 或完整 URL；page 可省略（自动采用 URL 中的 page_id / layer_id，" +
        "或用 list_pages 返回的页面 id）。",
      params: {
        file: z.string().describe("MasterGo 文件 ID 或完整文件 URL（必填）"),
        page: z
          .string()
          .optional()
          .describe(
            "目标页面的节点 id（形如 10371:87078）。**可省略**——省略时自动采用 file URL 中的 " +
              "page_id / layer_id；若 URL 也未带，请先用 list_pages 取页面 id"
          ),
        depth: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("向下展开的层数，默认完整展开到全部子节点"),
      },
      run: async (client, args) => {
        const { fileId, layerId } = normalize(String(args.file));
        const meta = await client.getFileMeta(fileId);
        const fileKey: string | undefined = meta.data?.fileKey;
        if (!fileKey) throw new MasterGoError("无法获取 fileKey，请检查文件 ID 与访问权限");
        const pageId = String(args.page || layerId);
        if (!pageId) {
          throw new MasterGoError("缺少 page 参数：请用 list_pages 拿到目标页面 id，或从 URL 的 page_id 传入");
        }
        const tree = await client.getPageTree(fileKey, pageId);

        // 按需裁剪为浅层结构，避免一次性输出过大
        const metaById = new Map<string, any>(tree.nodes.map((n: any) => [n.id, n]));
        const outNodes: Array<Record<string, unknown>> = [];
        const maxDepth = typeof args.depth === "number" ? args.depth : Infinity;
        const walk = (id: string, d: number) => {
          if (d > maxDepth) return;
          const n = metaById.get(id);
          outNodes.push({
            id,
            name: n?.name ?? "",
            type: n?.type ?? null,
            parent: n?.parent ?? null,
            geometry: n?.geometry ?? null,
          });
          for (const c of tree.children[id] ?? []) walk(c.id, d + 1);
        };
        walk(pageId, 0);

        return jsonOut({
          source: "web-data-node-tree",
          fileId,
          fileKey,
          pageId,
          totalNodes: tree.nodes.length,
          maxDepth: maxDepth === Infinity ? "full" : maxDepth,
          nodes: outNodes,
        });
      },
    },

    {
      name: "list_styles",
      description:
        "列出 MasterGo 文件本地 paint 样式（颜色样式）：id、名称、collection、ukey、paint 颜色等。" +
        "通过浏览器 Cookie 全量下载 /data/{fileKey} 私有二进制，扫描样式索引表，" +
        "按记录内 `05 <n>` 判类型、按 ukey 判定是否本文件（不含团队库/外部引用）。" +
        "支持 MasterGo 的两套 ukey 编码：新编码只存 `+<selfId>`（无 fileId 前缀），旧编码存 `<fileId>+<selfId>`。" +
        "实测（2026-09）：移动端界面设计（新编码）38/38 条 id/name/ukey 与浏览器 getLocalPaintStyles() " +
        "真值一致、SOLID 颜色逐值相同；火车票（旧编码）4 条，与既有基线一致。" +
        "渐变样式（GRADIENT_LINEAR/RADIAL）目前只标记 kind，渐变 stops 多色解码暂未实现，color 为 null；" +
        "collectionId 默认 'M:1'、collectionName 默认 '集合'（真值 getCollections() 证实 M:1 即本文件的" +
        "默认变量集合，而非客户端凭空构造）。" +
        "参数 file 传文件 ID 或完整 URL。",
      params: {
        file: z.string().describe("MasterGo 文件 ID 或完整文件 URL（必填）"),
      },
      run: async (client, args) => {
        const { fileId } = normalize(String(args.file));
        const meta = await client.getFileMeta(fileId);
        const fileKey: string | undefined = meta.data?.fileKey;
        if (!fileKey) throw new MasterGoError("无法获取 fileKey，请检查文件 ID 与访问权限");
        const styles = await client.getLocalStyles(fileKey, fileId);
        return jsonOut({
          source: "web-data-style-index",
          fileId,
          fileKey,
          totalStyles: styles.length,
          styles,
        });
      },
    },

    {
      name: "list_text_styles",
      description:
        "列出 MasterGo 文件本地文字样式（TEXT）：id、名称、ukey、字体名、字号、行高、字体 hash。" +
        "通过浏览器 Cookie 全量下载 /data/{fileKey} 私有二进制，扫描样式索引表中 `05 03` 记录" +
        "（`05 <n>` 是类型判别式：1=颜色样式 / 2=效果样式 / 3=文字样式），" +
        "再解析记录内的文字子块（`03 字体名` / `04 紧凑浮点 fontSize` / `05 紧凑浮点 lineHeight` / " +
        "`0c PostScript 名` / `0f 字体 hash`）。" +
        "实测（2026-09 移动端界面设计）：13/13 条 id/name/fontSize/lineHeight 与浏览器 " +
        "getLocalTextStyles() 真值完全一致。" +
        "⚠️ fontName 的 family 由 PostScript 名按最后一个 `-` 拆分，可能是**压缩形式**" +
        "（二进制存 OpenSans，真值 API 返回 'Open Sans'）；需要精确字体名时请用 fontPostScriptName。" +
        "参数 file 传文件 ID 或完整 URL。",
      params: {
        file: z.string().describe("MasterGo 文件 ID 或完整文件 URL（必填）"),
      },
      run: async (client, args) => {
        const { fileId } = normalize(String(args.file));
        const meta = await client.getFileMeta(fileId);
        const fileKey: string | undefined = meta.data?.fileKey;
        if (!fileKey) throw new MasterGoError("无法获取 fileKey，请检查文件 ID 与访问权限");
        const styles = await client.getLocalTextStyles(fileKey, fileId);
        return jsonOut({
          source: "web-data-style-index",
          fileId,
          fileKey,
          totalStyles: styles.length,
          styles,
        });
      },
    },

    {
      name: "list_effect_styles",
      description:
        "列出 MasterGo 文件本地效果样式（EFFECT，阴影/模糊）：id、名称、ukey、颜色与模糊半径。" +
        "通过浏览器 Cookie 全量下载 /data/{fileKey} 私有二进制，扫描样式索引表中 `05 02` 记录" +
        "（`05 <n>` 是类型判别式：1=颜色 / 2=效果 / 3=文字），再从「效果定义表」取具体数值。" +
        "效果定义表条目格式：`01 <effectId> 02 <refId> 03 61 <c> 00 04 00 05 <n> 08 <alpha><R><G><B> " +
        "[09 <radius>] [0b <offsetY>] 0e 01 00`（0 值用单字节 `00`，非 0 用 4 字节紧凑浮点）。" +
        "实测（2026-09 移动端界面设计）：6/6 条 id/name 与浏览器 getLocalEffectStyles() 一致；" +
        "color（含 alpha）全部一致；radius / offsetY 在有该字段时全部一致。" +
        "⚠️ 已知局限：`09`/`0b` 会**整字段缺省**，且缺省不等于 0（实测有 offsetY=4 却无 `0b` 的条目），" +
        "缺省规律在现有 6 个样式上无法确定，故按「宁可判空也不猜错」输出 null。" +
        "offsetX / spread / type（DROP_SHADOW 等）尚未取样到非默认值，暂不输出。" +
        "参数 file 传文件 ID 或完整 URL。",
      params: {
        file: z.string().describe("MasterGo 文件 ID 或完整文件 URL（必填）"),
      },
      run: async (client, args) => {
        const { fileId } = normalize(String(args.file));
        const meta = await client.getFileMeta(fileId);
        const fileKey: string | undefined = meta.data?.fileKey;
        if (!fileKey) throw new MasterGoError("无法获取 fileKey，请检查文件 ID 与访问权限");
        const styles = await client.getLocalEffectStyles(fileKey, fileId);
        return jsonOut({
          source: "web-data-style-index",
          fileId,
          fileKey,
          totalStyles: styles.length,
          styles,
        });
      },
    },

    {
      name: "list_variables",
      description:
        "列出 MasterGo 文件本地变量（Design Tokens）：id、名称、type（PAINT/EFFECT/TEXT）、collection、ukey、颜色。" +
        "⚠️ 实测认知（纠正旧文档）：MasterGo 的「变量」与「样式」是**同一批对象**——浏览器真值中 " +
        "getLocalPaintStyles/getLocalTextStyles/getLocalEffectStyles 的 id 集合与 variables.getVariables() " +
        "的 id 集合双向完全包含（本文件各 57 个），变量 type 分布恰为 {PAINT:38, EFFECT:6, TEXT:13}。" +
        "即样式 API 是「按 type 过滤的视图」，本工具是「统一视图」。" +
        "实测（2026-09 移动端界面设计）：57/57 条 id/name/type 与浏览器 variables.getVariables() 真值一致。" +
        "collectionId 为 'M:1'、collectionName 为 '集合'（真值 getCollections() 证实 M:1 即本文件的默认变量集合，" +
        "模式 id 为 'M:2'，二者都是真实 id，而非客户端凭空构造）。" +
        "未输出：scopes（二进制内未定位到该字段，不猜）、codeSyntax、多模式值。" +
        "参数 file 传文件 ID 或完整 URL。",
      params: {
        file: z.string().describe("MasterGo 文件 ID 或完整文件 URL（必填）"),
      },
      run: async (client, args) => {
        const { fileId } = normalize(String(args.file));
        const meta = await client.getFileMeta(fileId);
        const fileKey: string | undefined = meta.data?.fileKey;
        if (!fileKey) throw new MasterGoError("无法获取 fileKey，请检查文件 ID 与访问权限");
        const variables = await client.getLocalVariables(fileKey, fileId);
        return jsonOut({
          source: "web-data-variable-index",
          fileId,
          fileKey,
          totalVariables: variables.length,
          variables,
        });
      },
    },
  ];
}