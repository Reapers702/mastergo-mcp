/**
 * MCP 工具实现（第一阶段：读取设计稿数据）。
 *
 * 认证依赖：
 *   - get_file_meta / list_pages：网页 API，个人令牌或 Cookie 均可；
 *   - get_design_sections / get_page_layers / get_node_dsl：/mcp/* 网关，需要个人访问令牌。
 */

import { z } from "zod";
import type { MasterGoClient } from "./mastergo.js";
import { MasterGoError, extractIdsFromUrl } from "./mastergo.js";
import { loadConfig } from "./config.js";

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
        "认证：个人令牌或浏览器 Cookie 均可。",
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
        "参数 file 可传文件 ID 或完整 URL。认证：优先使用个人令牌（走 /mcp/* 网关）；" +
        "未配置令牌时会用浏览器 Cookie 解析文件页面索引（要求文件可访问）。",
      params: {
        file: z.string().describe("MasterGo 文件 ID 或完整文件 URL（必填）"),
      },
      run: async (client, args) => {
        const { fileId, layerId } = normalize(String(args.file));
        // 优先走 /mcp/* 网关（令牌）：分区列表本身即为设计分区
        if (client.hasToken() && layerId) {
          const data = await client.getDesignSections(fileId, layerId);
          const sections = Array.isArray(data.sections)
            ? data.sections.map((s: any) => ({
                id: s.id,
                name: s.name,
                type: s.type,
                nodeCount: s.nodeCount,
                textPreview: s.textPreview,
                bbox: s.x !== undefined ? { x: s.x, y: s.y, width: s.width, height: s.height } : undefined,
              }))
            : [];
          return jsonOut({
            source: "mcp/design-sections",
            fileId,
            totalSections: data.totalSections,
            pages: sections,
          });
        }
        // 兜底：Cookie 解析文件页面索引（网页二进制 DSL 头部块）
        const meta = await client.getFileMeta(fileId);
        const fileKey: string | undefined = meta.data?.fileKey;
        if (!fileKey) throw new MasterGoError("无法获取 fileKey，请检查文件 ID 与访问权限");
        const pages = await client.getFilePageList(fileKey);
        return jsonOut({ source: "web-data-index", fileId, fileKey, pages });
      },
    },

    {
      name: "get_design_sections",
      description:
        "获取设计稿的分区（section）数据。这是读取设计稿内容的主工具，需要个人访问令牌（MG_MCP_TOKEN）。" +
        "工作流：先不带 sectionIndex 调用得到分区列表（含每个分区的坐标、节点数、文本预览），" +
        "再按 sectionIndex=0..N-1 逐个调用获取每个分区的完整 DSL（图层、样式、文本）。" +
        "参数 file 可传文件 ID 或 URL（URL 中需含 page_id 或 layer_id）。",
      params: {
        file: z
          .string()
          .describe("MasterGo 文件 ID 或完整 URL（含 ?page_id= 或 ?layer_id=，必填）"),
        sectionIndex: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("分区序号（0 起）。省略时返回分区列表，指定时返回该分区的完整 DSL"),
        format: z
          .enum(["json", "compact"])
          .optional()
          .describe("输出格式：json 缩进 / compact 紧凑（默认 json）"),
      },
      run: async (client, args) => {
        const { fileId, layerId } = normalize(String(args.file));
        if (!layerId) {
          throw new MasterGoError("无法从 URL/参数解析 layerId：请提供含 ?page_id= 或 ?layer_id= 的 URL");
        }
        const si = args.sectionIndex as number | undefined;
        const data = await client.getDesignSections(fileId, layerId, si);
        const compact = args.format === "compact";
        if (si === undefined) {
          const sections = Array.isArray(data.sections)
            ? data.sections.map((s: any) => ({
                id: s.id,
                name: s.name,
                type: s.type,
                nodeCount: s.nodeCount,
                textPreview: s.textPreview,
                x: s.x,
                y: s.y,
                width: s.width,
                height: s.height,
              }))
            : [];
          return jsonOut({
            fileId,
            layerId,
            totalSections: data.totalSections,
            totalNodes: data.nodeCount,
            rootMetadata: data.rootMetadata,
            sections,
          }, compact ? 0 : 2);
        }
        return jsonOut(data, compact ? 0 : 2);
      },
    },

    {
      name: "get_page_layers",
      description:
        "枚举指定页面（page_id / layer_id）下的全部图层摘要列表（id、name、type、depth、childrenCount、宽高）。" +
        "用于「枚举 → 逐个还原」工作流：先拿到页面下可还原的顶层图层 ID，再按 layer_id 逐个读取 DSL。" +
        "需要个人访问令牌（MG_MCP_TOKEN）。",
      params: {
        file: z
          .string()
          .describe("MasterGo 文件 ID 或完整 URL（必填）"),
        layerId: z
          .string()
          .optional()
          .describe("页面/图层 ID（如 10371:87078）。缺省时尝试从 URL 的 page_id/layer_id 解析"),
      },
      run: async (client, args) => {
        const { fileId, layerId: urlLayer } = normalize(String(args.file));
        const layerId = (args.layerId as string | undefined) || urlLayer;
        if (!layerId) {
          throw new MasterGoError("无法确定 layerId：请传 layerId 参数或提供含 ?page_id=/?layer_id= 的 URL");
        }
        const data = await client.getPageLayers(fileId, layerId);
        return jsonOut({
          fileId: data.fileId,
          pageLayerId: data.pageLayerId,
          pageName: data.pageName,
          totalLayers: data.totalLayers,
          partial: data.partial,
          layers: data.layers,
        });
      },
    },

    {
      name: "get_node_dsl",
      description:
        "获取单个节点（图层）的完整 DSL 数据。作为分区工作流的回退工具，返回数据量较大。" +
        "需要个人访问令牌（MG_MCP_TOKEN）。",
      params: {
        file: z
          .string()
          .describe("MasterGo 文件 ID 或完整 URL（必填）"),
        layerId: z
          .string()
          .optional()
          .describe("图层 ID（如 802:02364）。缺省时尝试从 URL 的 layer_id 解析"),
      },
      run: async (client, args) => {
        const { fileId, layerId: urlLayer } = normalize(String(args.file));
        const layerId = (args.layerId as string | undefined) || urlLayer;
        if (!layerId) {
          throw new MasterGoError("无法确定 layerId：请传 layerId 参数或提供含 ?layer_id= 的 URL");
        }
        const data = await client.getDsl(fileId, layerId);
        return jsonOut(data);
      },
    },
  ];
}

// 供 index.ts 复用配置
export { loadConfig };
