/**
 * MasterGo HTTP 客户端。
 *
 * 数据源分两类：
 *   A. 网页 API（/api/v1/...、/data/...）：浏览器会话使用，Cookie 认证即可，部分接口也支持令牌；
 *   B. /mcp/* 网关接口（/mcp/meta、/mcp/dsl、/mcp/design-sections、/mcp/page-layers）：
 *      官方 Magic MCP 同款，返回结构化 JSON DSL，必须携带 X-MG-UserAccessToken。
 *
 * 认证优先级：个人访问令牌 > Cookie。
 */

import axios, { AxiosError } from "axios";
import type { Config } from "./config.js";

const DEFAULT_TIMEOUT = 120_000;

// ---- 响应类型（宽松，字段以服务端为准） ----
export interface DslResponse {
  [key: string]: any;
}

export interface DesignSectionsResponse {
  sections?: any[];
  totalSections?: number;
  rootMetadata?: { allTexts?: string[]; width?: number; height?: number; [k: string]: any };
  rootContainer?: { minHeight?: string; width?: string; [k: string]: any };
  splitContainers?: any[];
  allTexts?: string[];
  dsl?: any;
  nodeCount?: number;
  [k: string]: any;
}

export interface PageLayersResponse {
  fileId: string;
  pageLayerId: string;
  pageName?: string;
  totalLayers: number;
  layers: Array<{
    id: string;
    name: string;
    type: string;
    depth: number;
    parentId?: string;
    childrenCount: number;
    width?: number;
    height?: number;
  }>;
  partial?: boolean;
  message?: string;
  [k: string]: any;
}

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
    if (e.code === "10016") {
      e.message = "需要 MasterGo 个人访问令牌：请配置 MG_MCP_TOKEN（或 --token），" +
        "或在请求头 x-mg-useraccesstoken 传入有效令牌。当前请求未携带令牌。";
    }
    if (e.code === "10003") {
      e.message = "MasterGo 权限不足（10003）：请确认账号对目标文件有访问权限，" +
        "且已开通 API 所需席位（团队版/研发席位）。";
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

  hasToken(): boolean {
    return Boolean(this.cfg.token);
  }

  private assertToken(method: string): void {
    if (!this.hasToken()) {
      throw new MasterGoError(
        `接口 ${method} 需要 MasterGo 个人访问令牌：请在个人设置 → 安全设置 → 个人访问令牌 生成，` +
          `并通过环境变量 MG_MCP_TOKEN 或参数 --token 传入。Cookie 仅能访问网页 API。`
      );
    }
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

  /**
   * 文件页面索引：GET /data/{fileKey}?wv=v3.0.0（部分下载）。
   * 返回 MasterGo 私有二进制 DSL，页面块集中在文件头部，
   * 这里仅拉取前 PAGE_INDEX_BYTES 字节解析页面列表，避免下载全量（可能数十 MB）。
   */
  async getFilePageList(fileKey: string): Promise<Array<{ id: string; name: string }>> {
    const { parsePageBlocks } = await import("./page-index.js");
    if (!this.cfg.cookie && !this.cfg.token) {
      throw new MasterGoError("list_pages 的网页索引模式需要配置浏览器 Cookie（MG_COOKIE）");
    }
    const maxBytes = 8 * 1024 * 1024; // 前 8MB 通常已覆盖全部页面块
    const res = await this.client.get(`${this.cfg.baseUrl}/data/${fileKey}`, {
      params: { wv: "v3.0.0" },
      headers: { ...this.headers(), Range: `bytes=0-${maxBytes - 1}` },
      responseType: "arraybuffer",
    });
    const buf = Buffer.from(res.data as ArrayBuffer);
    return parsePageBlocks(buf);
  }

  // ---- /mcp/* 网关接口（需要令牌） ----

  /** 节点 DSL：GET /mcp/dsl?fileId&layerId */
  getDsl(fileId: string, layerId: string, sourceLayerId?: string): Promise<DslResponse> {
    this.assertToken("mcp/dsl");
    const params: Record<string, any> = { fileId, layerId };
    if (sourceLayerId) params.sourceLayerId = sourceLayerId;
    return withCache(`dsl:${fileId}:${layerId}`, () =>
      this.request({ method: "GET", path: "/mcp/dsl", params })
    );
  }

  /** 分区 DSL 列表/单片：GET /mcp/design-sections?fileId&layerId[&sectionIndex] */
  getDesignSections(
    fileId: string,
    layerId: string,
    sectionIndex?: number,
    fromPageParam?: boolean
  ): Promise<DesignSectionsResponse> {
    this.assertToken("mcp/design-sections");
    const params: Record<string, any> = { fileId, layerId };
    if (sectionIndex !== undefined) params.sectionIndex = sectionIndex;
    if (fromPageParam) params.fromPageParam = "true";
    const key = `sections:${fileId}:${layerId}:${sectionIndex ?? "list"}`;
    return withCache(key, () => this.request({ method: "GET", path: "/mcp/design-sections", params }));
  }

  /** 页面图层枚举：GET /mcp/page-layers?fileId&layerId */
  getPageLayers(fileId: string, layerId: string): Promise<PageLayersResponse> {
    this.assertToken("mcp/page-layers");
    return withCache(`page-layers:${fileId}:${layerId}`, () =>
      this.request({ method: "GET", path: "/mcp/page-layers", params: { fileId, layerId } })
    );
  }

  /** 元数据：GET /mcp/meta?fileId&layerId */
  getMeta(fileId: string, layerId: string, sourceLayerId?: string): Promise<any> {
    this.assertToken("mcp/meta");
    const params: Record<string, any> = { fileId, layerId };
    if (sourceLayerId) params.sourceLayerId = sourceLayerId;
    return withCache(`meta-mcp:${fileId}:${layerId}`, () =>
      this.request({ method: "GET", path: "/mcp/meta", params })
    );
  }
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
