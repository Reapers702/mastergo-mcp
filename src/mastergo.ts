/**
 * MasterGo HTTP 客户端。
 *
 * 完全基于 MasterGo 网页接口（/api/v1/...、/data/...）自研实现，
 * 不依赖官方 MCP 网关（/mcp/*，需付费席位）。浏览器登录态（Cookie）即可访问。
 */

import axios, { AxiosError } from "axios";
import type { Config } from "./config.js";

const DEFAULT_TIMEOUT = 120_000;

export class MasterGoError extends Error {
  code?: string;
  status?: number;
  constructor(message: string, opts?: { code?: string; status?: number }) {
    super(message);
    this.name = "MasterGoError";
    this.code = opts?.code;
    this.status = opts?.status;
  }
}

/** 提取 MasterGo 接口错误消息（code 10003 权限不足 / 10016 缺令牌等） */
function toMasterGoError(err: unknown): MasterGoError {
  if (err instanceof AxiosError) {
    const body: any = err.response?.data;
    const msg =
      typeof body?.message === "string"
        ? body.message
        : body?.code
          ? `MasterGo 错误码 ${body.code}`
          : err.message;
    const e = new MasterGoError(msg, {
      code: String(body?.code ?? ""),
      status: err.response?.status,
    });
    if (e.code === "10003") {
      e.message = "MasterGo 权限不足（10003）：请确认账号对目标文件有访问权限，" +
        "且已开通对应的团队/研发席位。";
    }
    return e;
  }
  if (err instanceof Error) return new MasterGoError(err.message);
  return new MasterGoError(String(err));
}

// ---- 5 分钟 LRU 缓存 + in-flight 去重 ----
const CACHE_MAX = 64;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: any; expiresAt: number }>();
const inflight = new Map<string, Promise<any>>();

function getCached(key: string): any | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry); // LRU promote
  return entry.value;
}

