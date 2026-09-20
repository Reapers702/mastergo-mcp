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

/**
 * MasterGo 错误码 → 可操作的中文提示。
 * 网页接口的 code 既有数字（如 10003），也有字符串（如 AccessDenied），实测：
 *   /data 私有文件无 Cookie → 403 {"code":"AccessDenied","message":""}
 *   /api/v1/documents 私有文件无 Cookie → 403 {"code":"NotAllowAnonymousAccess","meta":{"msg":"document not public"}}
 *   fileKey 不存在 → 403 {"code":"AccessDenied","message":""}
 */
const ERROR_HINTS: Record<string, string> = {
  "10003": "MasterGo 权限不足（10003）：请确认账号对目标文件有访问权限，且已开通对应的团队/研发席位。",
  "10016": "MasterGo 缺少访问令牌（10016）：请在 .env 中配置 MG_COOKIE。",
  AccessDenied:
    "MasterGo 拒绝访问（AccessDenied）：Cookie 可能已失效，或当前账号对该文件无权限。" +
    "请从浏览器重新复制 Cookie 更新 .env 中的 MG_COOKIE（注意：非公开文件必须携带有效 Cookie）。",
  NotAllowAnonymousAccess:
    "该文件未公开（NotAllowAnonymousAccess）：需要有效的登录 Cookie。请在 .env 中配置 MG_COOKIE。",
  NoDocumentPermission: "当前账号对该文件无权限（NoDocumentPermission）：请确认文件是否已共享给该账号。",
  NotFoundDocument: "MasterGo 未找到该文件（NotFoundDocument）：请确认 fileId 是否正确、文件是否已被删除。",
};

/**
 * 把错误响应体统一成对象。
 * 关键：/data 请求用 responseType="arraybuffer"，出错时拿到的是 ArrayBuffer/Buffer 而非
 * 已解析的 JSON，直接读 body.code 会得到 undefined，必须先把二进制解码成 JSON。
 */
function normalizeErrorBody(raw: unknown): any {
  if (raw == null) return undefined;
  const isBinary =
    Buffer.isBuffer(raw) || raw instanceof ArrayBuffer || ArrayBuffer.isView(raw);
  if (!isBinary) {
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    }
    return typeof raw === "object" ? raw : undefined;
  }
  try {
    const text = Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw).toString("utf8")
        : Buffer.from((raw as ArrayBufferView).buffer, (raw as ArrayBufferView).byteOffset, (raw as ArrayBufferView).byteLength).toString("utf8");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 提取 MasterGo 接口错误消息（code 10003 权限不足 / AccessDenied Cookie 失效等） */
