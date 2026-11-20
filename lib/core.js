/**
 * Workspace instruction discovery, rendering and reconciliation for the
 * `dsh-workspace-instructions` bundle.
 *
 * The shipped `agent-instructions` plugin keeps owning the user-global chain.
 * This module owns the workspace chain only: which file the workspace root
 * loads (the user's pick, default `AGENTS.md`, inherited from the delegating
 * agent by a subagent) plus the ordinary `AGENTS.md` / `CLAUDE.md` candidates
 * of every directory between the project root and the session working
 * directory.
 *
 * Message framing matches the shipped plugin so the model sees one consistent
 * `<system-reminder>` vocabulary; the source kind is the same producer-owned
 * `agent-instructions`, but this bundle never writes the shipped plugin's
 * `changes` / `baseline` members, so the shipped plugin ignores these rows.
 *
 * @module dsh-workspace-instructions/core
 */
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { readFile, stat } from 'node:fs/promises'

/** File the workspace root loads when the user does not pick another one. */
export const DEFAULT_FILE = 'AGENTS.md'
/** Base candidates every non-root directory keeps loading. */
export const BASE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']
/** Additive local overlays every non-root directory keeps loading. */
export const LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md']
/** Directory names that mark the project root. */
export const PROJECT_ROOT_MARKERS = ['.git']
/** Default per-message byte budget, matching the shipped plugin's base row. */
export const DEFAULT_MAX_BYTES = 65536
/** Default cap on one source instruction file. */
export const DEFAULT_MAX_SOURCE_BYTES = 1048576

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'
const BASELINE_INTRO =
  'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.'
const REPLACEMENT_INTRO =
  'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.'
const CHANGE_GUIDANCE =
  'Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.'

/**
 * Whether one path names a markdown file the picker may accept.
 * @param {string} value
 * @returns {boolean}
 */
export function isMarkdownName(value) {
  return typeof value === 'string' && /\.md$/i.test(value)
}

/**
 * Normalize a workspace-relative markdown path supplied by the browser.
 * @param {unknown} value
 * @returns {string | undefined} normalized POSIX-relative path, or undefined
 */
export function normalizeSelection(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replaceAll('\\', '/')
  if (trimmed === '' || isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) return undefined
  const parts = trimmed.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return undefined
  if (!isMarkdownName(trimmed)) return undefined
  return parts.join('/')
}

/**
 * Resolve the workspace instruction file a derived subagent inherits.
 *
 * A spawned subagent starts with an empty session surface, so it has no
 * baseline that could restore a selection and must not silently fall back to
 * the default file. It loads the file its nearest ancestor selected instead.
 * The walk follows the durable `parentSession` lineage only while the ancestor
 * is itself a subagent, and stops at the first ancestor with an explicit
 * selection so a parent changing its file keeps propagating to new children.
 *
 * @param {string} sessionId subagent session id
 * @param {object} lookup session lookups supplied by the owner
 * @param {(sessionId: string) => string | undefined} lookup.explicitSelection explicit selection of one session
 * @param {(sessionId: string) => { origin?: string, parentSession?: string } | undefined} lookup.headerOf session header lookup
 * @returns {string | undefined} inherited workspace-relative markdown path, or undefined
 */
export function inheritedWorkspaceSelection(sessionId, { explicitSelection, headerOf }) {
  const header = headerOf(sessionId)
  if (header === undefined || header.origin !== 'subagent') return undefined
  const seen = new Set([String(sessionId)])
  let parentId = header.parentSession
  while (typeof parentId === 'string' && parentId !== '' && !seen.has(parentId)) {
    seen.add(parentId)
    const explicit = explicitSelection(parentId)
    if (explicit !== undefined) return explicit
    const parentHeader = headerOf(parentId)
    if (parentHeader === undefined || parentHeader.origin !== 'subagent') return undefined
    parentId = parentHeader.parentSession
  }
  return undefined
}

/**
 * Whether `child` resolves inside `parent`.
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Stat one regular file without throwing.
 * @param {string} path
 * @returns {Promise<{ size: number } | undefined>}
 */
