/**
 * MCP 工具实现（基于 MasterGo **网页接口**自研，不依赖官方 MCP 网关 /mcp/*）。
 *
 * 认证：浏览器 Cookie（MG_COOKIE）即可；无需付费席位 / 个人访问令牌。
 * 当前已实现：
 *   - get_file_meta：文件元信息（/api/v1/documents/{id}）
 *   - list_pages：页面列表（解析 /data/{fileKey} 私有二进制索引）
 *   - get_file_nodes：全量节点索引（页面 + 全部名节点的 id/名称，可搜索过滤）
 *   - get_page_tree：节点树（父子层级 + 类型 + 几何/布局属性 + 颜色/描边）
 *   - list_styles：文件本地 paint 样式（颜色样式，按 ukey 筛本文件定义）
 * 更深的读取能力（文字样式 / 效果样式 / 组件库 / 变量 / 导出）将在后续通过网页二进制自研增量加入。
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
        "注意：当前只返回节点的 id 与名称索引，父子层级/类型/几何仍需后续逆向。",
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
        "SLICE/INSTANCE/BOOLEAN_OPERATION；实测类型 100% 与浏览器一致）。" +
        "几何属性 geometry 含可靠的 width/height/opacity/cornerRadius（圆角仅 RECTANGLE）" +
        "与 x/y 坐标（带符号，positionSignResolved 恒为 true）、rotation（角度）/transform（仿射矩阵）、" +
        "fills/strokes（RGBA 纯色，经 paint 定义表解析）、strokeWeight（描边宽度，实测 63/63 与浏览器一致）、" +
        "strokeAlign（描边对齐，实测 776/776 与浏览器一致）、constraints（布局约束 horizontal/vertical，" +
        "实测 546/548 与浏览器一致）、autoLayout（自动布局：flexMode/itemSpacing/padding 四边/" +
        "mainAxisAlignItems/crossAxisAlignItems/mainAxisSizingMode/crossAxisSizingMode；flexMode 实测 " +
        "33024/33061 与浏览器一致，sizingMode 主轴 ≈99.3%、交叉轴 ≈96.7%，仅实例内部节点为 null）。" +
        "颜色仅保证 SOLID 填料（kind='SOLID'）；IMAGE/GRADIENT/UNKNOWN 物件 color 为 null。" +
        "参数 file 传文件 ID 或完整 URL；page 传具体页（可沿用 list_pages 返回的页面 id，或 URL 中 page_id）。",
      params: {
        file: z.string().describe("MasterGo 文件 ID 或完整文件 URL（必填）"),
        page: z
          .string()
          .describe(
            "目标页面的节点 id（必填，形如 10371:87078）。" +
              "可从 list_pages 返回的页面 id 或浏览器 URL 的 page_id 参数获得"
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
        "通过浏览器 Cookie 全量下载 /data/{fileKey} 私有二进制，扫描 paint 样式聚合记录，" +
        "按 ukey 前缀匹配 fileId 筛本文件定义的样式（不含团队库/外部引用）。" +
        "实测（2026-09 火车票文件）：4 个本地 paint 样式的 id/name/ukey/RGBA 颜色全部与" +
        "浏览器 getLocalPaintStyles() API 真值一致（4/4 命中）。" +
        "渐变样式（GRADIENT_LINEAR/RADIAL）目前只标记 kind，渐变 stops 多色解码暂未实现，color 为 null；" +
        "collectionId 默认 'M:1'、collectionName 默认 '集合'（二进制中无独立 collection 表，疑似客户端默认构造）。" +
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
  ];
}