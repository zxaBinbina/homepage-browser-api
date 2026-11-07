const pack = (value) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
let activeTransport;
const sessionControl = new BroadcastChannel("bin-transport-control");
sessionControl.onmessage = (event) => {
  if (event.data?.type !== "stop") return;
  if (
    !event.data.all &&
    event.data.session !== activeTransport?.options.session
  )
    return;
  activeTransport?.dispose();
  sessionControl.close();
  globalThis.close();
};

async function requestBody(body, signal) {
  if (!(body instanceof ReadableStream)) return body;
  // Bound buffering keeps forms compatible with HTTP/1 local preview as well.
  const reader = body.getReader(),
    chunks = [];
  let length = 0;
  const abort = () => {
    void reader.cancel();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 32 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("单次上传最多支持 32 MiB。");
      }
      chunks.push(value);
    }
    signal.throwIfAborted();
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

// Bare-mux keeps this transport inside a SharedWorker. It never stores the token.
export default class BinTransport {
  ready = false;
  constructor(options) {
    activeTransport?.dispose();
    this.options = options;
    this.sockets = new Set();
    this.abort = new AbortController();
    activeTransport = this;
  }
  dispose() {
    this.abort.abort();
    for (const socket of this.sockets) socket.close(1000, "session ended");
    this.sockets.clear();
    this.options.token = "";
  }
  async init() {
    this.ready = true;
  }
  meta() {
    return {};
  }
  async request(remote, method, body, headers, signal) {
    const abortSignal = signal
      ? AbortSignal.any([signal, this.abort.signal])
      : this.abort.signal;
    const content = ["GET", "HEAD"].includes(method)
      ? undefined
      : await requestBody(body, abortSignal);
    const response = await fetch(`${this.options.apiOrigin}/v1/proxy/http`, {
      method: "POST",
      headers: {
        "x-bin-token": this.options.token,
        "x-bin-request": pack({
          url: remote.href,
          method,
          headers,
          ua: this.options.ua,
        }),
      },
      body: content,
      signal: abortSignal,
      credentials: "omit",
      cache: "no-store",
      duplex: "half",
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `中转请求失败（${response.status}）`);
    }
    const metadata = response.headers.get("x-bin-response");
    if (!metadata) throw new Error("中转响应不完整。");
    const info = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(metadata), (c) => c.charCodeAt(0)),
      ),
    );
    return { ...info, body: response.body || new ArrayBuffer(0) };
  }
  connect(url, protocols, headers, onopen, onmessage, onclose, onerror) {
    const endpoint = new URL("/v1/proxy/ws", this.options.apiOrigin);
    endpoint.protocol = endpoint.protocol === "http:" ? "ws:" : "wss:";
    const auth = `bin.${pack({ url: url.href, method: "GET", headers, protocols, token: this.options.token, ua: this.options.ua })}`;
    const socket = new WebSocket(endpoint, [auth, ...protocols]);
    this.sockets.add(socket);
    socket.binaryType = "arraybuffer";
    socket.onopen = () =>
      onopen(socket.protocol.startsWith("bin.") ? "" : socket.protocol);
    socket.onmessage = (event) => onmessage(event.data);
    socket.onclose = (event) => {
      this.sockets.delete(socket);
      onclose(event.code, event.reason);
    };
    socket.onerror = () => onerror("实时连接失败。");
    return [
      (data) => socket.send(data),
      (code, reason) => socket.close(code, reason),
    ];
  }
}
