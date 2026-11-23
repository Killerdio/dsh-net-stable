/**
 * Harness-compatible error type.
 *
 * A profile-installed bundle cannot resolve the shipped
 * `@deepseek-ai/dsh-web` package, so this mirrors its shape: a named error
 * carrying a machine-routable `code` and an optional `cause`. Consumers format
 * `message` and route on `code`, which is what the web seam promises.
 *
 * @module dsh-net-stable/errors
 */

export class WebError extends Error {
  /**
   * @param {string} message - human-readable detail shown to the model.
   * @param {string} code - stable code such as `WEB_FETCH_TIMEOUT`.
   * @param {{ cause?: unknown }} [options] - the underlying failure.
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WebError'
    this.code = code
  }
}