function toMasterGoError(err: unknown): MasterGoError {
  if (err instanceof AxiosError) {
    const body = normalizeErrorBody(err.response?.data);
    const status = err.response?.status;
    const code = body?.code != null ? String(body.code) : "";

    // 优先级：已知错误码的可操作提示 > 接口原始 message > meta.msg > 状态码兜底 > 原始错误
    let msg = ERROR_HINTS[code];
    if (!msg && typeof body?.message === "string" && body.message.trim()) {
      msg = body.message.trim();
    }
    if (!msg && typeof body?.meta?.msg === "string" && body.meta.msg.trim()) {
      msg = body.meta.msg.trim();
    }
    if (!msg && (status === 401 || status === 403)) {
      msg =
        `MasterGo 鉴权失败（HTTP ${status}）：Cookie 可能已失效或权限不足，` +
        "请从浏览器重新复制 Cookie 更新 .env 中的 MG_COOKIE。";
    }
    if (!msg && code) msg = `MasterGo 错误码 ${code}`;
    if (!msg) msg = err.message;

    return new MasterGoError(msg, { code, status });
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

  /**
   * 拉取 /data/{fileKey} 私有二进制字节。默认全量下载；传 maxBytes 时尝试用 Range 只取前段。
   *
   * 注意（2026-09 实测）：MasterGo 目前**忽略 Range**——带 `Range: bytes=0-8388607` 仍返回
   * HTTP 200 + 完整 content-length（无 content-range / accept-ranges）。因此 maxBytes 实际
   * 拿到的就是完整文件，此时按全量缓存，避免后续 get_page_tree 再下载一遍同一个数十 MB 文件。
   * 同时，/data 响应**不可字节复现**（同一未变动文件连续两次下载可有大面积字节差异，长度相同），
   * 回归对比必须按结构（节点/类型）而非 md5。
   */
  private async fetchData(fileKey: string, maxBytes?: number): Promise<Buffer> {
    // 不在此处前置校验 Cookie：实测 isPublic 文件无需任何认证即可读取（无 Cookie 亦返回 200），
    // 前置拦截会让公开文件的 list_pages / get_page_tree 误失败。私有文件由服务端返回 403，
    // 再由 toMasterGoError 归一化成可操作的中文提示。
    const cacheKey = `full:${fileKey}`;
    const hit = this.fullDataCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.buf;

    const headers: Record<string, string> = { ...this.headers() };
    if (maxBytes) headers["Range"] = `bytes=0-${maxBytes - 1}`;
    let res;
    try {
      res = await this.client.get(`${this.cfg.baseUrl}/data/${fileKey}`, {
        params: { wv: "v3.2.1" },
        headers,
        responseType: "arraybuffer",
      });
    } catch (err) {
      // 必须归一化：/data 的鉴权失败（403 AccessDenied）否则会抛出无提示的原始 axios 错误
      throw toMasterGoError(err);
    }
    const buf = Buffer.from(res.data as ArrayBuffer);

    // 服务端返回 206 才是真的部分内容，此时不可当作全量缓存；
    // 未请求分段、或请求了分段但返回 200（Range 被忽略）都说明拿到的是完整文件。
    const gotFullFile = !maxBytes || res.status !== 206;
    if (gotFullFile) {
      if (this.fullDataCache.size >= MasterGoClient.FULL_DATA_MAX) {
        // 淘汰最旧的
        const oldest = this.fullDataCache.keys().next().value;
        if (oldest !== undefined) this.fullDataCache.delete(oldest);
      }
      this.fullDataCache.set(cacheKey, {
        buf,
        expiresAt: Date.now() + MasterGoClient.FULL_DATA_TTL_MS,
      });
    }
    return buf;
  }

  /**
   * 文件页面列表：GET /data/{fileKey}。
   * 传 8MB 上限是想只取文件头部的页面索引块，但实测服务端**忽略 Range**（返回 200 + 全量），
   * 所以实际仍会下载整个文件——不过该缓冲区会按全量缓存，后续 get_page_tree 直接复用。
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
   * 文件本地 paint 样式列表（颜色样式）：扫描 /data/{fileKey} 二进制中的**样式索引表**。
   *
   * 本文件判定不再只看 ukey 前缀：新编码的 ukey 只存 `+<selfId>`（不含 fileId），
   * 旧编码存 `<fileId>+<selfId>`；两种都支持，外部文件（其他 fileId 前缀）仍被排除。
   *
   * 实测（2026-09）：
   *   - 移动端界面设计（新编码）：38/38 条 id/name/ukey 与浏览器 `getLocalPaintStyles()` 一致，
   *     SOLID 颜色逐值相同
   *   - 火车票（旧编码）：4 条（"渐变" / "f1f4fb" / "1" / "2"），与既有基线一致
   *
   * @param fileKey UUID（如 890c5c78-...），用于拉取 /data 二进制
   * @param fileId 数字 documentId（如 115278536821990），用于判定本文件样式
   */
  async getLocalStyles(fileKey: string, fileId: string): Promise<any> {
    const { listLocalPaintStyles } = await import("./node-tree.js");
    const buf = await this.fetchData(fileKey);
    return listLocalPaintStyles(buf, fileId);
  }

  /**
   * 文件本地文字样式列表（TEXT）。
   *
   * 实测（2026-09 移动端界面设计）：13/13 条 id/name/fontSize/lineHeight 与浏览器
   * `getLocalTextStyles()` 真值完全一致。
   *
   * @param fileKey UUID，用于拉取 /data 二进制
   * @param fileId 数字 documentId，用于判定本文件样式
   */
  async getLocalTextStyles(fileKey: string, fileId: string): Promise<any> {
    const { listLocalTextStyles } = await import("./node-tree.js");
    const buf = await this.fetchData(fileKey);
    return listLocalTextStyles(buf, fileId);
  }

  /**
   * 文件本地效果样式列表（EFFECT）。
   *
   * 实测（2026-09 移动端界面设计）：6/6 条 id/name 与浏览器 `getLocalEffectStyles()` 一致；
   * color（含 alpha）全部一致；radius / offsetY 在二进制中有该字段时全部一致，
   * 字段缺省时为 null（缺省规律未解明，见 node-tree.ts 的 EffectItem 注释）。
   */
  async getLocalEffectStyles(fileKey: string, fileId: string): Promise<any> {
    const { listLocalEffectStyles } = await import("./node-tree.js");
    const buf = await this.fetchData(fileKey);
    return listLocalEffectStyles(buf, fileId);
  }

  /**
   * 文件本地变量（Design Tokens）列表。
   *
   * ⚠️ 实测认知：MasterGo 的「变量」与「样式」是**同一批对象** —— 浏览器真值里
   * getLocalPaintStyles/getLocalTextStyles/getLocalEffectStyles 的 id 集合与
   * variables.getVariables() 的 id 集合双向完全包含。本方法即该索引表的统一视图。
   *
   * 实测（2026-09 移动端界面设计）：57/57 条 id/name/type 与浏览器 `variables.getVariables()` 一致。
   */
  async getLocalVariables(fileKey: string, fileId: string): Promise<any> {
    const { listLocalVariables } = await import("./node-tree.js");
    const buf = await this.fetchData(fileKey);
    return listLocalVariables(buf, fileId);
  }

  /**
   * 文件本地组件（COMPONENT，含组件集 COMPONENT_SET）列表。
   *
   * 实测认知：MasterGo 的「组件」没有独立编码表，本质是「带自引用 ukey 的容器节点」——
   * 组件的 id 就是真实图层节点 id。因此本方法通过扫描 /data 二进制节点记录，判定
   * 几何段内含 `1c 07` 容器块、且该块内含自引用 ukey（`+<selfId>`，无需 fileId 前缀，
   * 格式无关，legacy/modern 通用）节点即为组件；ukey 前缀用于判定是否本文件（isExternal）。
   *
   * @param fileKey UUID，用于拉取 /data 二进制
   * @param fileId 数字 documentId，用于判定本文件组件
   */
  async getLocalComponents(fileKey: string, fileId: string): Promise<any> {
    const { listLocalComponents } = await import("./node-tree.js");
    const buf = await this.fetchData(fileKey);
    return listLocalComponents(buf, fileId);
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
