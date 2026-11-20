# dsh-workspace-instructions

Pick which markdown file supplies a session's **workspace** instructions, instead of always loading `AGENTS.md` / `CLAUDE.md` from the workspace root.

[English](README.md) | [简体中文](README.zh-CN.md)

## What it does

- New Session shows a **workspace instruction file** chip next to the mode control. The default is `AGENTS.md`; `选择其他 Markdown 文件…` opens the system file dialog, limited to `.md` files inside the current workspace.
- The picker belongs to the New Session stage: once the first task message starts the conversation, the Hero row disappears by itself.
- The chosen file name stays visible beside the session title, right next to the mode label, and warns in the warning colour when the file no longer exists.
- The workspace root loads exactly the chosen file. Directories between the project root and the working directory keep loading `AGENTS.md`, `CLAUDE.md`, `AGENTS.local.md`, and `CLAUDE.local.md`; successful `read` / `write` / `edit` calls still discover nested instruction files, and a working-directory change rebuilds the whole batch.
- A subagent spawned by a session loads the same workspace file as its delegating agent instead of falling back to `AGENTS.md`, and nested subagents inherit through the chain. Only a selection recorded for the child session itself takes precedence.
- The user-global chain (`$DSH_HOME/AGENTS.md`, `~/.agents/AGENTS.md`) is never touched.

## Loading order

Context still reads broad to specific: the shipped plugin's user-global baseline first, then this bundle's workspace batch in root-to-leaf order. The `<system-reminder>` frame, the `Additional instructions from:` / `Updated instructions from:` / `Instructions removed:` vocabulary, the byte budget, and the broad-before-specific omission policy match the shipped plugin. The two batches are separate messages because the global one is owned by a different plugin; the order of their content is unchanged.

## How the workspace chain is redirected

`dsh-web-app` disables the profile-level `agent-instructions` row, and each agent preset (`standard`, `ptc`, `cordis`, …) declares its own copy with the default workspace candidates. This bundle therefore:

1. empties the workspace candidate lists of every currently mounted preset copy through `fiber.update(config, true)` — a runtime update that is never written to the profile patch, so a later process start restores the shipped definitions;
2. loads the workspace chain itself, once per session, from the selected file plus the unchanged per-directory candidates;
3. leaves the global chain of those same preset copies running untouched.

A preset copy is adjusted before a new Agent binds to it. Agents that are already running keep the revision they were mounted with, so restart the application (or open a New Session after a restart) to see the change for those conversations.

## Installation

Requires DeepSeek Harness `0.2.2-rc.1` or newer.

1. Clone the repository:

   ```sh
   git clone https://github.com/yedanten/dsh-workspace-instructions.git
   ```

2. Install the bundle into the DSH profile: open **Plugins → Add plugin**, choose the cloned `dsh-workspace-instructions` directory, then enable the `dsh-workspace-instructions` bundle.

   A profile that pins packages from GitHub can list it as a dependency instead:

   ```json
   "dependencies": {
     "dsh-workspace-instructions": "github:yedanten/dsh-workspace-instructions"
   }
   ```

   add `dsh-workspace-instructions` to `dsh.profile.bundles` in the same `package.json`, then run `pnpm install` in the profile directory.

3. Restart DSH, or open a New Session, so the mounted preset copies are adjusted for the new behaviour.

Run the test suite with `node --test`.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `maxBytes` | `65536` | Byte budget for the workspace chain in one rendered message |
| `maxSourceBytes` | `1048576` | Cap on one source instruction file |

```yaml
- id: workspace-instructions
  name: 'dsh-workspace-instructions'
  config:
    maxBytes: 65536
```

## Host routes

The Client calls same-origin routes guarded by origin and host checks:

| Route | Purpose |
|---|---|
| `GET /workspace-instructions/state?sessionId=…` | Current selection, workspace directory, existence |
| `POST /workspace-instructions/select` | Set a workspace-relative `.md` path |
| `POST /workspace-instructions/pick` | Open the native file dialog and store the result |
| `GET /workspace-instructions/preview?sessionId=…` | What the workspace chain would load right now |

## Requirements

- DeepSeek Harness `0.2.2-rc.1` (Web GUI).
- The native dialog needs PowerShell with WinForms on Windows, `osascript` on macOS, or `zenity` on Linux.

## Limits

- The picker accepts only `.md` files inside the session working directory.
- A blank Session keeps its selection in Host memory; after a process restart the durable baseline already in the Session log restores it.
- Subagent inheritance follows the live `parentSession` chain. A subagent started in a different working directory resolves the inherited relative name inside that directory.
- Preset definitions edited from the Web editor after this bundle loaded require reloading the plugin row (or restarting) to be adjusted again.

## License

[MIT](LICENSE)
