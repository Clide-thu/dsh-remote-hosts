# dsh-remote-hosts

Open a remote DeepSeek Harness host **inside your local window**: one click starts the SSH tunnel
and loads that host's own Web UI in the built-in Browser tab, plus a read-only per-host
workspace/session panel in the left sidebar. Nothing re-implements the remote API — the tab runs
the remote app itself through the tunnel.

`dsh-remote-aggregator` 的**独立副本**，在保留"只读聚合"面板的基础上新增三件事：

1. **一键打开**：点主机分组上的 `open` → 宿主半边自动确保 SSH 隧道 → 在本地右侧栏官方
   **浏览器**标签里打开该主机自己的 DSH Web UI。不需要手工维护 `ssh -L`，也不需要为远端
   API 逐个封装——标签页加载的就是远端那个 app 本身。
2. **面板落位**：remote hosts 面板进入左侧栏，**与官方工作区面板同级**：本地工作区在上、
   remote hosts 在下。
3. **占满内容区**：打开标签后自动把右侧栏切到全屏，而不是半对话区半插件区。

原 `remote-aggregator` 目录**未被改动**，两个包可并存（路由前缀、DOM id、guard key 全部不同）。

---

## 与旧版的关系

| | dsh-remote-aggregator | dsh-remote-hosts（本包） |
|---|---|---|
| 包名 / 入口 id | `dsh-remote-aggregator` / `remote-aggregator` | `dsh-remote-hosts` / `remote-hosts` |
| 路由前缀 | `/api/dshRemoteAggregator` | `/api/dshRemoteHosts` |
| 面板 DOM id | `dsh-remote-aggregator-panel` | `dsh-remote-hosts-panel` |
| 凭据文件 | `$DSH_HOME/plugins/dsh-remote-aggregator.json` | `$DSH_HOME/plugins/dsh-remote-hosts.json` |
| 路由数 | 5 | 6（新增 `/remote/open`） |

**凭据不用重输**：本包首次运行时若自己的 store 不存在，会**只读回退**到旧 store；第一次写入时
才落到自己的文件。旧文件不会被修改。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/hosts/list` | ssh config + 凭据投影（**不触发任何 SSH/网络**） |
| POST | `/hosts/add` | 保存 `{alias, credential}` |
| POST | `/hosts/remove` | 移除主机 |
| POST | `/hosts/probe` | 懒探测连通性 |
| POST | `/remote/sessions` | 远端 `session/list`，按 `cwd` 分组所需的原始数据 |
| **POST** | **`/remote/open`** | **确保隧道并返回可直接交给浏览器标签的 URL** |

统一约定：永远 HTTP 200；成功 `{ok:true,…}`，失败 `{ok:false,error:{kind,message}}`，
`kind ∈ bad-request | unknown-host | needs-credentials | unreachable | internal`。

### `POST /remote/open`

```
请求  { alias }
成功  { ok: true, alias, url }        // url = http://127.0.0.1:<隧道本地端口>/?token=<token>
失败  { ok: false, error: { kind, message } }
```

* **不新建第二条隧道**：`lib/tunnel.mjs` 的 `-L <localPort>:127.0.0.1:<remotePort>` 指向的就是远端
  `dsh web` 端口，所以 `/remote/sessions` 已经在用的那条隧道同时服务 Web UI。重复点击复用
  同一个隧道实例，不会多起 `ssh`。
* **URL 是唯一携带 token 的字段**；token 不进日志、不进 `error.message`、不进 `error.kind`
  （两处 `sanitizeMessage` 兜底）。远端收到 `?token=` 后会 `Set-Cookie` 并 303 跳到干净的 `./`，
  所以 token 不会长期停留在地址栏。
* `browserUrlFor(alias, localPort, token)` 是构造 URL 的**唯一位置**。若以后改成"本地 Cookie 注入
  反向代理"（见下），只替换这个函数体，客户端一字不改。

## 客户端行为

### 落位（左侧栏，工作区之下）

官方**没有**"工作区下方内容区"槽位：`sidebar` 是 single 且已被占用，`sidebar.workspaces` 同理，
`sidebar.panellist` 在工作区**上方**。因此使用官方槽渲染器提供的稳定锚点：

```
<div data-slot="sidebar.workspaces" style="display:contents">   ← 每个 slot 都有这样的锚点
```

锚点是 `display:contents`（布局透明、纯寻址），把它作为**前一个兄弟**插入到同一父元素
（shell 的 regionArea，`display:flex; flex-direction:column; flex:1`）里，就会落在官方工作区
列表之后、同一列的下一行——天然"平级、上工作区下 remote hosts"。

* CSS 预算：`flex:0 0 auto` + `max-height:min(45%,420px)` + 内部 `.ra-scroll` 自己滚动。
  **不能**用 `flex:1`/`height:100%`，否则会抢走官方列表的高度。
* `[data-sidebar-collapsed]`（frame 上的官方属性）时隐藏，与 56px 图标栏一致。
* 重挂载：只观察当前父元素与根节点的 `childList`（**不观察 subtree**——对话流会把回调打爆），
  变更后按"顺序断言"`section.previousElementSibling === 锚点` 自愈。
* 找不到锚点 → 退回 `data-ra-placement="overlay"` 的浮动卡片，面板始终可见、绝不抛错。

### 一键打开 + 全屏

```
ctx.get('sidebarRight').openTab('browser', { params: { url } })   // 官方 chat 插件同款调用
ctx.get('sidebarRight').toggleFullscreen(ctx.sidebarRight.commandTarget())
```

* `openTab` 内部会把右栏展开，所以一次调用同时完成"展开右栏 + 打开浏览器标签"。
* 服务用 `ctx.get()` **机会性获取**，不写进 `dsh.client.inject`：这样即使某些 profile 没有
  官方浏览器插件，本插件也照样激活——不会因为缺服务变成"启动审计失败"的条目（那正是旧版
  崩溃的失败类别）。
* 打开前先检查 `sidebarRightTabs.get('browser')` 是否存在（kind 未注册时 `openTab` 会抛）。
* 全屏是"能则更好"：`toggleFullscreen` 是非幂等开关，且窄窗会走 `autoFullscreen` 分支反而**收起**
  面板。因此先看 `mountedSurface().layout.mode`、要求 `isExpanded()`、跳过窄窗，并在切换后
  发现被收起时用 `toggleExpanded()` 复原。任何一步失败都只影响全屏，标签照样打开。

## 安装 / 启用（桌面端）

1. 取得插件：`git clone git@github.com:Clide-thu/dsh-remote-hosts.git`（或下载 ZIP 解压）。
2. 设置 → 插件 → 「安装」→ 粘贴**解压/克隆出来的目录路径**（安装器接受本地目录、`.tgz`、
   Git 仓库地址或 npm 包名）。
3. 启用 `dsh-remote-hosts`，然后重启应用。
   > 若你还装着前身插件 `dsh-remote-aggregator`，请停用它，否则两个面板会同时出现。
4. 首次使用：展开某个主机 → `credential` → 粘贴远端 `dsh web` 打印的
   `http://127.0.0.1:<port>/?token=…`。前提是该主机已在 `~/.ssh/config` 中且可免密连接。