export async function statFile(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? { size: info.size } : undefined
  } catch {
    return undefined
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Walk upward to the first directory holding a project-root marker.
 * @param {string} cwd
 * @param {string[]} [markers]
 * @returns {Promise<string>}
 */
export async function findProjectRoot(cwd, markers = PROJECT_ROOT_MARKERS) {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await exists(join(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * Build the inclusive broad-to-specific directory chain from root down to cwd.
 * @param {string} root
 * @param {string} cwd
 * @returns {string[]}
 */
export function ancestorChain(root, cwd) {
  const chain = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

/**
 * Render a project-relative display path without leaking the host root.
 * @param {string} root
 * @param {string} absolutePath
 * @returns {string}
 */
export function displayPathFor(root, absolutePath) {
  return relative(root, absolutePath).replaceAll('\\', '/')
}

/**
 * Discover the workspace instruction candidates for one session snapshot.
 *
 * The session working directory is the workspace root the user picks from: its
 * candidates are exactly the selected file. Every directory between the project
 * root and the session working directory keeps the shipped plugin's base and
 * local candidates. Directories reached through successful filesystem touches
 * are added as extra scopes, mirroring the shipped plugin's nested discovery.
 *
 * @param {object} input
 * @param {string} input.cwd session working directory
 * @param {string} input.projectRoot discovered project root
 * @param {string} input.selection workspace-relative markdown path
 * @param {string[]} [input.extraDirs] extra directories under cwd to scan
 * @returns {Promise<Array<{ scope: string, absolutePath: string, displayPath: string, size: number }>>}
 */
export async function discoverWorkspaceFiles({ cwd, projectRoot, selection, extraDirs = [] }) {
  const base = resolve(cwd)
  const root = resolve(projectRoot)
  const dirs = []
  const seenDirs = new Set()
  const addDir = (dir) => {
    const key = resolve(dir)
    if (seenDirs.has(key)) return
    seenDirs.add(key)
    dirs.push(key)
  }
  for (const dir of ancestorChain(root, base)) addDir(dir)
  const extra = extraDirs
    .map((dir) => resolve(dir))
    .filter((dir) => isWithin(base, dir))
    .sort((left, right) => left.length - right.length)
  for (const dir of extra) addDir(dir)

  const files = []
  const seenFiles = new Set()
  for (const dir of dirs) {
    const names = dir === base ? [selection] : [...BASE_CANDIDATES, ...LOCAL_CANDIDATES]
    for (const name of names) {
      if (typeof name !== 'string' || name === '') continue
      const absolutePath = join(dir, name)
      if (seenFiles.has(absolutePath)) continue
      const info = await statFile(absolutePath)
      if (info === undefined) continue
      seenFiles.add(absolutePath)
      files.push({
        scope: displayPathFor(root, absolutePath),
        absolutePath,
        displayPath: displayPathFor(root, absolutePath),
        size: info.size,
      })
    }
  }
  return files
}

/**
 * Read one instruction source within the configured cap.
 * @param {string} absolutePath
 * @param {number} maxSourceBytes
 * @returns {Promise<string | undefined>}
 */
export async function readInstruction(absolutePath, maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES) {
  try {
    const info = await stat(absolutePath)
    if (!info.isFile()) return undefined
    if (info.size > maxSourceBytes) return undefined
    const content = await readFile(absolutePath, 'utf8')
    if (Buffer.byteLength(content, 'utf8') > maxSourceBytes) return undefined
    return content
  } catch {
    return undefined
  }
}

/**
 * Compute the exact content identity of one instruction file.
 * @param {string} content
 * @returns {string}
 */
export function instructionDigest(content) {
  return createHash('sha1').update(content).digest('hex')
}

/**
 * Compute the whitespace-insensitive identity used for sibling deduplication.
 * @param {string} content
 * @returns {string}
 */
export function trimmedDigest(content) {
  return instructionDigest(content.trim())
}

/**
 * Load candidate contents and drop trimmed-content duplicates inside one
 * directory, matching the shipped plugin's per-candidate-group behaviour.
 * @param {Array<{ scope: string, absolutePath: string, displayPath: string }>} candidates
 * @param {number} maxSourceBytes
 * @returns {Promise<Array<{ scope: string, absolutePath: string, displayPath: string, content: string, digest: string }>>}
 */
export async function loadWorkspaceFiles(candidates, maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES) {
  const loaded = []
  for (const candidate of candidates) {
    const content = await readInstruction(candidate.absolutePath, maxSourceBytes)
    if (content === undefined) continue
    loaded.push({ ...candidate, content, digest: instructionDigest(content) })
  }
  const keptDigests = new Map()
  const kept = []
  for (const file of loaded) {
    const group = dirname(file.displayPath)
    let digests = keptDigests.get(group)
    if (digests === undefined) {
      digests = new Set()
      keptDigests.set(group, digests)
    }
    const key = trimmedDigest(file.content)
    if (digests.has(key)) continue
    digests.add(key)
    kept.push(file)
  }
  return kept
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && (bytes.readUInt8(end) & 192) === 128) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

function escapeFrameBody(body) {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')
}

function budgetMarker(maxBytes, omitted, truncated) {
  if (omitted.length === 0 && truncated.length === 0) return ''
  const parts = []
  if (omitted.length > 0) parts.push(`omitted ${omitted.join(', ')}`)
  if (truncated.length > 0) {
    parts.push(
      `truncated ${truncated
        .map((item) => `${item.path} from ${item.originalBytes} to ${item.includedBytes} bytes`)
        .join(', ')}`,
    )
  }
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}`
}

function buildFrame(text) {
  return `${SYSTEM_REMINDER_OPEN}\n${escapeFrameBody(text)}\n${SYSTEM_REMINDER_CLOSE}`
}

function sectionText(file) {
  return `Instructions from: ${file.displayPath}\n\n${file.content}`
}

/**
 * Render one baseline frame under a per-chain byte budget.
 *
 * Broader files are omitted before the most specific file is truncated, then
 * the notice alone is returned when even an empty heading cannot fit.
 *
 * @param {Array<{ displayPath: string, content: string }>} files broad-to-specific
 * @param {number} maxBytes
 * @param {boolean} [replacePreviousBaseline]
 * @returns {{ text: string, omitted: string[], truncated: Array<{ path: string, originalBytes: number, includedBytes: number }> } | undefined}
 */
export function renderBaseline(files, maxBytes, replacePreviousBaseline = false) {
  if (files.length === 0) return undefined
  const intro = replacePreviousBaseline ? REPLACEMENT_INTRO : BASELINE_INTRO
  const sections = files.map(sectionText)
  const full = buildFrame([intro, ...sections].join('\n\n'))
  if (byteLength(full) <= maxBytes) return { text: full, omitted: [], truncated: [] }

  for (let start = 1; start < sections.length; start += 1) {
    const included = sections.slice(start)
    const omitted = files.slice(0, start).map((file) => file.displayPath)
    const text = buildFrame([budgetMarker(maxBytes, omitted, []), intro, ...included].join('\n\n'))
    if (byteLength(text) <= maxBytes) return { text, omitted, truncated: [] }
  }

  const mostSpecific = files.at(-1)
  const omitted = files.slice(0, -1).map((file) => file.displayPath)
  const originalBytes = byteLength(mostSpecific.content)

  const truncatedCandidate = (bytes) => ({
    ...mostSpecific,
    content: truncateUtf8(mostSpecific.content, bytes),
  })

  let low = 0
  let high = originalBytes
  let best = truncatedCandidate(0)
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = truncatedCandidate(mid)
    const truncated = [
      {
        path: mostSpecific.displayPath,
        originalBytes,
        includedBytes: byteLength(candidate.content),
      },
    ]
    const text = buildFrame(
      [budgetMarker(maxBytes, omitted, truncated), intro, sectionText(candidate)].join('\n\n'),
    )
    if (byteLength(text) <= maxBytes) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  const finalBytes = byteLength(best.content)
  const truncated = [
    { path: mostSpecific.displayPath, originalBytes, includedBytes: finalBytes },
  ]
  const text = buildFrame(
    [budgetMarker(maxBytes, omitted, truncated), intro, sectionText(best)].join('\n\n'),
  )
  if (byteLength(text) <= maxBytes) return { text, omitted, truncated }

  const notice = budgetMarker(maxBytes, omitted, truncated)
  return { text: buildFrame(truncateUtf8(notice, maxBytes)), omitted, truncated }
}

function scopeSentence(displayPath) {
  const scope = dirname(displayPath).replaceAll('\\', '/')
  if (scope === '.' || scope === '') return 'These workspace instructions apply to all work in this workspace.'
  return `These instructions apply to work under \`${scope}\`.`
}

function changeSectionText(change) {
  if (change.action === 'remove') {
    return `Instructions removed: ${change.path}\n\nThe previously loaded instructions from this file no longer apply.`
  }
  if (change.action === 'replace') {
    return [
      `Updated instructions from: ${change.path}`,
      '',
      'This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.',
      '',
      change.content,
    ].join('\n')
  }
  return [
    `Additional instructions from: ${change.path}`,
    '',
    `${scopeSentence(change.path)} ${CHANGE_GUIDANCE}`,
    '',
    change.content,
  ].join('\n')
}

/**
 * Render one reconciliation batch as one frame.
 * @param {Array<{ action: 'set' | 'replace' | 'remove', path: string, content?: string }>} changes
 * @param {number} maxBytes
 * @returns {string | undefined}
 */
export function renderChanges(changes, maxBytes) {
  if (changes.length === 0) return undefined
  const text = buildFrame(changes.map(changeSectionText).join('\n\n'))
  if (byteLength(text) <= maxBytes) return text
  return buildFrame(truncateUtf8(changes.map(changeSectionText).join('\n\n'), maxBytes))
}

/**
 * Read the producer-owned changes this bundle recorded on the visible surface.
 * Only rows carrying this bundle's `fileChanges` member are considered, so the
 * shipped plugin's own baseline rows never leak into workspace state.
 * @param {object} agent
 * @param {Array<object>} authorityMessages
 * @returns {Map<string, { path: string, digest: string }>}
 */
export function visibleWorkspaceState(agent, authorityMessages = []) {
  const visible = new Map()
  const absorb = (source) => {
    if (source === null || typeof source !== 'object') return
    if (source.kind !== 'agent-instructions' || !Array.isArray(source.fileChanges)) return
    if (source.fileBaseline === true) visible.clear()
    for (const change of source.fileChanges) {
      if (change === null || typeof change !== 'object') continue
      if (typeof change.path !== 'string' || typeof change.digest !== 'string') continue
      if (change.action === 'remove') visible.delete(change.path)
      else visible.set(change.path, { path: change.path, digest: change.digest })
    }
  }
  for (const seq of agent.session.surface.nodes) {
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    absorb(event.data.source)
  }
  for (const message of authorityMessages) absorb(message?.source)
  return visible
}

/**
 * Find the newest visible baseline row this bundle produced.
 * @param {object} agent
 * @param {Array<object>} authorityMessages
 * @returns {object | undefined}
 */
export function visibleWorkspaceBaseline(agent, authorityMessages = []) {
  const matches = (source) =>
    source !== null &&
    typeof source === 'object' &&
    source.kind === 'agent-instructions' &&
    source.fileBaseline === true
  for (const message of authorityMessages.toReversed()) if (matches(message?.source)) return message.source
  for (const seq of agent.session.surface.nodes.toReversed()) {
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    if (matches(event.data.source)) return event.data.source
  }
  return undefined
}

/**
 * Diff the current visible state against the desired files.
 * @param {Map<string, { path: string, digest: string }>} visible
 * @param {Array<{ displayPath: string, content: string, digest: string }>} desired
 * @returns {Array<{ action: 'set' | 'replace' | 'remove', path: string, content?: string, digest?: string }>}
 */
export function diffWorkspaceState(visible, desired) {
  const changes = []
  const seen = new Set()
  for (const file of desired) {
    seen.add(file.displayPath)
    const previous = visible.get(file.displayPath)
    if (previous === undefined) {
      changes.push({ action: 'set', path: file.displayPath, content: file.content, digest: file.digest })
    } else if (previous.digest !== file.digest) {
      changes.push({ action: 'replace', path: file.displayPath, content: file.content, digest: file.digest })
    }
  }
  for (const [path, previous] of visible) {
    if (seen.has(path)) continue
    changes.push({ action: 'remove', path, digest: previous.digest })
  }
  return changes
}

/**
 * Build the durable changes list recorded on the baseline source.
 * @param {Array<{ displayPath: string, digest: string }>} files
 * @returns {Array<{ action: 'set', path: string, digest: string }>}
 */
export function baselineChanges(files) {
  return files.map((file) => ({ action: 'set', path: file.displayPath, digest: file.digest }))
}
