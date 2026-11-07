import { json, type Env } from "./env.ts";
import { login } from "./modules/auth.ts";
import { proxy } from "./modules/proxy.ts";
import { recoveryPage } from "./modules/recovery.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const apiPath = url.pathname.startsWith("/v1/");
    const allowedOrigin =
      origin === env.HOME_ORIGIN || origin === env.BROWSE_ORIGIN;
    const cors = new Headers({
      vary: "Origin",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers":
        "Content-Type, X-Bin-Token, X-Bin-Request",
      "access-control-expose-headers": "X-Bin-Response, Retry-After",
      "access-control-max-age": "600",
    });
    if (allowedOrigin && origin)
      cors.set("access-control-allow-origin", origin);
    if (apiPath && request.method === "OPTIONS")
      return new Response(null, {
        status: allowedOrigin ? 204 : 403,
        headers: cors,
      });
    if (apiPath && !allowedOrigin)
      return json({ error: "不允许此来源。" }, 403);
    let response: Response;
    try {
      if (url.pathname === "/v1/auth/login")
        response = await login(request, env);
      else if (
        url.pathname === "/v1/proxy/http" ||
        url.pathname === "/v1/proxy/ws"
      )
        response = await proxy(request, env);
      else if (url.pathname === "/health")
        response = json({
          service: "bin-api",
          version: "0.1.0",
          modules: ["auth", "proxy"],
        });
      else if (url.origin !== env.BROWSE_ORIGIN)
        response = json({ error: "接口不存在。" }, 404);
      else if (url.pathname === "/reset" && request.method === "GET")
        response = recoveryPage(env);
      else if (url.pathname === "/clear" && request.method === "POST")
        response = new Response(null, {
          status: 204,
          headers: {
            "clear-site-data": '"storage", "cache"',
            "cache-control": "no-store",
          },
        });
      else if (url.pathname === "/config.js")
        response = new Response(
          `globalThis.BIN_CONFIG=${JSON.stringify({ apiOrigin: env.API_ORIGIN, homeOrigin: env.HOME_ORIGIN })};`,
          {
            headers: {
              "content-type": "text/javascript",
              "cache-control": "no-store",
            },
          },
        );
      else if (url.pathname.startsWith("/p/"))
        response = new Response(
          "请从主页工具入口打开网页，并允许此站点使用 Service Worker。",
          {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        );
      else if (
        url.pathname === "/vendor/scramjet/scramjet.wasm.wasm" &&
        request.headers.get("sec-fetch-dest") === "script"
      ) {
        url.pathname = "/vendor/scramjet/wasm.js";
        response = await env.ASSETS.fetch(new Request(url, request));
      } else response = await env.ASSETS.fetch(request);
    } catch {
      response = json({ error: "服务暂时不可用，请稍后重试。" }, 500);
    }
    if (response.status === 101) return response;
    const result = new Response(response.body, response);
    result.headers.set("x-robots-tag", "noindex, nofollow");
    result.headers.set("referrer-policy", "no-referrer");
    result.headers.set("x-content-type-options", "nosniff");
    if (new URL(request.url).pathname === "/vendor/scramjet/scramjet.wasm.wasm")
      result.headers.set("vary", "Sec-Fetch-Dest");
    if (apiPath) cors.forEach((value, name) => result.headers.set(name, value));
    else {
      result.headers.set(
        "content-security-policy",
        `frame-ancestors 'self' ${env.HOME_ORIGIN}; object-src 'none'; base-uri 'self'`,
      );
      if (!result.headers.has("cache-control"))
        result.headers.set("cache-control", "no-cache");
    }
    return result;
  },
} satisfies ExportedHandler<Env>;
