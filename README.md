# dsh-mcp-config

Manage [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) from **Settings → MCP servers**: enable/disable, add, edit, delete, and **test the connection** (including whether authentication works).

Changes apply immediately — no restart needed.

![settings page](docs/screenshot.png)

![OAuth authorized](docs/screenshot-oauth.png)

English | [中文说明](#中文说明)

## Why

dsh implements every MCP server as a Loader entry (the `@deepseek-ai/dsh-mcp-client` plugin) written into a user patch file:

| File | Scope |
|------|-------|
| `$DSH_HOME/cordis.patch.yml` | every profile (desktop / web / headless) |
| `$DSH_HOME/profiles/<name>/cordis.patch.yml` | one profile only |

The official Settings page only renders forms for plugins with volatile config fields, and MCP entries are not such a plugin — so editing a server means hand-editing YAML and restarting.

This plugin fills that gap. It **edits those two patch files directly** and lets dsh do the rest: the HMR layer watches them, and any change makes the Loader call `reconcileProfilePatches`, which mounts, unmounts or rebuilds the server. The plugin does not own a server list and never spawns a child MCP client itself — it only edits files, reports state, and probes connections.

## Requirements

- dsh `>= 0.2.0-rc.2` (`dsh --version`)
- A Web or Desktop UI (the page is a Web client bundle, `dsh.client.platform = web`)

Dependency resolution: `yaml`, `@modelcontextprotocol/client` and `@deepseek-ai/dsh-subprocess` are resolved from the **dsh installation** (`profileContext.installAnchor`, falling back to `which dsh`), not from the plugin's own `node_modules`. The plugin therefore needs no install step.

## Install with dsh

**Zero runtime dependencies**: a clone needs no `npm install` and no registry access.

### Web / headless profile

```bash
# Install straight from the repository (pnpm clones it)
dsh plugin --profile web add git+https://github.com/ianzheng001/dsh-mcp-config.git

# Or clone and link a local checkout (development; restart dsh after code changes)
git clone https://github.com/ianzheng001/dsh-mcp-config.git ~/git/dsh-mcp-config
dsh plugin --profile web add link:~/git/dsh-mcp-config
```

The `git+https://` prefix is required: without `git+`, pnpm treats the URL as a tarball and fails with `ERR_PNPM_TARBALL_EXTRACT`. The full form is `git+https://<host>/<org>/<repo>.git`.

`dsh plugin add` reads `dsh.bundle.patch` from the package and adds `dsh-mcp-config` to the profile's bundle stack. The bundle patch only **inserts** its own row (`mcp-config`); it never touches anyone else's entry.

### Desktop (DeepSeek Harness.app)

Desktop uses its own `desktop` profile, and the **homebrew dsh refuses to manage it** (`profile "desktop" is managed exclusively by the Electron application`).

**Recommended: the app's Plugins panel** — Plugins → add plugin → paste the repository URL (or the absolute path of a local clone). After installing, the app offers a reload.

Prefer the CLI? The app's bundled dsh has the `manageDesktopProfile` permission:

```bash
# 1) Quit the app completely (Cmd+Q; confirm the process is gone)
# 2) Install with the app's own dsh, not the homebrew one
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add git+https://github.com/ianzheng001/dsh-mcp-config.git
# 3) Reopen the app
open -a "DeepSeek Harness"
```

### After installing

Restart dsh / the app **once** (the Host half has no HMR). After that, every MCP server change in Settings applies immediately.

### Uninstall

```bash
dsh plugin --profile web remove dsh-mcp-config
# Desktop: the app's plugin panel, or its bundled CLI
```

## Usage

Open **Settings → MCP servers**. Each server is a card:

| Action | What it does |
|--------|--------------|
| Enable / disable | Checkbox. Writes/clears that row's `disabled`; the Loader unmounts or mounts it immediately |
| Edit | Change id, serverName, transport (stdio / streamable-http), command/args/cwd/env or url/headers, toolCallTimeoutMs |
| Delete | First click turns into "confirm delete"; click again within 4 seconds to actually remove the row from the patch file |
| Test connection | Opens a **fresh temporary MCP session** with the config currently in the editor: handshake + `tools/list`, reporting server name/version/tool count or the exact error (401, ENOENT, timeout, …) |
| Add server | Choose home (all profiles) or the current profile; test the connection first, then create |
| Reload | Re-read state after an external change (hand-edited YAML, git branch switch) |

### Authentication

#### Static credentials

- `stdio` servers → put them in `env` (for example `MY_AUTH_ACCOUNT`), or let the server use browser SSO itself.
- `streamable-http` servers → put them in `headers` (for example `Authorization: Bearer <token>`).

Keys matching `token/secret/password/authorization/cookie/...` are masked by default; click "show" to reveal.

**"Test connection" is also an auth check**: a successful handshake means the credential works; failures return the upstream error (for example `HTTP 401 invalid_token`) plus the tail of the child process's stderr. It opens an independent connection and does not disturb the session the model is using.

#### Interactive OAuth (one click)

dsh's MCP client only accepts static headers, so the plugin runs the authorization-code flow itself and writes the resulting access token into that server's `Authorization` header:

1. Click "Authenticate" on the card — the plugin performs a real handshake through the MCP SDK's `OAuthClientProvider`;
2. The server answers `401` + `WWW-Authenticate` → the SDK performs RFC 9728 resource-metadata discovery → RFC 8414 authorization-server discovery → dynamic client registration (DCR) when needed → PKCE authorization URL;
3. The browser opens the authorization URL; you sign in and consent; the server redirects to dsh's own loopback route `/dsh-mcp-config/oauth/callback`;
4. The plugin exchanges the code for a token → writes `headers.Authorization: Bearer …` into the patch → the Loader hot-reloads → the card shows "OAuth authorized / connected · N tools".

Credentials (client registration, tokens, PKCE verifier, discovery state) live in `<DSH_HOME>/mcp-config-oauth.json` with mode `0600` — never in the patch file.

- **Authorization servers without dynamic registration** (common for enterprise OIDC): fill in `OAuth client id / client secret` in the editor; they are submitted with the flow and remembered.
- **Token expiry**: the live connection uses the static header, so it drops when the token expires. Click "Re-authenticate" — the SDK refreshes with the refresh token.
- "Re-authenticate" appears on `streamable-http` cards; `stdio` servers do not need OAuth.

### Where edits go

- **Edit / enable / disable / delete**: written to the file where the row currently lives; no cross-file copying.
- **Add**: home layer by default; switch to the current profile in the UI.

Remember that the home layer applies to every profile, so disabling a home-level server also affects the desktop and headless profiles.

## Security boundaries

- The page talks to the Host over `POST /dsh-mcp-config/api` (same-origin, loopback only) with no extra authentication — same as dsh's own Settings. Do not expose dsh's Web port to an untrusted network.
- Credentials are stored in plain text in the patch file (as with hand-written YAML). Writes preserve the file's permission bits; new files are created `0600`.
- Writes are atomic (temporary file + rename), so the Loader watcher never sees a half-written file. Every write carries a SHA-256 precondition; if the file changed elsewhere the write is refused and the latest content is read back.

## Development

```bash
npm test          # patch layer / Host route end to end / real stdio handshake / bundle shape / OAuth flow
npm run harness   # local UI harness (copies the real patch into a temp directory; never writes your config)
```

- `lib/patch.js` — pure operations on YAML patch rows (the `yaml` module is injected so it can be unit-tested; comments and `!!js` tags are preserved)
- `lib/probe.js` — one-shot MCP probe session (independent of the live connection)
- `lib/index.js` — Host half: the `/dsh-mcp-config/api` route, state merging, writes, validation
- `lib/client.js` — browser half: hand-written CJS factory (`window.__ModuleLoader__.load`), no build step
- `test/harness/` — an esbuild-bundled React test page wired to the real Host logic

The Host half has no HMR: changing `lib/index.js` requires a dsh restart; changing `lib/client.js` is hot-swapped by dsh's client-hmr (500 ms bundle polling) — just reopen Settings.

### Pitfall: the client bundle must be one IIFE

The Web shell does not use one `<script>` per plugin — it concatenates the missing bundles of a batch into one combo URL (`/plugins/??a/client.js,b/client.js`) executed in the **same top-level scope**. A top-level `const factory = ...` appearing twice makes the whole combo fail with `Identifier 'factory' has already been declared`, and the only report is "import failed (see console for the import error)".

`test/bundle.test.mjs` pins this down by concatenating the bundle with a sibling of the same shape and compiling it. Always use this structure:

```js
;(() => {           // no top-level bindings
  const factory = (require) => { ... }
  window.__ModuleLoader__.load({ id: '<loader entry id>', factory })
  window.__ModuleLoader__.load({ id: '<package name>', factory })
})()
```

Register both ids: the **Loader entry id** (for example `mcp-config`) and the **package name** (`dsh-mcp-config`). The client runner imports by entry id; the package-name registration is a compatibility fallback.

## Limitations

- Managed rows must be user patch rows; entries shipped by bundles/plugin packages are shown read-only (`plugin` badge).
- No per-profile override of a home-level server (enable/disable writes `disabled` in place).
- No one-click import from `.mcp.json` (the home patch is its mirror today).

## License

MIT. See [LICENSE](LICENSE).

---

# 中文说明

在 DeepSeek Harness（dsh）的 **设置 → MCP 服务器** 里管理 MCP server：启用/停用、新增、编辑、删除，以及**测试连接（验证认证是否有效）**。改完立即生效，不需要重启 dsh。

![设置页](docs/screenshot.png)

![OAuth 认证成功](docs/screenshot-oauth.png)

## 为什么需要它

dsh 把每个 MCP server 实现成一个 Loader 条目（插件 `@deepseek-ai/dsh-mcp-client`），写在用户 patch 文件里：

| 文件 | 作用范围 |
|------|----------|
| `$DSH_HOME/cordis.patch.yml` | 所有 profile（desktop / web / headless） |
| `$DSH_HOME/profiles/<name>/cordis.patch.yml` | 只对某个 profile |

官方 Settings 只给「有 volatile 配置字段的插件」渲染表单，MCP 条目不属于这类，所以改一个 server 只能手改 YAML 再重启。

这个插件补上这块：它**直接读写这两个 patch 文件**，剩下的交给 dsh 自己——dsh 的 HMR 监听这两个文件，文件一变就调用 Loader 的 `reconcileProfilePatches`，于是 server 被挂载/卸载/重建。插件本身不持有 server 列表，也不自己 spawn 子 client，只做「文件编辑 + 状态汇报 + 连接探测」。

## 前置条件

- dsh `>= 0.2.0-rc.2`（`dsh --version` 确认）
- 能用 Web / Desktop 界面（本插件的页面是 Web 客户端 bundle，`dsh.client.platform = web`）

依赖解析：`yaml`、`@modelcontextprotocol/client`、`@deepseek-ai/dsh-subprocess` 都从 **dsh 安装目录**解析（`profileContext.installAnchor`，兜底 `which dsh`），不从插件自己的 `node_modules` 解析。所以插件不需要自己装这些包。

## 用 dsh 安装

**零运行时依赖**：克隆后**不需要 `npm install`，也不需要访问 registry**。

### Web / headless profile

```bash
# 直接从仓库安装（pnpm 会 clone 整个仓库）
dsh plugin --profile web add git+https://github.com/ianzheng001/dsh-mcp-config.git

# 或者先 clone，再按本地路径 link（开发时用这个，改代码后重启 dsh）
git clone https://github.com/ianzheng001/dsh-mcp-config.git ~/git/dsh-mcp-config
dsh plugin --profile web add link:~/git/dsh-mcp-config
```

**`git+https://` 前缀不能省**：不带 `git+` 的地址会被 pnpm 当成 tarball 下载，报 `ERR_PNPM_TARBALL_EXTRACT`。完整写法是 `git+https://<host>/<org>/<repo>.git`。

`dsh plugin add` 读到包里的 `dsh.bundle.patch` 会自动把 `dsh-mcp-config` 加进 profile 的 bundle 栈；bundle patch 只 **insert** 一条自己的 row（`mcp-config`），不动别人的条目。

### Desktop（DeepSeek Harness.app）

Desktop 走独立的 `desktop` profile，而且 **homebrew 的 dsh 会拒绝操作它**（`profile "desktop" is managed exclusively by the Electron application`）。

**推荐：用 App 自己的插件面板**——左侧「插件」→ 添加插件 → 粘贴仓库地址（或 clone 后的本地绝对路径）。装完 App 会提示重载。

不想点 UI 的话，App 自带的 CLI 带 `manageDesktopProfile` 权限：

```bash
# 1) 完全退出 App（Cmd+Q，确认进程消失）
# 2) 装（注意是 App 自带的 dsh，不是 homebrew 的）
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add git+https://github.com/ianzheng001/dsh-mcp-config.git
# 3) 重新打开 App
open -a "DeepSeek Harness"
```

### 生效与卸载

装完**重启一次** dsh / App（Host 半段没有 HMR）；之后在设置里改 MCP server 都即时生效。

```bash
dsh plugin --profile web remove dsh-mcp-config
# Desktop：用 App 自带的 CLI（同上路径）或插件面板卸载
```

## 用法

打开 **设置 → MCP 服务器**，每个 server 一张卡片：

| 操作 | 说明 |
|------|------|
| 启用 / 停用 | 勾选框。写入/清除该行的 `disabled`，Loader 立刻卸载或挂载 |
| 编辑 | 改 id、serverName、transport（stdio / streamable-http）、command/args/cwd/env 或 url/headers、toolCallTimeoutMs |
| 删除 | 点一次变「确认删除」，4 秒内再点一次才真正删除（删的是 patch 文件里的行） |
| 测试连接 | 用当前编辑中的配置**新开一条临时 MCP 会话**：握手 + `tools/list`，回报 server 名称/版本/工具数，或精确错误（401、ENOENT、超时……） |
| 新增服务器 | 选择写入 home（所有 profile）或当前 profile；建议先「测试连接」再「创建」 |
| 重新读取 | 外部（手改 YAML / git 切分支）改动后刷新页面状态 |

### 认证

#### 静态凭据

- `stdio` server → 写在 `env`（比如 `MY_AUTH_ACCOUNT`），或由 server 自己走浏览器 SSO；
- `streamable-http` server → 写在 `headers`（比如 `Authorization: Bearer <token>`）。

key 命中 `token/secret/password/authorization/cookie/...` 的值默认掩码，点「显示」才展开。

**「测试连接」也是认证校验**：握手成功 = 凭据有效；失败会原样返回上游错误（例如 `HTTP 401 invalid_token`）和子进程 stderr 尾部。它开的是独立连接，不会打断模型当前正在用的那条。

#### 交互式 OAuth（一键认证）

dsh 的 MCP client 本身只吃静态 header，所以插件自己跑授权码流程，再把拿到的 access token 写成该服务器的 `Authorization` 头：

1. 点卡片上的「认证」→ 插件用 MCP SDK 的 `OAuthClientProvider` 发一次真实握手；
2. 服务器回 `401` + `WWW-Authenticate` → SDK 做 RFC 9728 资源元数据发现 → RFC 8414 授权服务器发现 → 需要时动态客户端注册（DCR）→ PKCE 生成授权 URL；
3. 浏览器打开授权 URL，你登录/同意；授权服务器回调到 dsh 自己的 loopback 路由 `/dsh-mcp-config/oauth/callback`；
4. 插件换 token → 写入 patch 的 `headers.Authorization: Bearer …` → Loader 热加载 → 页面变「OAuth 已认证 / 已连接 · N 个工具」。

凭据（client 注册信息、token、PKCE verifier、发现状态）存在 `<DSH_HOME>/mcp-config-oauth.json`，权限 `0600`，不进 patch 文件。

- **授权服务器不支持动态注册**（企业 OIDC 常见）：在编辑面板填 `OAuth client id / client secret`，会随认证流程提交并记住。
- **token 过期**：live 连接用的是静态 header，过期后会掉线，页面上点「重新认证」即可（SDK 会用 refresh token 刷新）。
- 「重新认证」按钮在 `streamable-http` 卡片上；`stdio` 服务器不需要 OAuth。

### 写入位置

- **编辑/启停/删除**：写在该行**当前所在**的文件，不做跨文件复制。
- **新增**：默认写 home 层；界面可切到当前 profile。

注意 home 层对所有 profile 生效，所以停用一个 home 层 server 也会影响 desktop / headless profile。

## 安全边界

- 页面通过 `POST /dsh-mcp-config/api`（同源、仅 loopback）与 Host 通信，没有额外鉴权：和 dsh 自身 Settings 一致，**不要**把 dsh 的 Web 端口暴露到非信任网络。
- 凭据以明文保存在 patch 文件里（和手写 YAML 一样）。写入保留原文件权限位；新建文件用 `0600`。
- 写文件是「临时文件 + rename」的原子写，Loader watcher 不会看到半截文件；每次写入带 SHA-256 前置校验，文件被别处改过时拒绝覆盖并回读提示。

## 开发

```bash
npm test          # patch 层 / Host 路由端到端 / 真实 stdio 握手 / bundle 形态 / OAuth 全链路
npm run harness   # 本地 UI 验证页（会复制真实 patch 到临时目录，绝不写你的真配置）
```

Host 半段没有 HMR：改 `lib/index.js` 需要重启 dsh；改 `lib/client.js` 会被 dsh 的 client-hmr（500ms 轮询 bundle 文件）热替换，刷新设置页即可。

### 坑：client bundle 必须整体包在 IIFE 里

Web shell 会把同一批缺失的 bundle 拼成一个 combo URL（`/plugins/??a/client.js,b/client.js`）塞进**同一个顶层作用域**执行。顶层 `const factory` 一旦出现两次，整个 combo 就 `Identifier 'factory' has already been declared`，这一批插件全部 import 失败，而且报错只说 "import failed (see console for the import error)"。`test/bundle.test.mjs` 用「拼接两份再编译」钉住这条约束。

注册 id 要同时给 **Loader 条目 id**（如 `mcp-config`）和**包名**（`dsh-mcp-config`）。

## 已知限制

- 只能管理用户 patch 里的行；bundle/插件包自带的 MCP 条目在卡片上标 `plugin`、只读。
- 不支持给单个 profile 覆盖 home 层某个 server 的配置（启停是原地写 `disabled`）。
- 不支持从 `.mcp.json` 一键导入。

## 许可

MIT，见 [LICENSE](LICENSE)。
