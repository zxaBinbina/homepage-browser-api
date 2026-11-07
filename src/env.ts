export interface Env {
  ASSETS: Fetcher;
  API_ORIGIN: string;
  BROWSE_ORIGIN: string;
  HOME_ORIGIN: string;
  SESSION_SECONDS: string;
  AUTH_PASSWORD_HASH: string;
  AUTH_SIGNING_KEY: string;
  LOGIN_LIMIT: RateLimit;
  PROXY_LIMIT: RateLimit;
  // Only provided by the local regression runner; never configured in production.
  TEST_UPSTREAM?: string;
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
      ...headers,
    },
  });
}
