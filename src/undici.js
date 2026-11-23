/**
 * Resolve the `undici` module the Harness itself uses.
 *
 * A profile-installed bundle has no `undici` dependency, and the copy inside
 * the DSH installation is the one the proxy policy configured. Importing that
 * exact file gives two things a bare `globalThis.fetch` cannot:
 *
 *   - the process-wide dispatcher the Harness installed (so the plugin honors
 *     the profile's proxy policy), and
 *   - `Agent`, for a direct connection that bypasses a broken proxy.
 *
 * Inside a packaged Desktop the file lives in `app.asar`; Electron's runtime
 * resolves and imports it, a plain Node process does not, so every step is
 * best-effort and a miss simply disables the direct-path attempt.
 *
 * @module dsh-net-stable/undici
 */

import path from 'node:path'

let cached
let lastError = 'not attempted'

/**
 * @returns {Promise<object|null>} the `undici` module, or null when unavailable.
 */
export async function loadUndici() {
  if (cached !== undefined) return cached
  cached = await resolve()
  return cached
}

/** Why the import failed, for the net_doctor report. */
export function undiciFailureReason() {
  return lastError
}

/** Candidate DSH installation directories, most authoritative first. */
function installCandidates() {
  const out = []
  const push = candidate => {
    if (typeof candidate === 'string' && candidate.trim() !== '' && !out.includes(candidate)) out.push(candidate)
  }
  push(process.env.DSH_INSTALL_DIR)
  // Packaged Desktop: <resources>/app.asar/dsh/node_modules/@deepseek-ai/dsh
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources !== '') push(path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'))
  // Fallback for a layout without process.resourcesPath.
  if (typeof process.execPath === 'string') push(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'))
  return out
}

async function resolve() {
  try {
    return await import('undici')
  } catch (error) {
    lastError = `bare import: ${error.code ?? error.message}`
  }

  let createRequire
  let pathToFileURL
  try {
    ({ createRequire } = await import('node:module'))
    ;({ pathToFileURL } = await import('node:url'))
  } catch (error) {
    lastError = `node builtins: ${error.message}`
    return null
  }

  for (const dir of installCandidates()) {
    try {
      const requireFromInstall = createRequire(`${dir.replace(/[\\/]+$/, '')}/package.json`)
      const resolved = requireFromInstall.resolve('undici')
      return await import(pathToFileURL(resolved).href)
    } catch (error) {
      lastError = `${dir}: ${error.code ?? error.message}`
    }
  }

  return null
}
