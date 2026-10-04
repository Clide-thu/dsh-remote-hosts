/**
 * Remote Host client: token→cookie exchange, credential state, and transparent
 * forwarding of `/api` calls through the tunnel.
 *
 * The browser talks to this plugin's own endpoints; this module is what turns
 * those into authenticated requests against the remote `dsh web`.
 *
 * Wire facts this module depends on (verified against DSH 0.2.0-rc.2):
 *  - `GET /?token=<token>` answers `303` with `set-cookie: dsh-auth-<sha256(authority)>=v1.…`
 *  - every other route (including all of `/api`) requires that cookie, else `401`
 *  - an RPC call is `POST /api/<namespace>/<method>` with
 *    `{ type:"client-request", rpcId, method, payload }`
 *
 * The cookie is bound to the *local* tunnel authority (`127.0.0.1:<localPort>`),
 * which is why each host gets its own port and its own independent session.
 *
 * @module remote-client
 */

import { randomUUID } from 'node:crypto';

/** @typedef {'unknown'|'connecting'|'ready'|'needs-credentials'|'unreachable'} HostState */

/**
 * Error carrying a machine-readable classification so callers can decide
 * whether to ask the user for fresh credentials.
 */
export class RemoteHostError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: 'needs-credentials'|'unreachable'|'transport', status?: number, cause?: unknown }} info
   */
  constructor(message, info) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'RemoteHostError';
    this.kind = info.kind;
    this.status = info.status;
  }
}

/** Pull one `set-cookie` pair out of a Headers object. */
function extractCookie(headers) {
  const raw = headers.getSetCookie?.() ?? [];
  const list = raw.length > 0 ? raw : [headers.get('set-cookie')].filter((value) => value !== null);
  for (const value of list) {
    const pair = value.split(';', 1)[0]?.trim();
    if (pair !== undefined && pair.startsWith('dsh-auth-')) return pair;
  }
  return undefined;
}

/**
 * Client bound to one remote Host reached through a local tunnel port.
 *
 * Credential state machine:
 *   unknown → connecting → ready
 *                       ↘ needs-credentials   (remote rejected the token)
 *                       ↘ unreachable         (tunnel/transport failure)
 *
 * `ensureReady()` is the lazy entry point: it opens the tunnel and performs the
 * token exchange only when first needed, and re-runs the exchange exactly once
 * when a previously good cookie starts being rejected.
 */
export class RemoteHostClient {
  /** @type {HostState} */
  state = 'unknown';
  /** @type {string | undefined} */
  #cookie;
  /** @type {Promise<void> | undefined} */
  #readying;

  /**
   * @param {object} options
   * @param {string} options.alias
   * @param {number} options.remotePort
   * @param {string} options.token
   * @param {{ ensureOpen: (options?: object) => Promise<number>, close: () => Promise<void>, localPort?: number }} options.tunnel
   * @param {(line: string) => void} [options.onLog]
   */
  constructor(options) {
    this.options = options;
  }

  get alias() {
    return this.options.alias;
  }

  get localPort() {
    return this.options.tunnel.localPort;
  }

  /** Whether a usable session cookie is held. */
  get hasSession() {
    return this.#cookie !== undefined;
  }

  /**
   * Open the tunnel if needed and make sure a session cookie is held.
   * @returns {Promise<void>}
   */
  async ensureReady() {
    if (this.state === 'ready' && this.#cookie !== undefined) return;
    if (this.#readying !== undefined) return this.#readying;
    this.#readying = (async () => {
      this.state = 'connecting';
      let port;
      try {
        port = await this.options.tunnel.ensureOpen();
      } catch (error) {
        this.state = 'unreachable';
        throw new RemoteHostError(
          `cannot reach ${this.alias} over SSH: ${error instanceof Error ? error.message : String(error)}`,
          { kind: 'unreachable', cause: error }
        );
      }
      try {
        await this.#exchangeToken(port);
        this.state = 'ready';
      } catch (error) {
        this.state = error instanceof RemoteHostError && error.kind === 'needs-credentials'
          ? 'needs-credentials'
          : 'unreachable';
        throw error;
      }
    })().finally(() => {
      this.#readying = undefined;
    });
    return this.#readying;
  }

