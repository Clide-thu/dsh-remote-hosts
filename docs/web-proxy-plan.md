# 后续可选：把 token 从 URL 里彻底拿掉（P2 本地 Cookie 注入反向代理）

当前实现（P1）返回 `http://127.0.0.1:<隧道端口>/?token=<token>`。这是**远端自己的登录握手**：
远端 `dsh-client-connection` 收到带 `token` 的 `GET /` 后 `Set-Cookie: dsh-auth-<name>=<value>` 并
303 跳到干净的 `./`，所以 token 不会长期停在地址栏。代价是它短暂出现在 URL、地址栏历史、
guest partition 的历史/缓存，以及本插件的响应体里。

P2 用 ~250–350 行纯 `node:http`/`node:net` 的**每主机本地反向代理**消除这个暴露面：guest URL
变成 `http://127.0.0.1:<proxyPort>/`，**完全不含密钥**；cookie 只存在于宿主进程内，永远是
HttpOnly 于代理 origin。客户端代码**一字不改**（它只认 `payload.url`）。

## 接口已经不变量（无需再改契约）

`browserUrlFor(alias, localPort, token)`（`lib/index.mjs`）是构造 URL 的唯一位置，其 JSDoc 已写明
"改成 Cookie 注入反向代理只需替换这个函数体"。建议同时把成功响应扩为
`{ ok, alias, url, mode: 'direct' | 'proxy' }`，客户端只读 `url`。

## 代理要做什么

```
浏览器 ──► 127.0.0.1:<proxyPort> ──► (Host 重写 + Cookie 注入) ──► 127.0.0.1:<tunnelPort> ──ssh──► 远端
```

1. **自己完成 token 交换**（照搬 `lib/remote-client.mjs` 的 `GET /?token=…` +
   解析 `set-cookie` 中 `dsh-auth-` 前缀对），把**完整 `name=value` 原样重放**到每一次上行请求。
   注意：cookie 名由**请求的 Host 头**决定（`"dsh-auth-" + base64url(sha256(authority))`），所以
   做交换的 authority 必须与之后每一次请求（含 WebSocket upgrade）的 Host 完全一致，否则 401。
   不要把 `dsh-auth-*` 的 `set-cookie` 回传给 guest，也不要把 cookie 交给客户端。
2. **请求**：去掉 hop-by-hop 头（`connection/keep-alive/proxy-*/te/upgrade/trailer/transfer-encoding`），
   重写 `Host` 为 `127.0.0.1:<tunnelPort>`，重写 `origin`（必须等于远端看到的 Host，否则
   `isTrustedApiRequest` 403）与 `referer`，剥掉路径里的 `?token=`，转发 `sec-fetch-*`。
   `req.pipe(upstream)` + `upstream.pipe(res)`：chunked、gzip 透传、SSE、大附件、背压全部自然成立，
   **不要**手写 `content-length`。
3. **Upgrade**：`server.on('upgrade')` → 发带 `Connection: Upgrade` + `Upgrade` 的
   `http.request` → `upstream.on('upgrade', (r, sock, head) => { client.write(head); sock.pipe(client); client.pipe(sock); })`。
   远端 UI 的 `/api/remote.mux` WebSocket 需要它；**这条路径未实测**，失败表现是界面实时更新失效、
   只读仍可用。
4. **端口**：`listen({host:'127.0.0.1', port:0})` 后读 `server.address().port`，**保持监听**（无
   probe→bind 间隙）；断言 ≠ `19387`（该端口会被 Electron 判定为本地应用本体而拒绝导航）且 ≠
   本主机隧道端口。
5. **回收**：把代理放进 `lib/index.mjs` 的 `#hosts` 缓存条目，使 `dropHost()`、`#recordFailure`、
   `dispose()` 顺带关闭；顺序必须是**先代理**（停止接收 + 显式销毁 upgraded socket，
   `closeAllConnections()` 不覆盖 upgrade）**再 `tunnel.dispose()`**。

## 已知风险

- **origin/Host 重写正确性是头号功能风险**：写错就 403，而且症状是"页面能开、接口全错"。
- **绝对 URL / 绝对跳转**（远端若发 `Location: http://127.0.0.1:3080/…`）会绕过代理；未实测。
- 代理是"通往远端 DSH 的免认证本地网关"：本地任意进程都能访问。缓解：仅绑定回环 + 随机路径
  前缀；并把它记为可接受的本地信任边界。
- 隧道重开后 cookie/端口失配，已打开的页面需要刷新（可在隧道死亡回调里清 cookie 缓存并重建代理）。
- 手写代理的 header/流式细节出错是**静默**的。

## 为什么不选另外两条路

- **P3（把现有会话 cookie 交给 guest）**：不可行。guest cookie jar 是 Electron 主进程按
  workspace 创建的独立分区（`dsh-sidebar-browser-<uuid>`），preload 只暴露 `{acquire, release,
  onOpenRequested}`，没有 setCookie 通道；`RemoteHostClient.#cookie` 是私有字段；插件写
  `document.cookie` 只会写本地应用 origin 的 jar。
- **改 partition 的 Cookies SQLite**：需要主进程私有路径 + Chrome cookie 加密/schema + 重启，
  比 P2 更脆。
