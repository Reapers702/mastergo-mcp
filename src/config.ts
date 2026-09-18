/**
 * 运行时配置：认证方式支持「个人访问令牌」与「浏览器 Cookie」两种。
 *
 * 配置来源与优先级：
 *   1. 命令行参数（--token / --cookie / --url）
 *   2. 环境变量（MG_COOKIE / MG_BASE_URL；MG_MCP_TOKEN 仅向后兼容保留，通常无需配置）
 *   3. 根目录 .env / .env.local（测试期便于配置，已忽略提交；正式环境可用环境变量）
 */
import fs from "node:fs";
import path from "node:path";

export interface Config {
  /** 可选。旧版用于官方 /mcp/* 网关；现网页 API 自研模式下通常无需配置，若配置会作为附加请求头发送 */
  token?: string;
  /** 浏览器登录后的 Cookie 字符串（如 gfsessionid=xxx; ...），请求时放入 Cookie 请求头 */
  cookie?: string;
  /** API 基础地址，默认 https://mastergo.com */
  baseUrl: string;
}

function parseArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

/** 轻量 .env 解析：支持注释行、export 前缀、引号包裹、行内注释 */
function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let val = line.slice(eq + 1).trim();
    // 去掉成对引号
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    } else {
      // 无引号时截掉行内注释（' #' 开头）
      const hash = val.search(/\s+#/);
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    if (key) out[key] = val;
  }
  return out;
}

/** 从 cwd 根目录加载 .env.local / .env 到 process.env；不覆盖已存在的环境变量 */
function loadDotEnv(): void {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(process.cwd(), name);
    if (!fs.existsSync(file)) continue;
    const entries = parseDotEnv(fs.readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(entries)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}

export function loadConfig(): Config {
  loadDotEnv();
  const token =
    parseArg("--token") ||
    parseArg("--access-token") ||
    process.env.MG_MCP_TOKEN ||
    process.env.MASTERGO_API_TOKEN;
  const cookie = parseArg("--cookie") || process.env.MG_COOKIE;
  const baseUrl =
    parseArg("--url") ||
    process.env.MG_BASE_URL ||
    process.env.API_BASE_URL ||
    "https://mastergo.com";

  if (!cookie) {
    console.error(
      "[warn] 未配置认证：请设置 MG_COOKIE（浏览器 Cookie）。" +
        "当前 MCP 完全基于 MasterGo 网页接口自研，无需个人访问令牌 / 付费席位。"
    );
  }
  return { token, cookie, baseUrl: baseUrl.replace(/\/+$/, "") };
}
