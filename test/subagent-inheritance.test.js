/**
 * Regression tests for subagent workspace-instruction inheritance.
 *
 * A spawned subagent starts with an empty session surface and no explicit
 * selection, so it must load the file its delegating agent selected instead of
 * falling back to `AGENTS.md`. These tests pin that contract by driving the
 * real `agent/pre-step` listener with a minimal Cordis context and a temporary
 * workspace.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const GUIDE = '# Guide instructions\n\nGUIDE ONLY\n'
const AGENTS = '# Agents instructions\n\nAGENTS ONLY\n'

function fakeSession(id, header, events = new Map(), nodes = []) {
  return {
    id,
    header,
    surface: { nodes },
    eventAt(seq) {
      return events.get(seq)
    },
  }
}

function baselineSource(fileSelection) {
  return {
    kind: 'agent-instructions',
    form: 'instructions',
    fileBaseline: true,
    fileIdentity: 'previous-baseline-identity',
    fileSelection,
    fileChanges: [],
  }
}

function createHarness({ directory, agents }) {
  const preStep = []
  const byId = new Map(agents.map((agent) => [String(agent.session.id), agent]))
  const ctx = {
    logger: { warn() {}, info() {}, debug() {} },
    inject(deps, callback) {
      if (!deps.includes('webServer')) return
      callback({
        get() {
          return undefined
        },
        effect(fn) {
          fn()
        },
      })
    },
    on(event, handler) {
      if (event === 'agent/pre-step') preStep.push(handler)
    },
    get() {
      return undefined
    },
    agents: {
      get(id) {
        return byId.get(String(id))
      },
      list() {
        return [...byId.values()]
      },
    },
    workingDirectory: {
      get() {
        return directory
      },
      async ensure() {
        return directory
      },
    },
  }
  apply(ctx, {})
  assert.equal(preStep.length, 1, 'the plugin registers exactly one pre-step listener')
  return { preStep: preStep[0], byId }
}

async function enterStep(handler, agent) {
  const signal = new AbortController().signal
  const decision = await handler(
    { agent, messages: [], turn: 1, step: 1, signal, modelSelection: {} },
    async () => ({ kind: 'enter', messages: [] }),
  )
  return decision.messages
}

function renderedText(messages) {
  return messages
    .flatMap((message) => message.content ?? [])
    .map((block) => block.text ?? '')
    .join('\n')
}

async function withWorkspace(run) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-workspace-instructions-'))
  try {
    await writeFile(join(directory, 'AGENTS.md'), AGENTS, 'utf8')
    await writeFile(join(directory, 'GUIDE.md'), GUIDE, 'utf8')
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('a spawned subagent loads the file its delegating agent selected', async () => {
  await withWorkspace(async (directory) => {
    const parentEvents = new Map([[1, { type: 'user/message', data: { source: baselineSource('GUIDE.md') } }]])
    const parent = {
      id: 'parent',
      session: fakeSession('parent', { id: 'parent', cwd: directory, isSeeded: false }, parentEvents, [1]),
    }
    const child = {
      id: 'child',
      session: fakeSession('child', {
        id: 'child',
        cwd: directory,
        parentSession: 'parent',
        origin: 'subagent',
        delegationDepth: 1,
        isSeeded: false,
      }),
    }
    const { preStep } = createHarness({ directory, agents: [parent, child] })

    await enterStep(preStep, parent)
    const text = renderedText(await enterStep(preStep, child))

    assert.match(text, /Instructions from: GUIDE\.md/)
    assert.match(text, /GUIDE ONLY/)
    assert.doesNotMatch(text, /Instructions from: AGENTS\.md/)
  })
})

test('a grandchild inherits through a child that made no explicit selection', async () => {
  await withWorkspace(async (directory) => {
    const parentEvents = new Map([[1, { type: 'user/message', data: { source: baselineSource('GUIDE.md') } }]])
    const parent = {
      id: 'parent',
      session: fakeSession('parent', { id: 'parent', cwd: directory, isSeeded: false }, parentEvents, [1]),
    }
    const child = {
      id: 'child',
      session: fakeSession('child', {
        id: 'child',
        cwd: directory,
        parentSession: 'parent',
        origin: 'subagent',
        delegationDepth: 1,
        isSeeded: false,
      }),
    }
    const grandchild = {
      id: 'grandchild',
      session: fakeSession('grandchild', {
        id: 'grandchild',
        cwd: directory,
        parentSession: 'child',
        origin: 'subagent',
        delegationDepth: 2,
        isSeeded: false,
      }),
    }
    const { preStep } = createHarness({ directory, agents: [parent, child, grandchild] })

    await enterStep(preStep, parent)
    await enterStep(preStep, child)
    const text = renderedText(await enterStep(preStep, grandchild))

    assert.match(text, /Instructions from: GUIDE\.md/)
    assert.doesNotMatch(text, /Instructions from: AGENTS\.md/)
  })
})

test('a top-level session without a subagent header keeps the default file', async () => {
  await withWorkspace(async (directory) => {
    const parentEvents = new Map([[1, { type: 'user/message', data: { source: baselineSource('GUIDE.md') } }]])
    const parent = {
      id: 'parent',
      session: fakeSession('parent', { id: 'parent', cwd: directory, isSeeded: false }, parentEvents, [1]),
    }
    const forked = {
      id: 'forked',
      session: fakeSession('forked', { id: 'forked', cwd: directory, parentSession: 'parent', isSeeded: false }),
    }
    const { preStep } = createHarness({ directory, agents: [parent, forked] })

    await enterStep(preStep, parent)
    const text = renderedText(await enterStep(preStep, forked))

    assert.match(text, /Instructions from: AGENTS\.md/)
    assert.doesNotMatch(text, /Instructions from: GUIDE\.md/)
  })
})