  /**
   * Trade the launch token for a session cookie.
   * @param {number} port
   */
  async #exchangeToken(port) {
    let response;
    try {
      // `redirect: 'manual'` keeps the 303 itself, whose Set-Cookie we need.
      response = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(this.options.token)}`, {
        method: 'GET',
        redirect: 'manual'
      });
    } catch (error) {
      throw new RemoteHostError(
        `cannot reach the tunnel for ${this.alias}: ${error instanceof Error ? error.message : String(error)}`,
        { kind: 'unreachable', cause: error }
      );
    }
    const cookie = extractCookie(response.headers);
    if (cookie === undefined) {
      // 401 here means the token no longer matches this Host process — a restart
      // on the remote mints a new one, which is exactly the re-prompt path.
      const detail = response.status === 401 ? 'the token is no longer valid' : `unexpected status ${response.status}`;
      throw new RemoteHostError(`${this.alias}: ${detail}`, {
        kind: 'needs-credentials',
        status: response.status
      });
    }
    this.#cookie = cookie;
  }

  /** Drop the held cookie so the next call re-exchanges the token. */
  invalidateSession() {
    this.#cookie = undefined;
    if (this.state === 'ready') this.state = 'unknown';
  }

  /**
   * Perform one `POST /api/<endpoint>` against the remote Host.
   *
   * The body is forwarded byte-for-byte: the remote speaks the same wire
   * protocol as the local Host (both 0.2.0-rc.2), so nothing here needs to
   * understand the payload. On a `401` the session is re-established once and
   * the call retried, which covers a remote restart between interactions.
   *
   * @param {string} endpoint - e.g. `session/list`
   * @param {unknown} payload
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<unknown>} the parsed `server-response` envelope
   */
  async call(endpoint, payload, options = {}) {
    await this.ensureReady();
    return this.#post(endpoint, payload, options, true);
  }

  /**
   * Raw remote call used for probing; does not re-establish credentials.
   * @param {string} endpoint
   * @param {unknown} payload
   * @param {{ signal?: AbortSignal }} [options]
   */
  async #post(endpoint, payload, options, allowRetry) {
    const port = this.options.tunnel.localPort;
    if (port === undefined) {
      throw new RemoteHostError(`${this.alias}: tunnel is not open`, { kind: 'unreachable' });
    }
    const rpcId = randomUUID();
    const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload });
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: this.#cookie ?? '' },
        body,
        ...(options.signal !== undefined ? { signal: options.signal } : {})
      });
    } catch (error) {
      this.state = 'unreachable';
      throw new RemoteHostError(
        `${this.alias}: tunnel request failed: ${error instanceof Error ? error.message : String(error)}`,
        { kind: 'unreachable', cause: error }
      );
    }

    if (response.status === 401) {
      this.invalidateSession();
      if (allowRetry) {
        await this.ensureReady();
        return this.#post(endpoint, payload, options, false);
      }
      throw new RemoteHostError(`${this.alias}: remote rejected the cached credential`, {
        kind: 'needs-credentials',
        status: 401
      });
    }
    if (!response.ok) {
      throw new RemoteHostError(`${this.alias}: remote answered HTTP ${response.status}`, {
        kind: response.status >= 500 ? 'unreachable' : 'transport',
        status: response.status
      });
    }
    return response.json();
  }

  /** Close the underlying tunnel. */
  async dispose() {
    this.invalidateSession();
    await this.options.tunnel.close();
  }
}

/**
 * Unwrap a `server-response` envelope into its business value.
 * @param {unknown} envelope
 * @returns {unknown}
 */
export function unwrapResponse(envelope) {
  if (typeof envelope !== 'object' || envelope === null) return undefined;
  const result = /** @type {{ result?: { ok?: boolean, value?: unknown } }} */ (envelope).result;
  if (result === undefined || result.ok !== true) return undefined;
  return result.value;
}
