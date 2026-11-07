import { json, type Env } from "../env.ts";
import { decode, verifySession } from "./auth.ts";
import { targetUrl, upstreamHeaders } from "./policy.ts";
import { bingLite, isBingLite } from "./bing.ts";

export type Upstream = typeof fetch;
function unpack(value: string | null) {
  if (!value || value.length > 65000) throw new Error("请求参数不合法。");
  return JSON.parse(new TextDecoder().decode(decode(value)));
}

export async function proxy(
  request: Request,
  env: Env,
  upstream: Upstream = fetch,
) {
  const ws = new URL(request.url).pathname === "/v1/proxy/ws";
  let meta: {
    url: string;
    method: string;
    headers: Record<string, string | string[]>;
    ua?: string;
    token?: string;
    protocols?: string[];
  };
  try {
    if (ws) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return json({ error: "需要 WebSocket 连接。" }, 426);
      const protocol = request.headers
        .get("sec-websocket-protocol")
        ?.split(",")
        .map((p) => p.trim())
        .find((p) => p.startsWith("bin."));
      meta = unpack(protocol?.slice(4) || null);
    } else {
      if (request.method !== "POST")
        return json({ error: "请使用 POST 请求。" }, 405);
      meta = unpack(request.headers.get("x-bin-request"));
    }
    if (!meta || typeof meta !== "object" || Array.isArray(meta))
      throw new Error("invalid metadata");
  } catch {
    return json({ error: "请求参数不合法。" }, 400);
  }
  const session = await verifySession(
    ws ? meta.token || null : request.headers.get("x-bin-token"),
    env,
  );
  if (!session) return json({ error: "访问已过期，请重新输入密码。" }, 401);
  if (!(await env.PROXY_LIMIT.limit({ key: session.id })).success)
    return json({ error: "请求较多，请稍后重试。" }, 429, {
      "retry-after": "60",
    });
  let url: URL, headers: Headers;
  try {
    if (typeof meta.url !== "string") throw new Error("网址不正确。");
    url = targetUrl(meta.url, env, ws);
    headers = upstreamHeaders(meta.headers || {}, meta.ua);
    if (
      !ws &&
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        meta.method,
      )
    )
      throw new Error("不支持此请求方法。");
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "请求不合法。" },
      400,
    );
  }
  // A test fixture can only be enabled by deployment configuration, never by a request.
  if (env.TEST_UPSTREAM && url.hostname === "fixture.test")
    url = new URL(url.pathname + url.search, env.TEST_UPSTREAM);
  if (ws) {
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    headers.set("upgrade", "websocket");
    if (meta.protocols?.length)
      headers.set("sec-websocket-protocol", meta.protocols.join(", "));
  }
  try {
    const response =
      !ws && isBingLite(url, meta.method)
        ? await bingLite(url, headers, request.signal, upstream)
        : await upstream(url, {
            method: ws ? "GET" : meta.method,
            headers,
            body:
              ws || ["GET", "HEAD"].includes(meta.method)
                ? undefined
                : request.body,
            redirect: "manual",
            signal: request.signal,
          });
    if (ws) {
      if (!response.webSocket || response.status !== 101) {
        await response.body?.cancel();
        return json({ error: "目标网站未接受实时连接。" }, 502);
      }
      // Native coupling: media packets do not run a JavaScript message handler.
      const resultHeaders = new Headers();
      const protocol = response.headers.get("sec-websocket-protocol");
      const transportProtocol = request.headers
        .get("sec-websocket-protocol")
        ?.split(",")
        .map((p) => p.trim())
        .find((p) => p.startsWith("bin."));
      if (protocol || transportProtocol)
        resultHeaders.set(
          "sec-websocket-protocol",
          protocol || transportProtocol!,
        );
      return new Response(null, {
        status: 101,
        webSocket: response.webSocket,
        headers: resultHeaders,
      });
    }
    const remoteHeaders: Record<string, string | string[]> = {};
    response.headers.forEach((value, name) => {
      if (
        ![
          "set-cookie",
          "content-encoding",
          "transfer-encoding",
          "connection",
        ].includes(name)
      )
        remoteHeaders[name] = value;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) remoteHeaders["set-cookie"] = cookies;
    // Content length can change after the platform decompresses an upstream response.
    delete remoteHeaders["content-length"];
    const metadata = new TextEncoder().encode(
      JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        headers: remoteHeaders,
      }),
    );
    if (metadata.length > 60000) {
      await response.body?.cancel();
      return json({ error: "目标网站的响应头过大。" }, 502);
    }
    const packed = btoa(String.fromCharCode(...metadata));
    return new Response(response.body, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "x-bin-response": packed,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return json({ error: "暂时无法连接目标网站，请重试。" }, 502);
  }
}
