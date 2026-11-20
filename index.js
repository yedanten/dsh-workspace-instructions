/**
 * `dsh-workspace-instructions` — per-session workspace instruction file.
 *
 * The shipped `agent-instructions` plugin keeps loading the user-global chain.
 * This bundle takes over the workspace chain only: the workspace root (the
 * session working directory) loads the markdown file selected for the session
 * instead of a fixed `AGENTS.md` / `CLAUDE.md` pair, while every directory
 * between the project root and the working directory keeps the shipped
 * candidates, and successful filesystem touches still discover nested files.
 * A subagent inherits the file its delegating agent selected.
 *
 * @module dsh-workspace-instructions
 */
import { randomUUID } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
import {
  DEFAULT_FILE,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_SOURCE_BYTES,
  baselineChanges,
  diffWorkspaceState,
  discoverWorkspaceFiles,
  findProjectRoot,
  inheritedWorkspaceSelection,
  instructionDigest,
  isMarkdownName,
  isWithin,
  loadWorkspaceFiles,
  normalizeSelection,
  renderBaseline,
  renderChanges,
  statFile,
  visibleWorkspaceBaseline,
  visibleWorkspaceState,
} from './lib/core.js'
import { pickMarkdownFile } from './lib/dialog.js'
import { registerRoutes } from './lib/routes.js'

export const name = 'workspace-instructions'
export const inject = ['agents', 'workingDirectory']

const FILE_TOUCH_TOOLS = new Set(['read', 'write', 'edit'])

/**
 * Create one identified user-role message.
 *
 * This mirrors the public `createUserMessage` helper without importing a
 * package the profile cannot resolve for a linked bundle: identity is a fresh
 * UUID and the role tag is the only addition to the caller's input.
 *
 * @param {{ content: Array<{ type: 'text', text: string }>, source: object }} input
 * @returns {object}
 */
function createUserMessage(input) {
  return { ...input, role: 'user', id: randomUUID() }
}

function readConfig(config) {
  const maxBytes = Number(config?.maxBytes ?? DEFAULT_MAX_BYTES)
  const maxSourceBytes = Number(config?.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES)
  return {
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES,
    maxSourceBytes:
      Number.isFinite(maxSourceBytes) && maxSourceBytes > 0 ? maxSourceBytes : DEFAULT_MAX_SOURCE_BYTES,
  }
}

