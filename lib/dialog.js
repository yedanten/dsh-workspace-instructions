/**
 * Native "choose one markdown file" dialog used by the workspace-instruction
 * picker.
 *
 * The Host runs behind the browser, so it owns the dialog instead of the page.
 * Every platform launches a child process and reads the absolute path from its
 * stdout, which keeps the Host event loop free while the modal dialog is open.
 *
 * @module dsh-workspace-instructions/dialog
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

/** Title every platform dialog shows. */
export const DIALOG_TITLE = 'Select workspace instruction file'
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Prefix marking a base64 UTF-8 payload on the dialog's stdout.
 *
 * Windows PowerShell 5.1 writes `[Console]::Out.Write` with the system OEM
 * code page (GBK on a Simplified Chinese system) when stdout is a pipe, so any
 * non-ASCII path was decoded as UTF-8 into mojibake and the picker rejected a
 * file that lives inside the workspace. Base64 is ASCII-only, which makes the
 * channel independent of the console code page.
 */
const BASE64_PREFIX = 'b64:'
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Decode the absolute path a platform dialog wrote to stdout.
 * @param {string} stdout
 * @returns {string | null} decoded path, or null when the dialog was cancelled
 */
export function decodeDialogOutput(stdout) {
  const trimmed = String(stdout ?? '')
    .replace(/\u0000/g, '')
    .replace(/[\r\n]+$/, '')
  if (trimmed === '') return null
  if (!trimmed.startsWith(BASE64_PREFIX)) return trimmed
  const payload = trimmed.slice(BASE64_PREFIX.length)
  if (!BASE64_PATTERN.test(payload) || payload.length % 4 !== 0) {
    throw new Error('The file dialog returned an unreadable selection.')
  }
  const decoded = Buffer.from(payload, 'base64').toString('utf8')
  if (decoded === '' || decoded.includes('\uFFFD')) {
    throw new Error('The file dialog returned an unreadable selection.')
  }
  return decoded
}

/**
 * Encode one PowerShell script for `-EncodedCommand`.
 * @param {string} script
 * @returns {string}
 */
function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

const WIN32_SCRIPT = `Add-Type -AssemblyName System.Windows.Forms | Out-Null
try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch {}
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $env:DSH_PICK_TITLE
$dialog.InitialDirectory = $env:DSH_PICK_DIR
$dialog.Filter = 'Markdown (*.md)|*.md'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$dialog.RestoreDirectory = $true
$dialog.AddExtension = $false
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.FileName)
  [Console]::Out.Write('b64:' + [Convert]::ToBase64String($bytes))
}
`

const MAC_PANEL = `ObjC.import('AppKit');
function run(argv) {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var panel = $.NSOpenPanel.openPanel;
  panel.canChooseFiles = true;
  panel.canChooseDirectories = false;
  panel.allowsMultipleSelection = false;
  panel.allowedFileTypes = ['md'];
  panel.message = argv[0];
  try { panel.directoryURL = $.NSURL.fileURLWithPath(argv[1]); } catch (error) {}
  app.activateIgnoringOtherApps(true);
  if (panel.runModal !== $.NSModalResponseOK) return '';
  var urls = panel.URLs;
  if (urls.count < 1) return '';
  return ObjC.unwrap(urls.objectAtIndex(0).path);
}`

/**
 * Run one child process and resolve its stdout plus stderr.
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function run(command, args, env, signal, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolvePromise(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('The file dialog timed out.'))
    }, timeoutMs)
    const onAbort = () => {
      child.kill()
      finish(new Error('The file dialog was cancelled.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk) => stdout.push(chunk))
    child.stderr?.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8').replace(/[\r\n]+$/, '')
      const err = Buffer.concat(stderr).toString('utf8').trim()
      if (code === 0) finish(undefined, { stdout: out, stderr: err, code })
      else {
        const failure = new Error(err || `dialog exited with code ${code}`)
        failure.exitCode = code
        finish(failure)
      }
    })
  })
}

async function runPowerShell(args, env, signal, timeoutMs) {
  const candidates = ['powershell.exe', 'pwsh.exe', 'pwsh']
  let lastError
  for (const command of candidates) {
    try {
      return await run(command, args, env, signal, timeoutMs)
    } catch (error) {
      lastError = error
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') continue
      throw error
    }
  }
  throw lastError ?? new Error('No PowerShell host is available to open a file dialog.')
}

/**
 * Open the platform file chooser and return the selected absolute path.
 * @param {object} options
 * @param {string} options.directory directory the dialog opens in
 * @param {AbortSignal} [options.signal] caller lifetime
 * @param {number} [options.timeoutMs]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<string | null>} selected path, or null when cancelled
 */
export async function pickMarkdownFile({ directory, signal, timeoutMs = DEFAULT_TIMEOUT_MS, env = {} }) {
  const startDirectory = resolve(directory)
  const platform = process.platform

  if (platform === 'win32') {
    const { stdout } = await runPowerShell(
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-EncodedCommand',
        encodePowerShell(WIN32_SCRIPT),
      ],
      { DSH_PICK_TITLE: DIALOG_TITLE, DSH_PICK_DIR: startDirectory, ...env },
      signal,
      timeoutMs,
    )
    return decodeDialogOutput(stdout)
  }

  if (platform === 'darwin') {
    const { stdout } = await run(
      'osascript',
      ['-l', 'JavaScript', '-e', MAC_PANEL, DIALOG_TITLE, startDirectory],
      env,
      signal,
      timeoutMs,
    )
    return decodeDialogOutput(stdout)
  }

  try {
    const { stdout } = await run(
      'zenity',
      [
        '--file-selection',
        `--title=${DIALOG_TITLE}`,
        `--filename=${startDirectory}/`,
        '--file-filter=Markdown (*.md) | *.md',
      ],
      env,
      signal,
      timeoutMs,
    )
    return decodeDialogOutput(stdout)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.exitCode === 1) return null
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error('No native file dialog is available on this system.')
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}
