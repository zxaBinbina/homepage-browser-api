# bin-api

个人主页的独立 Cloudflare Worker，按模块提供 API。当前包含密码认证与私人网页中转；只使用 Workers、静态资源和内置限速，不需要常驻服务器、KV、D1 或 Durable Objects。

本次部署、已通过的检查与目标网站的实际限制见 [验证记录](VERIFICATION.md)。

| 地址                                         | 职责                                       |
| -------------------------------------------- | ------------------------------------------ |
| `https://zxabinbina.cc.cd/tools/web-browser` | 主页工具入口、密码输入、网址导航与设备模拟 |
| `https://api.zxabinbina.cc.cd/v1/auth/login` | 密码验证，签发只适用于代理的一小时凭据     |
| `https://api.zxabinbina.cc.cd/v1/proxy/http` | HTTP/HTTPS 请求及流式响应                  |
| `https://api.zxabinbina.cc.cd/v1/proxy/ws`   | 原生耦合的 WebSocket 中转                  |
| `https://browse.zxabinbina.cc.cd/`           | 与主页、API 隔离的浏览环境                 |
| `https://api.zxabinbina.cc.cd/health`        | 不含敏感信息的服务版本与模块列表           |

## 开发与验证

需要 Node.js 22、npm，以及浏览器检查使用的 Python Playwright 和 Chrome。

```bash
npm ci
node scripts/generate-secrets.mjs
npm run check
npm test
npm run build
```

密钥生成脚本只在首次使用时运行，已有密钥时拒绝覆盖。访问密码在 `.secrets/access.txt`，部署绑定在 `.secrets/bindings.json`，本地密钥在 `.dev.vars`；这些文件权限限制为当前用户，均被 Git 忽略，不会复制进 `public/`。

本地启动 Worker（避免 Wrangler 将本地地址替换成第一个生产路由）：

```bash
npx wrangler dev --infer-origin-from-routes=false --port 8787 \
  --var API_ORIGIN:http://127.0.0.1:8787 \
  --var BROWSE_ORIGIN:http://127.0.0.1:8787 \
  --var HOME_ORIGIN:http://127.0.0.1:5173
```

在 `../homepage` 启动前端：

```bash
VITE_BIN_API_ORIGIN=http://127.0.0.1:8787 \
VITE_BIN_BROWSE_ORIGIN=http://127.0.0.1:8787 npm run dev
```

`tests/fixture.mjs` 是本地测试网站，提供表单、Cookie、动态请求、Range 和 WebSocket 回显，不随 Worker 部署。运行它时给本地 Worker 增加 `--var TEST_UPSTREAM:http://127.0.0.1:8790`，仅将 `fixture.test` 映射到测试网站。不要将此变量配置到生产。

```bash
node tests/fixture.mjs
# 另一终端；需已启动 Worker 和主页开发服务器
python3 scripts/check-browser.py
```

## 部署与密钥

`wrangler.jsonc` 已配置两个独立自定义域名。先确认 Cloudflare 账户和 DNS 权限：

```bash
npx wrangler whoami
npm run build
npx wrangler deploy --dry-run
npx wrangler deploy
npx wrangler secret bulk .secrets/bindings.json
```

首次部署到密钥写入之间，认证接口返回 503，代理默认拒绝访问。生产未开启 `workers.dev`、预览 URL、应用日志或收费存储产品。主页需另在 `../homepage` 构建并部署到现有 Pages 项目。

访问密码是随机高熵字符串，服务端只存 SHA-256 摘要；签名密钥仅存在于 Worker Secret。轮换密码需同时更新 `AUTH_PASSWORD_HASH` 和 `AUTH_SIGNING_KEY`，后者会使已签发凭据立即失效。不要把摘要直接当作登录密码，也不要将绑定文件提交到版本库。保持访问密码的高随机性，不应将摘要方案用于用户自行选择的弱密码。

## 公开仓库与本地文件

