# dsh-web-shell

DeepSeek Harness 的右侧停靠 Web Shell 插件。浏览器端使用 xterm.js，通过 `/api/shell` WebSocket 与宿主侧 PTY 桥接，支持 bash / zsh 切换。

## 功能

- **右侧停靠**：打开后主对话栏自动让位，不再遮挡会话内容（需要较新的 `dsh-client-ui-layout`）。
- **可调宽度**：拖动 shell 左边缘即可调整宽度（360–960px）。
- **折叠 / 关闭分离**：
  - **折叠**：隐藏面板但保持 WebSocket / PTY 会话存活，再次展开恢复同一个 shell。
  - **关闭**：断开连接并终止 PTY，再次打开会创建新 shell。
- **bash / zsh 切换**：切换时关闭旧 PTY 并启动新 shell。

## 安装

### 从 GitHub

```sh
dsh plugin --profile web add github:JesmonX/dsh-web-shell
```

如果插件管理器不支持 GitHub 简写，可先 clone 再本地安装：

```sh
git clone https://github.com/JesmonX/dsh-web-shell.git
dsh plugin --profile web add ./dsh-web-shell
```

### 从 npm

```sh
dsh plugin --profile web add dsh-web-shell
```

安装后启动：

```sh
dsh web
```

点击窗口右侧的 **❯_** 按钮打开 shell。

## 使用

| 操作 | 位置 | 行为 |
| --- | --- | --- |
| 打开 / 展开 | 右侧 ❯_ 按钮 | 打开 shell 或从折叠中恢复 |
| 折叠 | 面板标题栏 **›** 按钮 | 隐藏面板，保持会话存活 |
| 关闭 | 面板标题栏 **×** 按钮 | 终止会话 |
| 切换 shell | 标题栏 bash / zsh | 启动新的 PTY |
| 调整宽度 | 面板左边缘拖拽 | 360–960px |

## 配置

`cordis.patch.yml` 注入宿主侧默认配置：

```yaml
- id: web-shell
  name: 'dsh-web-shell'
  inject: [webServer, subprocess, webRuntime]
  config:
    shells: [bash, zsh]
    defaultShell: bash
    rows: 40
    cols: 120
    graceMs: 5000
```

可在后续 patch 层覆盖：

- `shells`：可选 shell 列表，目前支持 `bash` 和 `zsh`。
- `defaultShell`：浏览器未选择时使用的默认 shell。
- `cwd`：新终端起始目录，默认 `process.cwd()`。
- `rows` / `cols`：初始终端行列数。
- `graceMs`：PTY 清理宽限时间。

## 兼容性说明

- 插件的 `shell.overlay` 槽位由 `dsh-client-ui-layout` 声明。建议使用包含该槽位的 DeepSeek Harness 版本（`>=0.1.0-rc.5`）。
- 完整“主对话栏让位”效果需要 `dsh-client-ui-layout` 提供 `ctx.layout.setShellWidth` / `closeShell` 等右侧停靠 API。
- 如果宿主 UI 版本较旧（有 `shell.overlay` 但没有右侧停靠 API），插件会自动降级为纯 overlay 模式：shell 仍可打开、折叠、关闭和拖拽，但主对话栏不会让位。

## 从源码构建

本仓库已附带构建好的 `lib/`，可直接作为插件安装。如需从源码构建，推荐放入 `deepseek-harness` 的 `packages/extensions/web-shell` 目录，使用 monorepo 的构建链：

```sh
pnpm --filter dsh-web-shell run bundle
```

仅做类型检查：

```sh
npm install
npm run typecheck
```

## 安全

Shell 以与 dsh 进程相同的操作系统权限运行。升级路由使用与 `/api` 网关相同的 loopback / trusted-host / origin 防护；非 loopback 部署必须通过 `trustedHosts` 显式声明。

## License

MIT