> `desktop` profile 由 Electron 应用托管，请走 GUI 开关；用 DSH CLI 直接改它会被拒绝。

## 验证

任何 Node ≥ 22 都可以（DSH 自带一份）：

```powershell
node test/verify-client-harness.mjs   # 客户端（含落位/打开/降级/token 不泄漏回归）
node test/host.test.mjs               # 宿主（含 /remote/open 复用单隧道、错误分类、token 不回声）
node test/credentials.test.mjs        # 凭据（含旧 store 迁移）
```

## 已知边界

* **token 会短暂出现在 URL 里**：这是远端自己的登录握手机制（`GET /?token=` → 303 → cookie），
  而不是本插件发明的。相比"手工 `ssh -L` + 把 token URL 粘进浏览器"，暴露面没有变大。
  若要做到 URL 完全不含密钥，需要 P2：在隧道之上再起一个本地 HTTP 反向代理，自动注入
  `dsh-auth-*` cookie 并转发 upgrade（约 250–350 行，纯 `node:http`/`node:net`），届时
  guest URL 变成 `http://127.0.0.1:<proxyPort>/`，客户端零改动。
* 右侧栏是 `scope: session`，所以**必须先有在屏会话**才能打开浏览器标签；没有会话时面板会
  给出明确提示而不是静默失败。
* 同一主机重复点击会再开一个指向同一 URL 的浏览器标签（官方 browser 类型 `multiple:true`，
  且标签无法改 URL）；两个标签共用同一个远端会话。
* 远端 UI 的下载、通知、摄像头、HTTP 登录弹窗被 Electron guest 策略禁止；本地端口不能是
  `19387`（会被判定为本地应用本体而拒绝导航）。
* `trySlotMount()`（探测 `ctx.client/widgets/ui/web` 的 React 槽 API）是旧版遗留的**死代码**，
  真实客户端槽 API 是 `ctx.slots.inject/register({name}, Component)`；本插件用 DOM 锚点方案，
  不依赖它。留着是为了让本次改动的 diff 可审阅，后续可单独删除。

## 开源协议

MIT — 见 [LICENSE](LICENSE)。
