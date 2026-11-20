/**
 * Regression tests for the native dialog result decoding.
 *
 * The Windows dialog writes its result to stdout. Windows PowerShell 5.1
 * encodes `[Console]::Out.Write` output with the system OEM code page (GBK on a
 * Simplified Chinese system) when stdout is a pipe, so a UTF-8 decode of that
 * stream turned every non-ASCII path into mojibake and the picker rejected
 * files that live inside the workspace. The script now emits an ASCII-only
 * `b64:` payload; these tests pin that contract.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeDialogOutput } from '../lib/dialog.js'

const encode = (path) => `b64:${Buffer.from(path, 'utf8').toString('base64')}`

test('decodes a base64 UTF-8 path that contains CJK characters', () => {
  const path = 'D:\\项目\\工作区\\AGENTS.md'
  assert.equal(decodeDialogOutput(encode(path)), path)
})

test('decodes a base64 UTF-8 directory path', () => {
  const path = 'D:\\项目\\工作区'
  assert.equal(decodeDialogOutput(encode(path)), path)
})

test('tolerates the trailing newline PowerShell may append', () => {
  const path = 'D:\\项目\\工作区\\AGENTS.md'
  assert.equal(decodeDialogOutput(`${encode(path)}\r\n`), path)
})

test('tolerates NUL bytes from a UTF-16 console writer', () => {
  const path = 'D:\\项目\\工作区\\AGENTS.md'
  const stdout = encode(path).replaceAll('', '\u0000')
  assert.equal(decodeDialogOutput(stdout), path)
})

test('returns null when the dialog was cancelled', () => {
  assert.equal(decodeDialogOutput(''), null)
  assert.equal(decodeDialogOutput('\r\n'), null)
})

test('passes an unprefixed POSIX path through unchanged', () => {
  const path = '/home/user/工作区/AGENTS.md'
  assert.equal(decodeDialogOutput(path), path)
})

test('passes an unprefixed legacy Windows path through unchanged', () => {
  const path = 'D:\\项目\\工作区\\AGENTS.md'
  assert.equal(decodeDialogOutput(path), path)
})

test('rejects a malformed base64 payload instead of returning a bogus path', () => {
  assert.throws(() => decodeDialogOutput('b64:!!!not-base64!!!'), /unreadable selection/i)
})

test('rejects an empty base64 payload', () => {
  assert.throws(() => decodeDialogOutput('b64:'), /unreadable selection/i)
})

test('does not decode a plain path that merely contains b64 elsewhere', () => {
  const path = 'D:\\b64:\\AGENTS.md'
  assert.equal(decodeDialogOutput(path), path)
})