[.gitignore](.gitignore) 按用途排除密钥、环境文件、Wrangler 状态、依赖、构建产物、日志、Python 缓存、测试报告和浏览器会话数据。`.secrets/access.txt`、`.secrets/bindings.json`、`.dev.vars` 及其环境变体均不提交，已有访问密码无需为整理仓库重新生成。

[.dev.vars.example](.dev.vars.example) 只列出空的绑定名称，可公开提交；空值不能用于登录。首次开发运行 `node scripts/generate-secrets.mjs` 创建实际密钥，不要先把空示例复制成 `.dev.vars`，也不要在示例中填入真实值。

`wrangler.jsonc` 保留在仓库中，其中 Cloudflare account ID、域名和限速 namespace ID 属于部署标识，不是 API Token 或访问密钥。部署到自己的账户时替换账户 ID、域名及来源配置；认证密钥使用 Worker Secrets，Cloudflare API Token 使用 Wrangler 登录或部署环境的 Secret 配置。

`public/index.html` 是源码，应提交；`public/bridge.js`、`public/transport.js`、`public/sw.js`、`public/vendor/` 和 `public/source.zip` 由构建生成，不提交。`package-lock.json`、测试源码及本文引用的验证记录保留，便于复现和核对功能边界。

项目首次上传前，若尚未初始化 Git，先在本目录运行 `git init`，然后检查：

```bash
git status --short
git add --dry-run .
git diff --cached --stat
git check-ignore -v .dev.vars .secrets/access.txt .secrets/bindings.json artifacts/example.png
```

通过 Git 提交和推送时遵循排除规则；GitHub 网页拖拽上传或直接压缩整个工作目录不会自动遵循，勿将本地目录整体打包上传。`.gitignore` 不会移除已跟踪的文件或清除历史；如真实凭据曾被提交，应先撤销或轮换，再单独清理历史。

## 模块结构

- `src/index.ts`：按路径和主机分发请求，统一来源检查与响应策略。
- `src/modules/auth.ts`：桌面设备检查、登录限速、密码校验、签发与验证。
- `src/modules/policy.ts`：目标地址、私网 / 保留地址、递归目标及请求头约束。
- `src/modules/proxy.ts`：认证后的 HTTP 与 WebSocket 传输。
- `src/modules/bing.ts`：Bing 简洁搜索，读取公开 RSS 结果并提供结果链接；原版 Bing 路径保留。
- `src/modules/recovery.ts`：独立的清理导航页，在创建新数据库和工作线程之前移除旧会话状态。
- `client/`：浏览环境、Service Worker 和与 Scramjet 配套的传输适配器。
- `scripts/build.mjs`：构建浏览器文件、复制固定版本运行库和许可证。

新增 API 时创建独立模块和 `/v1/<module>/` 路由。代理凭据的 `scope` 固定为 `proxy`，不能将其直接作为未来管理 API 的授权凭据。浏览子域名允许调用代理，不能调用密码认证；不要把不受信任网页放到 API 或主页源站。

## 临时会话与隐私

密码和访问凭据不写入 URL、localStorage 或服务器数据库。网页请求、Cookie、表单和上传会经 Worker 发送给目标网站；服务器不建立浏览历史、Cookie 数据库或应用访问日志，HTTP 转发不缓存响应。URL 被编码仅用于路由，不代表加密。

运行时为兼容登录而在独立浏览源站维护 Cookie 和网站存储。正常退出、到期、离开工具或关闭标签页时关闭页面和传输，使用 `Clear-Site-Data` 清理该源站的存储、IndexedDB 与缓存；新会话初始化前必须再次完成清理。退出后清空工具中的网址和导航记录。没有使用 `"cookies"` 指令，以免浏览器按注册域清理其他主页 / 子站的正常登录 Cookie；目标 Cookie 本身存放在代理专用 IndexedDB 中，并随存储清理。

浏览器崩溃、断电或进程被强制结束时，网页无法保证清理代码执行，此时残留在下次初始化前清除。它不是浏览器原生无痕窗口的完整替代；已下载文件、浏览器自身记录、目标网站和平台侧记录不受应用清理控制。需要浏览器级隔离时可以在 Edge InPrivate / Chrome 无痕窗口打开工具。

