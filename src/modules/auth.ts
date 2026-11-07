import { json, type Env } from "../env.ts";

const encoder = new TextEncoder();
export const encode = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export const decode = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
export const hash = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const key = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
export interface Session {
  exp: number;
  iat: number;
  id: string;
  scope: "proxy";
}

export async function issueSession(
  env: Env,
  now = Math.floor(Date.now() / 1000),
) {
  const session: Session = {
    iat: now,
    exp:
      now + Math.min(3600, Math.max(60, Number(env.SESSION_SECONDS) || 3600)),
    id: crypto.randomUUID(),
    scope: "proxy",
  };
  const payload = encode(encoder.encode(JSON.stringify(session)));
  const sig = await crypto.subtle.sign(
    "HMAC",
    await key(env.AUTH_SIGNING_KEY),
    encoder.encode(payload),
  );
  return {
    token: `${payload}.${encode(new Uint8Array(sig))}`,
    expiresAt: session.exp * 1000,
  };
}

export async function verifySession(
  token: string | null,
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<Session | null> {
  try {
    if (!token || token.length > 1024 || !env.AUTH_SIGNING_KEY) return null;
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await key(env.AUTH_SIGNING_KEY),
        decode(signature),
        encoder.encode(payload),
      ))
    )
      return null;
    const s = JSON.parse(new TextDecoder().decode(decode(payload))) as Session;
    return s.scope === "proxy" &&
      typeof s.id === "string" &&
      Number.isFinite(s.exp) &&
      Number.isFinite(s.iat) &&
      s.iat <= now &&
      s.exp > now &&
      s.exp - s.iat <= 3600
      ? s
      : null;
  } catch {
    return null;
  }
}

export function desktopSupported(ua: string) {
  return (
    /Windows NT|Linux/.test(ua) &&
    /Chrome\/|Chromium\/|Edg\//.test(ua) &&
    !/Android|Mobile|iPhone|iPad|iPod/i.test(ua)
  );
}

export async function login(request: Request, env: Env) {
  if (request.method !== "POST")
    return json({ error: "请使用 POST 请求。" }, 405);
  if (request.headers.get("origin") !== env.HOME_ORIGIN)
    return json({ error: "此入口不能进行认证。" }, 403);
  if (!desktopSupported(request.headers.get("user-agent") || ""))
    return json(
      {
        error:
          "抱歉，暂不支持此设备。请使用 Windows 或 Linux 上的 Chrome / Edge。",
      },
      403,
    );
  if (!env.AUTH_PASSWORD_HASH || !env.AUTH_SIGNING_KEY)
    return json({ error: "服务尚未配置访问密码。" }, 503);
  const ip = request.headers.get("cf-connecting-ip") || "local";
  if (!(await env.LOGIN_LIMIT.limit({ key: ip })).success)
    return json({ error: "尝试次数较多，请一分钟后再试。" }, 429, {
      "retry-after": "60",
    });
  if (Number(request.headers.get("content-length") || 0) > 2048)
    return json({ error: "请求过大。" }, 413);
  const raw = await request.text();
  if (raw.length > 2048) return json({ error: "请求过大。" }, 413);
  let password: unknown;
  try {
    password = JSON.parse(raw).password;
  } catch {
    return json({ error: "请求格式不正确。" }, 400);
  }
  if (typeof password !== "string" || password.length > 256)
    return json({ error: "密码不正确。" }, 401);
  const actual = await hash(password);
  let difference = actual.length ^ env.AUTH_PASSWORD_HASH.length;
  for (let i = 0; i < actual.length; i++)
    difference |=
      actual.charCodeAt(i) ^ (env.AUTH_PASSWORD_HASH.charCodeAt(i) || 0);
  if (difference) return json({ error: "密码不正确。" }, 401);
  return json(await issueSession(env));
}
