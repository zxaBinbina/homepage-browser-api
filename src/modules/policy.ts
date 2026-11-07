import type { Env } from "../env.ts";

export function targetUrl(
  value: string,
  env: Pick<Env, "API_ORIGIN" | "BROWSE_ORIGIN">,
  websocket = false,
) {
  if (value.length > 12000) throw new Error("网址过长。");
  const url = new URL(value);
  if (
    !(websocket ? ["ws:", "wss:"] : ["http:", "https:"]).includes(url.protocol)
  )
    throw new Error("只支持 HTTP、HTTPS 或 WebSocket 网址。");
  if (url.username || url.password)
    throw new Error("网址中不能包含用户名或密码。");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const ownHosts = [
    new URL(env.API_ORIGIN).hostname,
    new URL(env.BROWSE_ORIGIN).hostname,
  ];
  if (
    ownHosts.includes(host) ||
    !host.includes(".") ||
    host.startsWith("[") ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|onion|invalid)$/.test(host)
  )
    throw new Error("不能访问此地址。");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split(".").map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      a! >= 224
    )
      throw new Error("不能访问内网或保留地址。");
  }
  url.hash = "";
  return url;
}

export function upstreamHeaders(input: unknown, userAgent?: string) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("请求头格式不正确。");
  const headers = new Headers();
  let size = 0;
  for (const [name, value] of Object.entries(input)) {
    if (
      /^(?:host|connection|upgrade|content-length|transfer-encoding|accept-encoding|forwarded|x-real-ip|proxy-.*|x-forwarded-.*|cf-.*|x-bin-.*|sec-websocket-.*)$/i.test(
        name,
      )
    )
      continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item !== "string") throw new Error("请求头格式不正确。");
      size += name.length + item.length;
      if (size > 48000 || /[\r\n]/.test(item))
        throw new Error("请求头过大或不合法。");
      headers.append(name, item);
    }
  }
  if (userAgent) {
    if (userAgent.length > 512 || /[\r\n]/.test(userAgent))
      throw new Error("设备标识不合法。");
    headers.set("user-agent", userAgent);
    // Do not leave Chromium desktop client hints attached to a simulated mobile UA.
    for (const name of [...headers.keys()])
      if (name.startsWith("sec-ch-ua")) headers.delete(name);
  }
  return headers;
}
