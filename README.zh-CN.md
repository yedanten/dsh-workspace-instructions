# dsh-workspace-instructions

选择一个 Markdown 文件来提供会话的**工作区**指令，而不是始终从工作区根目录加载 `AGENTS.md` / `CLAUDE.md`。

[English](README.md) | [简体中文](README.zh-CN.md)

## 功能

- 新建会话时，模式控件旁会显示**工作区指令文件**标签。默认是 `AGENTS.md`；`选择其他 Markdown 文件…` 会打开系统文件对话框，且仅限当前工作区内的 `.md` 文件。
- 选择器属于新建会话阶段：首条任务消息发出、对话开始后，这一行会自动消失。
- 所选文件名会持续显示在会话标题旁（紧挨模式标签）；文件不存在时以警告色提示。
- 工作区根目录只加载所选文件。项目根目录到当前工作目录之间的各级目录仍会加载 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md` 和 `CLAUDE.local.md`；成功的 `read` / `write` / `edit` 调用仍会发现嵌套的指令文件，工作目录变化时会重建整批内容。
- 会话派生的子 agent 加载与其委派 agent 相同的工作区文件，而不是回退到 `AGENTS.md`；嵌套子 agent 沿链继承。只有针对子会话本身记录的选材优先。
- 用户全局链（`$DSH_HOME/AGENTS.md`、`~/.agents/AGENTS.md`）不受影响。

## 加载顺序

上下文仍按「由宽到窄」读取：先是 DSH 自带插件提供的用户全局基线，然后是本 bundle 的工作区批次，按根到叶的顺序。`<system-reminder>` 外框、`Additional instructions from:` / `Updated instructions from:` / `Instructions removed:` 措辞、字节预算，以及「先宽后窄」的省略策略都与自带插件一致。两个批次是独立消息，因为全局批次由另一个插件负责；它们内容的先后顺序不变。

## 工作区链路是如何被重定向的

`dsh-web-app` 禁用了 profile 级的 `agent-instructions` 行，每个 agent preset（`standard`、`ptc`、`cordis` 等）各自声明带默认工作区候选的副本。因此本 bundle 会：

1. 通过 `fiber.update(config, true)` 清空所有已挂载 preset 副本的工作区候选列表——这是一次运行时更新，不会写入 profile patch，后续进程启动会恢复自带定义；
2. 每个会话只加载一次工作区链，内容来自所选文件加上未改动的逐目录候选；
3. 这些 preset 副本的全局链保持不变。

preset 副本会在新 Agent 绑定之前调整。已经在运行的 Agent 仍保持挂载时的版本，因此需要重启应用（或在重启后新建会话）才能让这些对话看到变化。

## 安装

要求 DeepSeek Harness `0.2.2-rc.1` 或更高版本。

1. 克隆仓库：

   ```sh
   git clone https://github.com/yedanten/dsh-workspace-instructions.git
   ```

2. 将 bundle 安装到 DSH profile：打开 **Plugins → Add plugin**，选择克隆得到的 `dsh-workspace-instructions` 目录，然后启用 `dsh-workspace-instructions` bundle。

   若 profile 通过 GitHub 锁定依赖，也可以改为声明依赖：

   ```json
   "dependencies": {
     "dsh-workspace-instructions": "github:yedanten/dsh-workspace-instructions"
   }
   ```

   并在同一个 `package.json` 的 `dsh.profile.bundles` 中加入 `dsh-workspace-instructions`，然后在 profile 目录执行 `pnpm install`。

3. 重启 DSH，或新建会话，使已挂载的 preset 副本按新行为调整。

运行测试：`node --test`。

## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `maxBytes` | `65536` | 单条渲染消息中工作区链的字节预算 |
| `maxSourceBytes` | `1048576` | 单个源指令文件的大小上限 |

```yaml
- id: workspace-instructions
  name: 'dsh-workspace-instructions'
  config:
    maxBytes: 65536
```

## 宿主路由

Client 调用同源路由，并受 origin 与 host 校验保护：

| 路由 | 用途 |
|---|---|
| `GET /workspace-instructions/state?sessionId=…` | 当前选材、工作区目录、文件是否存在 |
| `POST /workspace-instructions/select` | 设置工作区相对的 `.md` 路径 |
| `POST /workspace-instructions/pick` | 打开系统文件对话框并保存结果 |
| `GET /workspace-instructions/preview?sessionId=…` | 工作区链此刻会加载的内容 |

## 运行要求

- DeepSeek Harness `0.2.2-rc.1`（Web GUI）。
- 系统文件对话框在 Windows 上需要带 WinForms 的 PowerShell，在 macOS 上需要 `osascript`，在 Linux 上需要 `zenity`。

## 限制

- 选择器只接受会话工作目录内的 `.md` 文件。
- 空会话（尚未开始对话）的选材保存在 Host 内存中；进程重启后由 Session 日志中已持久化的基线恢复。
- 子 agent 继承沿实时的 `parentSession` 链进行。在不同工作目录中启动的子 agent 会在该目录内解析继承来的相对文件名。
- 本 bundle 加载后，在 Web 编辑器中修改过的 preset 定义需要重新加载插件行（或重启）才能再次被调整。

## 许可证

[MIT](LICENSE)
