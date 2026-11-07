// Opt-in reader for Bing's public RSS search feed; regular Bing pages stay intact.
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
      (entity, key: string) => {
        if (key.startsWith("#")) {
          const code =
            key[1].toLowerCase() === "x"
              ? parseInt(key.slice(2), 16)
              : Number(key.slice(1));
          return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
        }
        return (
          (
            { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<
              string,
              string
            >
          )[key.toLowerCase()] || entity
        );
      },
    );
}

export function parseBingFeed(xml: string) {
  if (xml.length > 262144 || !/<rss\b/i.test(xml))
    throw new Error("搜索服务返回了无法识别的内容，请稍后重试。");
  const results = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const field = (name: string) =>
      decodeXml(
        new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(
          match[1],
        )?.[1] || "",
      ).trim();
    try {
      const url = new URL(field("link"));
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        continue;
      results.push({
        title: field("title"),
        url: url.href,
        description: field("description").replace(/<[^>]*>/g, ""),
      });
      if (results.length === 20) break;
    } catch {
      /* Ignore malformed feed links. */
    }
  }
  return results;
}

export function isBingLite(url: URL, method: string) {
  return (
    method === "GET" &&
    ["cn.bing.com", "www.bing.com"].includes(url.hostname) &&
    url.pathname === "/search" &&
    url.searchParams.get("bin_view") === "lite"
  );
}

export async function bingLite(
  url: URL,
  headers: Headers,
  signal: AbortSignal,
  upstream: typeof fetch,
): Promise<Response> {
  const query = (url.searchParams.get("q") || "").slice(0, 500);
  let results: ReturnType<typeof parseBingFeed> = [],
    error = "";
  if (query.trim()) {
    try {
      const feed = new URL("https://www.bing.com/search");
      feed.searchParams.set("q", query);
      feed.searchParams.set("format", "rss");
      const response = await upstream(feed, {
        headers: {
          accept: "application/rss+xml, application/xml",
          "user-agent": headers.get("user-agent") || "Mozilla/5.0",
          "accept-language": "zh-CN,zh;q=0.9",
        },
        redirect: "manual",
        signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("搜索服务暂时不可用，请稍后重试。");
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 262144) {
            await reader.cancel();
            throw new Error("搜索结果过大，请缩小搜索范围。");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      results = parseBingFeed(new TextDecoder().decode(bytes));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "搜索服务暂时不可用。";
    }
  }
  const cards = results
    .map(
      (item) =>
        `<article><h2><a href="${escapeHtml(item.url)}">${escapeHtml(item.title || item.url)}</a></h2><p class="url">${escapeHtml(item.url)}</p><p>${escapeHtml(item.description)}</p></article>`,
    )
    .join("");
  const original = new URL("https://www.bing.com/search");
  original.searchParams.set("q", query);
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bing 简洁搜索</title><style>
  :root{color-scheme:light dark;font:16px/1.65 system-ui,sans-serif}body{max-width:850px;margin:0 auto;padding:36px 24px}h1{font-size:30px;margin:0 0 8px}h2{font-size:20px;margin:0}p{margin:8px 0}a{color:light-dark(#165dab,#83c4ff)}form{display:flex;gap:10px;margin:28px 0}input,button{font:inherit;padding:10px 14px;border:1px solid #8a95a5;border-radius:10px}input{min-width:0;flex:1}button{cursor:pointer}article{margin:28px 0}.caption,.url{font-size:13px;opacity:.75}.url{overflow-wrap:anywhere}footer{border-top:1px solid #8a95a566;margin-top:36px;padding-top:16px}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #469dec;outline-offset:3px}</style></head><body>
  <header><h1>Bing 简洁搜索</h1><p class="caption">使用 Bing 的公开 RSS 搜索结果，点击链接继续在中转中浏览。</p></header>
  <form action="https://www.bing.com/search" method="get"><input type="hidden" name="bin_view" value="lite"><input type="search" name="q" aria-label="搜索关键词" value="${escapeHtml(query)}" maxlength="500" placeholder="输入搜索关键词" required><button type="submit">搜索</button></form>
  <main>${error ? `<p role="alert">${escapeHtml(error)}</p>` : cards || `<p>${query ? "没有找到结果，试试其他关键词。" : "输入关键词开始搜索。"}</p>`}</main>
  <footer class="caption"><p>搜索结果由 Microsoft Bing 提供，仅供个人、非商业用途；结果数量与原版网页可能不同。</p><a href="${escapeHtml(original.href)}">打开原版 Bing 搜索页</a></footer></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}
