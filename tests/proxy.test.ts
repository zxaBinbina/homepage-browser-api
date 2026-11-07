import { test } from "node:test";
import assert from "node:assert/strict";
import {
  issueSession,
  verifySession,
  encode,
  hash,
  login,
  desktopSupported,
} from "../src/modules/auth.ts";
import { targetUrl, upstreamHeaders } from "../src/modules/policy.ts";
import { proxy } from "../src/modules/proxy.ts";
import worker from "../src/index.ts";
import { bingLite, isBingLite, parseBingFeed } from "../src/modules/bing.ts";
import type { Env } from "../src/env.ts";

const env = {
  API_ORIGIN: "https://api.example.org",
  BROWSE_ORIGIN: "https://browse.example.org",
  HOME_ORIGIN: "https://home.example.org",
  AUTH_SIGNING_KEY: "test-key-not-a-deployment-secret",
  AUTH_PASSWORD_HASH: await hash("test-password"),
  SESSION_SECONDS: "3600",
  LOGIN_LIMIT: { limit: async () => ({ success: true }) },
  PROXY_LIMIT: { limit: async () => ({ success: true }) },
  ASSETS: { fetch: async () => new Response("asset") },
} as unknown as Env;
const pack = (value: unknown) =>
  encode(new TextEncoder().encode(JSON.stringify(value)));

