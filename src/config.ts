/**
 * 运行时配置：认证方式支持「个人访问令牌」与「浏览器 Cookie」两种。
 *
 * 优先级：
 *   1. 命令行参数（--token / --cookie / --url）
 *   2. 环境变量（MG_MCP_TOKEN / MG_COOKIE / MG_BASE_URL）
 */

export interface Config {
  /** MasterGo 个人访问令牌（形如 mg_xxxx），请求时放入 X-MG-UserAccessToken 请求头 */
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

export function loadConfig(): Config {
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

  if (!token && !cookie) {
    console.error(
      "[warn] 未配置认证：请设置 MG_MCP_TOKEN（个人访问令牌）或 MG_COOKIE（浏览器 Cookie）。" +
        "部分接口（/mcp/* 网关）需要令牌，网页 API 可用 Cookie。"
    );
  }
  return { token, cookie, baseUrl: baseUrl.replace(/\/+$/, "") };
}