function setCached(key: string, value: any): void {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function withCache<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const cached = getCached(key);
  if (cached !== undefined) return cached;
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fetcher()
    .then((v) => {
      setCached(key, v);
      return v;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export class MasterGoClient {
  private client = axios.create({
    timeout: DEFAULT_TIMEOUT,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
  });

  constructor(private cfg: Config) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.cfg.token) h["X-MG-UserAccessToken"] = this.cfg.token;
    if (this.cfg.cookie) h["Cookie"] = this.cfg.cookie;
    return h;
  }

  private async request<T>(config: {
    method: "GET" | "POST";
    path: string;
    params?: Record<string, any>;
    data?: any;
  }): Promise<T> {
    try {
      const res = await this.client.request<T>({
        method: config.method,
        url: `${this.cfg.baseUrl}${config.path}`,
        params: config.params,
        data: config.data,
        headers: this.headers(),
      });
      return res.data;
    } catch (err) {
      throw toMasterGoError(err);
    }
  }

  // ---- 网页 API ----

  /** 文件元信息：GET /api/v1/documents/{fileId}?pageName=file */
  getFileMeta(fileId: string): Promise<any> {
    return withCache(`meta:${fileId}`, () =>
      this.request({ method: "GET", path: `/api/v1/documents/${fileId}`, params: { pageName: "file" } })
    );
  }

  // 全量 /data 二进制的专用缓存（可能数十 MB，只缓存少量条目避免内存膨胀）
  private fullDataCache = new Map<string, { buf: Buffer; expiresAt: number }>();
  private static readonly FULL_DATA_MAX = 2;
  private static readonly FULL_DATA_TTL_MS = 5 * 60 * 1000;

  /** 拉取 /data/{fileKey} 私有二进制字节。默认全量下载；传 maxBytes 时用 Range 只取前段。 */
  private async fetchData(fileKey: string, maxBytes?: number): Promise<Buffer> {
    if (!this.cfg.cookie && !this.cfg.token) {
      throw new MasterGoError("读取 /data 网页二进制需要浏览器 Cookie（MG_COOKIE）");
    }
    const cacheKey = `full:${fileKey}`;
    if (!maxBytes) {
      const hit = this.fullDataCache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) return hit.buf;
    }
    const headers: Record<string, string> = { ...this.headers() };
    if (maxBytes) headers["Range"] = `bytes=0-${maxBytes - 1}`;
    const res = await this.client.get(`${this.cfg.baseUrl}/data/${fileKey}`, {
      params: { wv: "v3.2.1" },
      headers,
      responseType: "arraybuffer",
    });
    const buf = Buffer.from(res.data as ArrayBuffer);
    if (!maxBytes) {
      if (this.fullDataCache.size >= MasterGoClient.FULL_DATA_MAX) {
        // 淘汰最旧的
        const oldest = this.fullDataCache.keys().next().value;
        if (oldest !== undefined) this.fullDataCache.delete(oldest);
      }
      this.fullDataCache.set(cacheKey, { buf, expiresAt: Date.now() + MasterGoClient.FULL_DATA_TTL_MS });
    }
    return buf;
  }

  /**
   * 文件页面列表：GET /data/{fileKey}（部分下载，前 8MB 已覆盖文件头部的页面索引块）。
   */
  async getFilePageList(fileKey: string): Promise<Array<{ id: string; name: string }>> {
    const { parsePageBlocks } = await import("./page-index.js");
    const buf = await this.fetchData(fileKey, 8 * 1024 * 1024);
    return parsePageBlocks(buf);
  }

  /**
   * 文件页面 + 全量节点索引：GET /data/{fileKey}（全量下载）。
   * 说明：绝大多数图层/节点记录位于 8MB 之后，因此此处必须全量拉取（可能数十 MB）。
   */
  async getFileNodes(fileKey: string): Promise<{
    pages: Array<{ id: string; name: string }>;
    nodes: Array<{ id: string; name: string }>;
  }> {
    const { parseNodeBlocks } = await import("./node-index.js");
    const buf = await this.fetchData(fileKey);
    const parsed = parseNodeBlocks(buf);
    return { pages: parsed.pages, nodes: parsed.nodes };
  }

  /**
   * 指定页面的节点树（父子层级 + 名称 + id）。
   * 全量下载 /data/{fileKey} 后，依据节点记录 02=parent 字段重建以 pageId 为根的树。
   */
  async getPageTree(fileKey: string, pageId: string): Promise<any> {
    const { parsePageTree } = await import("./node-tree.js");
    const buf = await this.fetchData(fileKey);
    return parsePageTree(buf, pageId);
  }

  /**
   * 文件本地 paint 样式列表（颜色样式）：扫描 /data/{fileKey} 二进制中所有 paint 样式
   * 聚合记录，按 ukey 前缀匹配 fileId 筛本文件定义的样式（不含团队库/外部引用）。
   *
   * 实测（2026-09 火车票文件）：返回 4 个本地 paint 样式，id/name/ukey/RGBA 颜色
   * 全部与浏览器 getLocalPaintStyles() API 真值一致（4/4 命中）。
   *
   * @param fileKey UUID（如 890c5c78-...），用于拉取 /data 二进制
   * @param fileId 数字 documentId（如 115278536821990），用于筛 ukey 前缀
   */
  async getLocalStyles(fileKey: string, fileId: string): Promise<any> {
    const { listLocalPaintStyles } = await import("./node-tree.js");
    const buf = await this.fetchData(fileKey);
    return listLocalPaintStyles(buf, fileId);
  }

  // ---- /mcp/* 网关接口已完全移除（不依赖官方 MCP，走纯网页 API 自研） ----
}

/** 从 MasterGo URL / 短链解析 fileId、layerId */
export function extractIdsFromUrl(
  url: string
): { fileId: string; layerId?: string } {
  const u = new URL(url);
  const segments = u.pathname.split("/");
  const fileId = segments.find((s) => /^\d+$/.test(s));
  const layerId = u.searchParams.get("layer_id") || u.searchParams.get("page_id") || undefined;
  if (!fileId) throw new MasterGoError(`无法从 URL 解析 fileId：${url}`);
  return { fileId, layerId };
}