test("proxy tokens reject tampering and expiration and have a one-hour bound", async () => {
  const { token } = await issueSession(env, 100);
  assert.equal((await verifySession(token, env, 101))?.scope, "proxy");
  assert.equal(await verifySession(token, env, 3700), null);
  assert.equal(await verifySession(token, env, 99), null);
  assert.equal(await verifySession(token + ".extra", env, 101), null);
  assert.equal(
    await verifySession(token.slice(0, -8) + "AAAAAAAA", env, 101),
    null,
  );
  assert.equal(await verifySession("invalid", env), null);
});
test("private targets, alternate numeric IPs, credentials and service recursion are rejected", () => {
  for (const value of [
    "http://127.0.0.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://10.1.2.3",
    "http://172.16.1.1",
    "http://169.254.169.254",
    "http://100.64.0.1",
    "http://192.168.1.1",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "https://localhost.",
    "https://device.internal",
    "https://api.example.org",
    "https://browse.example.org",
    "ftp://example.com",
    "https://user:secret@example.com",
  ])
    assert.throws(() => targetUrl(value, env), value);
  assert.equal(
    targetUrl("https://cn.bing.com/search?q=test#result", env).href,
    "https://cn.bing.com/search?q=test",
  );
  assert.equal(
    targetUrl("wss://example.com:9443/connect", env, true).port,
    "9443",
  );
});
test("upstream headers preserve target cookies without forwarding proxy headers", () => {
  const headers = upstreamHeaders(
    {
      cookie: "site=value",
      authorization: "Bearer target-only",
      "x-bin-token": "do-not-forward",
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "1.2.3.4",
      "sec-ch-ua-mobile": "?0",
      host: "bad.example",
    },
    "test-mobile",
  );
  assert.equal(headers.get("cookie"), "site=value");
  assert.equal(headers.get("authorization"), "Bearer target-only");
  for (const key of [
    "host",
    "cf-connecting-ip",
    "x-forwarded-for",
    "x-bin-token",
    "sec-ch-ua-mobile",
  ])
    assert.equal(headers.get(key), null);
  assert.throws(() => upstreamHeaders({ test: "x\r\ny: z" }));
});
test("unsupported devices, bad passwords, disallowed origins and rate limits fail closed", async () => {
  const ua = "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0";
  const request = (password: string, origin = env.HOME_ORIGIN, agent = ua) =>
    new Request(`${env.API_ORIGIN}/v1/auth/login`, {
      method: "POST",
      headers: { origin, "user-agent": agent },
      body: JSON.stringify({ password }),
    });
  assert.equal(
    desktopSupported("Mozilla/5.0 (Linux; Android 14) Chrome/131.0.0.0 Mobile"),
    false,
  );
  assert.equal((await login(request("wrong"), env)).status, 401);
  assert.equal(
    (await login(request("test-password", "https://evil.example"), env)).status,
    403,
  );
  assert.equal(
    (await login(request("test-password", undefined, "Mobile"), env)).status,
    403,
  );
  assert.equal(
    (
      await login(request("test-password"), {
        ...env,
        LOGIN_LIMIT: { limit: async () => ({ success: false }) } as RateLimit,
      })
    ).status,
    429,
  );
  const response = await login(request("test-password"), env);
  assert.equal(response.status, 200);
  assert.ok(
    await verifySession(
      ((await response.json()) as { token: string }).token,
      env,
    ),
  );
  assert.equal(
    (await worker.fetch(request("test-password", "https://evil.example"), env))
      .status,
    403,
  );
});
test("HTTP transport keeps redirects manual, cookies separate and streams range bodies", async () => {
  const { token } = await issueSession(env);
  let calls = 0;
  const fake = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), "https://example.com/file");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("range"), "bytes=0-3");
    const h = new Headers({
      "content-type": "video/mp4",
      "content-range": "bytes 0-3/20",
    });
    h.append("set-cookie", "a=1; Path=/; HttpOnly");
    h.append("set-cookie", "b=2; Path=/");
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 206,
      headers: h,
    });
  };
  const request = () =>
    new Request(`${env.API_ORIGIN}/v1/proxy/http`, {
      method: "POST",
      headers: {
        "x-bin-token": token,
        "x-bin-request": pack({
          url: "https://example.com/file",
          method: "GET",
          headers: { range: "bytes=0-3" },
        }),
      },
    });
  const response = await proxy(request(), env, fake as typeof fetch);
  const metadata = JSON.parse(atob(response.headers.get("x-bin-response")!));
  assert.equal(metadata.status, 206);
  assert.equal(metadata.headers["set-cookie"].length, 2);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(
    [...new Uint8Array(await response.arrayBuffer())],
    [1, 2, 3, 4],
  );
  const noAuth = request();
  noAuth.headers.delete("x-bin-token");
  assert.equal((await proxy(noAuth, env, fake as typeof fetch)).status, 401);
  assert.equal(calls, 1);
});
test("malformed proxy metadata is rejected and cleanup is isolated from the API host", async () => {
  const response = await proxy(
    new Request(`${env.API_ORIGIN}/v1/proxy/http`, {
      method: "POST",
      headers: { "x-bin-request": pack(null) },
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.equal(
    (
      await worker.fetch(
        new Request(env.API_ORIGIN + "/clear", { method: "POST" }),
        env,
      )
    ).status,
    404,
  );
  const clear = await worker.fetch(
    new Request(env.BROWSE_ORIGIN + "/clear", { method: "POST" }),
    env,
  );
  assert.equal(clear.status, 204);
  assert.equal(clear.headers.get("clear-site-data"), '"storage", "cache"');
  const reset = await worker.fetch(
    new Request(env.BROWSE_ORIGIN + "/reset"),
    env,
  );
  assert.equal(reset.status, 200);
  assert.equal(reset.headers.get("clear-site-data"), '"storage", "cache"');
  assert.equal(reset.headers.get("cache-control"), "no-store");
  assert.equal(
    (await worker.fetch(new Request(env.API_ORIGIN + "/reset"), env)).status,
    404,
  );
});

test("Bing RSS fallback is opt-in, escapes content and rejects unsafe result links", async () => {
  const url = new URL(
    "https://www.bing.com/search?bin_view=lite&q=%3Cscript%3Etest%3C%2Fscript%3E",
  );
  assert.equal(isBingLite(url, "GET"), true);
  assert.equal(
    isBingLite(new URL("https://www.bing.com/search?q=test"), "GET"),
    false,
  );
  assert.equal(
    isBingLite(new URL("https://evil.example/search?bin_view=lite"), "GET"),
    false,
  );
  const xml =
    "<rss><channel><item><title>&lt;img src=x onerror=alert(1)&gt;</title><link>https://example.com/?a=1&amp;b=2</link><description><![CDATA[<b>public result</b>]]></description></item><item><title>bad</title><link>javascript:alert(1)</link></item></channel></rss>";
  assert.equal(parseBingFeed(xml).length, 1);
  assert.equal(parseBingFeed(xml)[0].url, "https://example.com/?a=1&b=2");
  assert.throws(() => parseBingFeed("<html>error</html>"));
  const response = await bingLite(
    url,
    new Headers({ cookie: "private=1", authorization: "private" }),
    new AbortController().signal,
    (async (target: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(new URL(String(target)).searchParams.get("format"), "rss");
      assert.equal(new Headers(init?.headers).get("cookie"), null);
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      return new Response(xml);
    }) as typeof fetch,
  );
  const html = await response.text();
  assert.ok(html.includes("&lt;script&gt;test&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!html.includes("javascript:alert"));
  assert.equal(response.headers.get("cache-control"), "no-store");
});
