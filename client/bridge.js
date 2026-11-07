import { BareMuxConnection } from "@mercuryworkshop/bare-mux";
const config = globalThis.BIN_CONFIG;
const attempt =
  new URL(location.href).searchParams.get("attempt") || crypto.randomUUID();
const root = document.querySelector("#frame-root");
const note = document.querySelector("#notice");
const tell = (type, data = {}) =>
  parent.postMessage(
    { channel: "bin-browser", type, attempt, ...data },
    config.homeOrigin,
  );
let controller,
  frame,
  connection,
  token,
  userAgent = "",
  expiresAt = 0,
  expiryTimer,
  initializing = false,
  stopped = false;
const sendError = (error, fatal = false) => {
  note.textContent = error instanceof Error ? error.message : String(error);
  note.hidden = false;
  tell("error", { message: note.textContent, fatal });
};

function within(promise, message, milliseconds = 15000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function step(message, promise) {
  tell("stage", { message });
  const result = await within(
    promise,
    `${message.replace(/…$/, "")}超时，请点击“清理并重建”重试。`,
  );
  if (stopped) throw new Error("本次浏览环境已关闭。");
  return result;
}

async function transport() {
  await within(
    connection.setTransport("/transport.js", [
      { apiOrigin: config.apiOrigin, token, ua: userAgent, session: attempt },
    ]),
    "连接浏览服务超时，请点击“清理并重建”重试。",
  );
}
async function initialize(data) {
  if (initializing) return;
  initializing = true;
  try {
    token = data.token;
    expiresAt = data.expiresAt;
    userAgent = data.ua || "";
    if (
      typeof token !== "string" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    )
      throw new Error("访问已过期，请重新输入密码。");
    // The parent first navigates through /reset. Do not delete a live database
    // from this document while concurrently opening the next one.
    const { ScramjetController } = $scramjetLoadController();
    controller = new ScramjetController({
      prefix: "/p/",
      files: {
        wasm: "/vendor/scramjet/scramjet.wasm.wasm",
        all: "/vendor/scramjet/scramjet.all.js",
        sync: "/vendor/scramjet/scramjet.sync.js",
      },
      flags: {
        syncxhr: false,
        rewriterLogs: false,
        captureErrors: false,
        sourcemaps: false,
        interceptDownloads: false,
      },
    });
    await step("正在准备临时存储…", controller.init());
    const workerUrl = new URL(
      `/sw.js?session=${encodeURIComponent(attempt)}`,
      location.origin,
    ).href;
    await step(
      "正在启动浏览服务…",
      navigator.serviceWorker.register(workerUrl, {
        scope: "/",
        updateViaCache: "none",
      }),
    );
    await step(
      "正在等待浏览服务就绪…",
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("浏览服务启动超时，请清理并重建。"));
        }, 14000);
        function cleanup() {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener(
            "controllerchange",
            check,
          );
        }
        function check() {
          if (navigator.serviceWorker.controller?.scriptURL === workerUrl) {
            cleanup();
            resolve();
          }
        }
        navigator.serviceWorker.addEventListener("controllerchange", check);
        check();
      }),
    );
    // New URL => new SharedWorker even if the previous worker stopped replying.
    connection = new BareMuxConnection(
      `/vendor/bare-mux/worker.js?session=${encodeURIComponent(attempt)}`,
    );
    await step("正在连接浏览服务…", transport());
    frame = controller.createFrame();
    frame.frame.title = "中转网页";
    frame.frame.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-downloads allow-pointer-lock allow-presentation allow-modals",
    );
    frame.frame.setAttribute(
      "allow",
      "autoplay; fullscreen; gamepad; clipboard-read; clipboard-write",
    );
    frame.frame.setAttribute("referrerpolicy", "no-referrer");
    frame.addEventListener("urlchange", (event) =>
      tell("url", { url: event.url }),
    );
    frame.addEventListener("navigate", (event) =>
      tell("loading", { url: event.url }),
    );
    frame.addEventListener("contextInit", (event) => {
      const w = event.window;
      if (userAgent) {
        for (const [name, value] of Object.entries({
          userAgent,
          appVersion: userAgent.replace(/^Mozilla\//, ""),
          platform: /iPhone/.test(userAgent)
            ? "iPhone"
            : /iPad/.test(userAgent)
              ? "iPad"
              : /Android/.test(userAgent)
                ? "Linux armv8l"
                : /Windows/.test(userAgent)
                  ? "Win32"
                  : "Linux x86_64",
        })) {
          try {
            Object.defineProperty(w.navigator, name, {
              configurable: true,
              get: () => value,
            });
          } catch {}
        }
        try {
          Object.defineProperty(w.navigator, "userAgentData", {
            configurable: true,
            get: () => undefined,
          });
        } catch {}
      }
      w.document.addEventListener(
        "click",
        (event) => {
          const anchor = event.target?.closest?.("a[href]");
          if (anchor?.target && anchor.target !== "_self")
            anchor.target = "_self";
        },
        true,
      );
      w.document.addEventListener(
        "submit",
        (event) => {
          if (event.target?.target) event.target.target = "_self";
        },
        true,
      );
      // Keep links asking for another window inside the tool; no unproxied popups.
      w.open = (url) => {
        if (url) {
          frame.go(new URL(String(url), event.client.url).href);
        }
        return null;
      };
    });
    frame.frame.addEventListener("load", () => {
      note.hidden = true;
      tell("loaded");
    });
    root.replaceChildren(frame.frame);
    expiryTimer = setTimeout(() => {
      shutdown();
      tell("expired");
    }, expiresAt - Date.now());
    tell("ready");
  } catch (error) {
    if (stopped) return;
    stopped = true;
    token = "";
    sendError(error, true);
  } finally {
    initializing = false;
  }
}
async function shutdown() {
  stopped = true;
  clearTimeout(expiryTimer);
  root.replaceChildren();
  frame = null;
  token = "";
  stopTransport();
  localStorage.clear();
  sessionStorage.clear();
  const response = await fetch("/clear", {
    method: "POST",
    cache: "no-store",
    keepalive: true,
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  tell("stopped", { cleared: Boolean(response?.ok) });
  note.textContent = "浏览会话已结束。";
  note.hidden = false;
}
function stopTransport() {
  const control = new BroadcastChannel("bin-transport-control");
  control.postMessage({ type: "stop", session: attempt });
  control.close();
}
let commands = Promise.resolve();
window.addEventListener("message", (event) => {
  if (
    event.source !== parent ||
    event.origin !== config.homeOrigin ||
    event.data?.channel !== "bin-browser" ||
    event.data.attempt !== attempt
  )
    return;
  const data = event.data;
  if (data.type === "stop") {
    void shutdown();
    return;
  }
  if (data.type === "init") {
    initialize(data);
    return;
  }
  commands = commands
    .then(async () => {
      if (data.type === "theme") {
        document.documentElement.style.colorScheme = data.theme;
        document.body.style.background = data.background;
        return;
      }
      if (!frame || Date.now() >= expiresAt) return;
      if (data.type === "go") {
        note.hidden = true;
        frame.go(data.url);
      }
      if (data.type === "reload") frame.reload();
      if (data.type === "device") {
        const nextAgent = data.ua || "";
        if (nextAgent === userAgent) return;
        userAgent = nextAgent;
        await transport();
        if (frame.client?.url?.protocol?.startsWith("http")) frame.reload();
      }
    })
    .catch((error) => sendError(error));
});
window.addEventListener("pagehide", () => {
  stopped = true;
  stopTransport();
  token = "";
  clearTimeout(expiryTimer);
});
if (parent === window) {
  note.textContent = "请从个人主页的「网页浏览器」工具进入。";
} else tell("boot");
