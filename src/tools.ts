/**
 * MCP 工具实现（基于 MasterGo **网页接口**自研，不依赖官方 MCP 网关 /mcp/*）。
 *
 * 认证：浏览器 Cookie（MG_COOKIE）即可；无需付费席位 / 个人访问令牌。
 * 当前已实现：
 *   - get_file_meta：文件元信息（/api/v1/documents/{id}）
 *   - list_pages：页面列表（解析 /data/{fileKey} 私有二进制索引）
 * 更深的读取能力（节点树 / 组件 / 样式 / 导出）将在后续通过网页二进制自研增量加入。
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
  ];
}