签名凭据一小时后不再接受新请求；现有流式请求和原生 WebSocket 并非由服务器定时强行断开，页面的到期与退出流程会主动关闭它们。退出不创建服务端撤销数据库，泄露的旧凭据在到期前仍需通过轮换签名密钥撤销。

## 卡住后的恢复

工具栏的「清理并重建」会清空本次浏览数据并重建环境，在当前一小时凭据有效期内无需再次输入密码。启动分为清理、准备临时存储、启动服务和连接服务；每个异步阶段都有超时，失败会显示对应阶段。

初始化首先导航到 `/reset`，等待清理完成后再加载运行库；不在打开新数据库的同一文档中清理旧数据库。每次重建使用独立的 Service Worker 更新地址和 SharedWorker 地址，以免重新连接不再响应的旧线程。退出通过独立控制通道关闭传输，清理不等待旧传输回复。

新增回归命令：`python3 scripts/check-recovery.py`，需使用本地 Worker、主页和测试网站；它模拟传输不回应、保留旧数据库连接，并验证连续重建及旧 Cookie 清理。

## 功能边界与免费额度

- 用户端限 Windows / Linux 上的 Chrome、Edge；手机显示说明页。设备预设改变视口尺寸及请求 / 页面 User-Agent，不能模拟真实 Safari 内核或系统设备。
- 支持 HTTP、HTTPS、WebSocket；流式转发保留 Range、状态码、重定向和多个 Set-Cookie。表单 / 上传在浏览器内最多暂存 32 MiB，超过时拒绝提交；下载交由浏览器原生处理。禁止内网、保留地址、IPv6 字面量及递归访问 API / 浏览源站。域名可正常解析到公网 IPv6。
- Scramjet 承担 HTML / CSS / JavaScript 改写和 Cookie 兼容，改写在浏览器端执行。静态运行库全部由浏览子域名提供。为兼容 Scramjet 1.1.0 对 WASM 的双重加载方式，同一资源根据 `Sec-Fetch-Dest` 返回二进制或预先生成的脚本包装，并设置 `Vary`。
- 新会话默认打开「Bing 简洁搜索」（`https://www.bing.com/search?bin_view=lite`），使用 Bing 的公开 RSS 结果，供个人非商业阅读。输入关键词和点击结果均继续走中转。不会替换正常 Bing 页面，不支持原版的全部搜索功能；RSS 返回的结果数量和排序可能不同。该适配模块不向搜索源发送登录 Cookie 或认证头。
- 无法保证任意网站全部功能可用；登录验证码、目标站限制、第三方认证和视频播放需逐站检查。云原神 SDK 的控制通道包含 WebSocket 回退，但音视频使用 WebRTC，Worker 没有通用 UDP 代理能力。页面能打开、登录成功均不能作为实际可游玩的证据。
- Workers Free 每账户每日 10 万次动态请求，北京时间 08:00 重置；每次请求 10ms CPU（网络等待不计），每个实例 128MB 内存。资源、接口、重定向、媒体分段会增加用量，静态资源经过本项目的主机分发时也会调用 Worker。
- 登录按来源 IP 每分钟 5 次，代理按临时会话每分钟 1,500 次限速。内置限速分布在各边缘位置，不是全局硬性计费上限。账户本身保持 Workers Free 时超额报错，不自动开通付费；本项目不会修改账户套餐。

## 第三方资源

Scramjet 1.1.0（MIT）：https://github.com/MercuryWorkshop/scramjet

bare-mux 2.1.9（MIT）：https://github.com/MercuryWorkshop/bare-mux

bare-mux 上游已标记弃用；这里固定为 Scramjet 已发布版本依赖的接口，并使用本地传输适配器。升级需一起验证。许可证和锁定版本摘要随 `public/vendor/` 发布，依赖完整版本与校验值由 `package-lock.json` 固定。
