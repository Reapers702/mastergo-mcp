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
