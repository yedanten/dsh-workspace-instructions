/**
 * Browser bridge for the workspace-instruction picker.
 *
 * The Host HTTP carrier exposes exact routes; the page calls them with
 * same-origin `fetch`. These routes only read and write this bundle's own
 * per-session selection, plus the native file dialog, so they require no
 * Remote namespace.
 *
 * @module dsh-workspace-instructions/routes
 */
const ROUTE_PREFIX = '/workspace-instructions'

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function requestHostname(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return undefined
  const host = hostHeader.trim()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 1 ? host.slice(1, end) : undefined
  }
  const colon = host.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) return host.slice(0, colon)
  return host
}

function isLoopbackHost(hostHeader) {
  const hostname = requestHostname(hostHeader)?.toLowerCase()
  if (hostname === undefined) return false
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0'
  )
}

function sameOrigin(request) {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function guard(request, response) {
  if (request.headers.origin !== undefined) {
    if (!sameOrigin(request) || !isLoopbackHost(request.headers.host)) {
      sendJson(response, 403, { ok: false, error: 'untrusted origin' })
      return false
    }
    return true
  }
  if (request.method === 'POST') {
    const site = request.headers['sec-fetch-site']
    const contentType = request.headers['content-type']
    if (site !== undefined && site !== 'same-origin') {
      sendJson(response, 403, { ok: false, error: 'untrusted origin' })
      return false
    }
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
      sendJson(response, 415, { ok: false, error: 'application/json required' })
      return false
    }
  }
  return true
}

async function readJsonBody(request, maxBytes = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function stringField(body, key) {
  const value = body?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Register the picker routes against the Host web server.
 * @param {object} ctx owning Cordis context
 * @param {object} handlers
 * @param {(sessionId: string) => Promise<{ directory: string } | undefined>} handlers.describeSession
 * @param {(sessionId: string) => string} handlers.getSelection
 * @param {(sessionId: string, file: string) => { ok: true, file: string } | { ok: false, error: string }} handlers.setSelection
 * @param {(sessionId: string) => Promise<{ ok: true, file: string | null } | { ok: false, error: string }>} handlers.pick
 * @param {(sessionId: string) => void} handlers.resetSelection
 * @param {object} log
 * @returns {Array<() => void>}
 */
export function registerRoutes(ctx, handlers, log = console) {
  const server = ctx.get('webServer')
  if (server === undefined) return []

  const disposers = []
  const route = (method, path, handler) => {
    disposers.push(
      server.register({
        kind: 'exact',
        path,
        handler: async (request, response) => {
          try {
            if (request.method !== method) {
              response.writeHead(405, { allow: method })
              response.end()
              return
            }
            if (!guard(request, response)) return
            const body = method === 'POST' ? await readJsonBody(request) : {}
            const result = await handler(body, request)
            sendJson(response, 200, result)
          } catch (error) {
            log.warn?.('workspace-instructions route failed: %o', error)
            sendJson(response, 400, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        },
      }),
    )
  }

  route('GET', `${ROUTE_PREFIX}/state`, async (_body, request) => {
    const url = new URL(String(request.url ?? ''), 'http://localhost')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    return await describe(handlers, sessionId)
  })

  route('POST', `${ROUTE_PREFIX}/select`, async (body) => {
    const sessionId = stringField(body, 'sessionId') ?? ''
    const file = stringField(body, 'file')
    if (file === undefined) return { ok: false, error: 'file is required' }
    const described = await handlers.describeSession(sessionId)
    if (described === undefined) return { ok: false, error: 'session is not available' }
    const applied = handlers.setSelection(sessionId, file)
    if (applied.ok === false) return { ok: false, error: applied.error }
    return await describe(handlers, sessionId)
  })

  route('POST', `${ROUTE_PREFIX}/pick`, async (body) => {
    const sessionId = stringField(body, 'sessionId') ?? ''
    const picked = await handlers.pick(sessionId)
    if (picked.ok === false) return { ok: false, error: picked.error }
    if (picked.file !== null) {
      const applied = handlers.setSelection(sessionId, picked.file)
      if (applied.ok === false) return { ok: false, error: applied.error }
    }
    return await describe(handlers, sessionId)
  })

  route('POST', `${ROUTE_PREFIX}/reset`, async (body) => {
    const sessionId = stringField(body, 'sessionId') ?? ''
    handlers.resetSelection(sessionId)
    return await describe(handlers, sessionId)
  })

  route('GET', `${ROUTE_PREFIX}/preview`, async (_body, request) => {
    const url = new URL(String(request.url ?? ''), 'http://localhost')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    return await handlers.preview(sessionId)
  })

  return disposers
}

async function describe(handlers, sessionId) {
  if (sessionId === '') return { ok: false, error: 'sessionId is required' }
  const described = await handlers.describeSession(sessionId)
  if (described === undefined) return { ok: false, error: 'session is not available' }
  const file = handlers.getSelection(sessionId)
  return {
    ok: true,
    sessionId,
    file,
    directory: described.directory,
    exists: described.exists === true,
  }
}

export { ROUTE_PREFIX }