function fileArgument(exec) {
  if (!FILE_TOUCH_TOOLS.has(exec.name)) return undefined
  const args = exec.arguments
  if (args === null || typeof args !== 'object') return undefined
  const value = args.file_path
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Mount the workspace-instruction owner.
 * @param {object} ctx Cordis context
 * @param {object} config row config
 */
export function apply(ctx, config) {
  const settings = readConfig(config)
  /** @type {Map<string, string>} session id → workspace-relative markdown path */
  const selections = new Map()
  /** @type {Map<string, Set<string>>} session id → directories reached by fs tools */
  const touchedDirectories = new Map()
  /** @type {Map<string, AbortController>} session id → in-flight native picker */
  const activePickers = new Map()

  const agentOf = (sessionId) => {
    let agent = ctx.agents.get(sessionId)
    if (agent === undefined) {
      try {
        agent = ctx.agents.list().find((candidate) => String(candidate.session.id) === String(sessionId))
      } catch {
        agent = undefined
      }
    }
    return agent
  }

  const headerOf = (sessionId) => {
    try {
      return agentOf(sessionId)?.session?.header
    } catch {
      return undefined
    }
  }

  const selectionOf = (sessionId) =>
    selections.get(sessionId) ??
    inheritedWorkspaceSelection(sessionId, {
      explicitSelection: (id) => selections.get(id),
      headerOf,
    }) ??
    DEFAULT_FILE

  const sessionOf = (sessionId) => {
    const agent = agentOf(sessionId)
    if (agent === undefined) return undefined
    let directory
    try {
      directory = ctx.workingDirectory.get(agent.session)
    } catch {
      directory = undefined
    }
    if (typeof directory !== 'string' || directory === '') return undefined
    return { agent, directory: resolve(directory) }
  }

  const describeSession = async (sessionId) => {
    const resolved = sessionOf(sessionId)
    if (resolved === undefined) return undefined
    const file = selectionOf(sessionId)
    const exists = (await statFile(join(resolved.directory, file))) !== undefined
    return { directory: resolved.directory, exists }
  }

  const setSelection = (sessionId, file) => {
    const normalized = normalizeSelection(file)
    if (normalized === undefined) return { ok: false, error: 'Choose a workspace-relative .md file.' }
    const resolved = sessionOf(sessionId)
    if (resolved === undefined) return { ok: false, error: 'This session is not ready yet.' }
    const absolutePath = join(resolved.directory, normalized)
    if (!isWithin(resolved.directory, absolutePath)) {
      return { ok: false, error: 'The file must live inside the current workspace.' }
    }
    selections.set(sessionId, normalized)
    return { ok: true, file: normalized }
  }

  const resetSelection = (sessionId) => {
    selections.set(sessionId, DEFAULT_FILE)
  }

  const pick = async (sessionId) => {
    const resolved = sessionOf(sessionId)
    if (resolved === undefined) return { ok: false, error: 'This session is not ready yet.' }
    const previous = activePickers.get(sessionId)
    previous?.abort(new Error('superseded'))
    const controller = new AbortController()
    activePickers.set(sessionId, controller)
    try {
      const picked = await pickMarkdownFile({
        directory: resolved.directory,
        signal: controller.signal,
      })
      if (picked === null) return { ok: true, file: null }
      const absolutePath = resolve(picked)
      if (!isWithin(resolved.directory, absolutePath)) {
        return { ok: false, error: 'The chosen file is outside the current workspace.' }
      }
      if (!isMarkdownName(absolutePath)) {
        return { ok: false, error: 'Choose a markdown (.md) file.' }
      }
      const info = await statFile(absolutePath)
      if (info === undefined) return { ok: false, error: 'The chosen file could not be read.' }
      const relativePath = relative(resolved.directory, absolutePath).replaceAll('\\', '/')
      return { ok: true, file: relativePath }
    } finally {
      if (activePickers.get(sessionId) === controller) activePickers.delete(sessionId)
    }
  }

  ctx.inject(['webServer'], (scope) => {
    const disposers = registerRoutes(
      scope,
      {
        describeSession,
        getSelection: selectionOf,
        setSelection,
        pick,
        resetSelection,
        preview: async (sessionId) => {
          const resolved = sessionOf(sessionId)
          if (resolved === undefined) return { ok: false, error: 'session is not available' }
          const selection = selectionOf(sessionId)
          const projectRoot = await findProjectRoot(resolved.directory)
          const candidates = await discoverWorkspaceFiles({
            cwd: resolved.directory,
            projectRoot,
            selection,
          })
          const files = await loadWorkspaceFiles(candidates, settings.maxSourceBytes)
          const rendered = renderBaseline(files, settings.maxBytes)
          return {
            ok: true,
            selection,
            projectRoot,
            files: files.map((file) => ({
              path: file.displayPath,
              bytes: Buffer.byteLength(file.content, 'utf8'),
            })),
            renderedBytes: rendered === undefined ? 0 : Buffer.byteLength(rendered.text, 'utf8'),
          }
        },
      },
      ctx.logger ?? console,
    )
    scope.effect(() => () => {
      for (const dispose of disposers) dispose()
      for (const controller of activePickers.values()) controller.abort(new Error('plugin disposed'))
      activePickers.clear()
    }, 'workspace-instructions: browser routes')
  })

  ctx.on('tools/result', (exec, result) => {
    if (result?.isError === true) return
    const agent = exec.agent
    if (agent === undefined) return
    const filePath = fileArgument(exec)
    if (filePath === undefined) return
    const sessionId = agent.session.id
    const base = ctx.workingDirectory.get(agent.session)
    if (typeof base !== 'string' || base === '') return
    const directory = resolve(base, filePath, '..')
    if (!isWithin(resolve(base), directory)) return
    let set = touchedDirectories.get(sessionId)
    if (set === undefined) {
      set = new Set()
      touchedDirectories.set(sessionId, set)
    }
    set.add(directory)
  })

  /**
   * Make every shipped agent preset stop loading workspace instruction files.
   *
   * `dsh-web-app` disables the profile-level `agent-instructions` row and each
   * preset declares its own copy. That copy owns the user-global chain, which
   * this bundle must not change, so only its workspace candidate lists are
   * emptied. The update is applied through the live fiber with `noSave`, so the
   * profile patch on disk is untouched and a later process start reapplies it.
   */
  const applyPresetOverrides = async (scope) => {
    try {
      const editor = scope.get('configEditor')
      if (editor === undefined) {
        ctx.logger?.warn?.('workspace-instructions: configEditor is unavailable; preset rows were left unchanged')
        return
      }
      for (const entry of editor.entries()) {
        const moduleName = entry?.options?.name ?? entry?.name
        if (moduleName !== '@deepseek-ai/dsh-agent-preset') continue
        const config = entry.fiber?.effectiveConfig ?? entry.options?.config
        if (config === null || typeof config !== 'object' || !Array.isArray(config.plugins)) continue
        let changed = false
        const plugins = config.plugins.map((row) => {
          if (row === null || typeof row !== 'object') return row
          if (row.name !== '@deepseek-ai/dsh-agent-instructions') return row
          const current = row.config !== null && typeof row.config === 'object' ? row.config : {}
          if (
            Array.isArray(current.instructionFileCandidates) &&
            current.instructionFileCandidates.length === 0 &&
            Array.isArray(current.localInstructionFileCandidates) &&
            current.localInstructionFileCandidates.length === 0
          ) {
            return row
          }
          changed = true
          return {
            ...row,
            config: {
              ...current,
              instructionFileCandidates: [],
              localInstructionFileCandidates: [],
            },
          }
        })
        if (!changed) continue
        await entry.fiber?.update({ ...config, plugins }, true)
        ctx.logger?.info?.('workspace-instructions: workspace candidates cleared in preset %s', entry.id)
      }
    } catch (error) {
      ctx.logger?.warn?.('workspace-instructions: clearing preset workspace candidates failed: %o', error)
    }
  }

  ctx.inject(['configEditor'], (scope) => {
    void applyPresetOverrides(scope)
  })

  const compose = async (agent, decision, claimed, signal) => {
    const sessionId = agent.session.id
    const cwd = resolve(await ctx.workingDirectory.ensure(agent, signal))
    const projectRoot = await findProjectRoot(cwd)

    if (!selections.has(sessionId)) {
      const restored = visibleWorkspaceBaseline(agent, claimed)?.fileSelection
      if (typeof restored === 'string' && normalizeSelection(restored) === restored) {
        selections.set(sessionId, restored)
      }
    }
    const selection = selectionOf(sessionId)

    const extraDirs = []
    const touched = touchedDirectories.get(sessionId)
    if (touched !== undefined) {
      for (const directory of touched) {
        if (isWithin(cwd, directory)) extraDirs.push(directory)
      }
    }

    const candidates = await discoverWorkspaceFiles({
      cwd,
      projectRoot,
      selection,
      extraDirs,
    })
    const desired = await loadWorkspaceFiles(candidates, settings.maxSourceBytes)

    const identity = JSON.stringify({
      cwd,
      projectRoot,
      selection,
      maxBytes: settings.maxBytes,
    })
    const visibleBaseline = visibleWorkspaceBaseline(agent, claimed)
    const replacePreviousBaseline = visibleBaseline !== undefined && visibleBaseline.fileIdentity !== identity

    if (visibleBaseline === undefined || replacePreviousBaseline) {
      const rendered = renderBaseline(desired, settings.maxBytes, replacePreviousBaseline)
      if (rendered === undefined) return decision
      const message = createUserMessage({
        content: [{ type: 'text', text: rendered.text }],
        source: {
          kind: 'agent-instructions',
          form: 'instructions',
          fileBaseline: true,
          fileIdentity: identity,
          fileSelection: selection,
          fileChanges: baselineChanges(desired),
        },
      })
      return { ...decision, messages: [...decision.messages, message] }
    }

    const current = visibleWorkspaceState(agent, claimed)
    const changes = diffWorkspaceState(current, desired)
    if (changes.length === 0) return decision
    const text = renderChanges(changes, settings.maxBytes)
    if (text === undefined) return decision
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        fileChanges: changes.map((change) => ({
          action: change.action,
          path: change.path,
          digest: change.digest ?? instructionDigest(''),
        })),
      },
    })
    return { ...decision, messages: [...decision.messages, message] }
  }

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      return await compose(agent, decision, messages, signal)
    } catch (error) {
      if (signal.aborted) return decision
      ctx.logger?.warn?.('workspace-instructions: composing workspace instructions failed: %o', error)
      return decision
    }
  })
}

export { DEFAULT_FILE }
