/**
 * dsh-remote-hosts — host half.
 *
 * Registers six exact Fetch routes under `/api/dshRemoteHosts/` on
 * `ctx.connection.fetch` and answers them from the SSH config, the credential
 * store, and (only when a probe is actually needed) an SSH tunnel plus the
 * remote `dsh web`.
 *
 * Contract: CONTRACT.md (frozen). Every response is HTTP 200 with either the
 * documented success payload or `{ ok: false, error: { kind, message } }`.
 *
 * Layering:
 *   - `lib/ssh-config.mjs`    — parse `~/.ssh/config`
 *   - `lib/credentials.mjs`   — parse/persist credentials, `maskToken`
 *   - `lib/tunnel.mjs`        — lazy `ssh -L` child process
 *   - `lib/remote-client.mjs` — token→cookie exchange + `POST /api/<endpoint>`
 *
 * The module has no side effects at import time, so it can be loaded outside a
 * running Host. All I/O the host half performs goes through the injectable
 * `io` seam, which is what makes `/hosts/list` purity testable: the route can
 * only touch the two readers it is given, and those readers never open a
 * socket or a child process.
 *
 * @module dsh-remote-hosts
 */

import { listSshHosts } from './ssh-config.mjs';
import {
  maskToken,
  parseCredentialUrl,
  readStore,
  removeHost,
  storePath,
  upsertHost
} from './credentials.mjs';
import { Tunnel } from './tunnel.mjs';
import { RemoteHostClient, RemoteHostError, unwrapResponse } from './remote-client.mjs';

/** Fixed route prefix from CONTRACT.md §1. No trailing slash. */
export const ROUTE_PREFIX = '/api/dshRemoteHosts';

/**
 * The six registered endpoints, in CONTRACT.md §1 order.
 *
 * `/remote/open` is appended last so the five contract routes keep their
 * registration order (and therefore their unregistration order).
 */
export const ROUTES = Object.freeze([
  { path: `${ROUTE_PREFIX}/hosts/list`, methods: Object.freeze(['POST']), requestBody: 'buffered' },
  { path: `${ROUTE_PREFIX}/hosts/add`, methods: Object.freeze(['POST']), requestBody: 'buffered' },
  { path: `${ROUTE_PREFIX}/hosts/remove`, methods: Object.freeze(['POST']), requestBody: 'buffered' },
  { path: `${ROUTE_PREFIX}/hosts/probe`, methods: Object.freeze(['POST']), requestBody: 'buffered' },
  { path: `${ROUTE_PREFIX}/remote/sessions`, methods: Object.freeze(['POST']), requestBody: 'buffered' },
  { path: `${ROUTE_PREFIX}/remote/open`, methods: Object.freeze(['POST']), requestBody: 'buffered' }
]);

/** Error kinds permitted by CONTRACT.md §1. */
const ERROR_KINDS = new Set(['bad-request', 'unknown-host', 'needs-credentials', 'unreachable', 'internal']);

/** `RemoteHostClient` error kinds that already match the contract vocabulary. */
const PASSTHROUGH_KINDS = new Set(['needs-credentials', 'unreachable']);

/** Defaults for the `config` block described in CONTRACT.md §6. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  sshConfigPath: null,
  connectTimeoutMs: 20000
});

// ---------------------------------------------------------------------------
// pure helpers (exported for tests; no I/O, no clock, no environment)
// ---------------------------------------------------------------------------

/**
 * Wrap a value as a contract error payload.
 * @param {string} kind
 * @param {string} message
 * @returns {{ ok: false, error: { kind: string, message: string } }}
 */
export function errorPayload(kind, message) {
  return { ok: false, error: { kind: ERROR_KINDS.has(kind) ? kind : 'internal', message: String(message) } };
}

/** A response carrying a contract error, always HTTP 200. */
export function errorResponse(kind, message) {
  return Response.json(errorPayload(kind, message), { status: 200 });
}

/**
 * Map an arbitrary thrown value onto the contract error vocabulary.
 *
 * `needs-credentials` and `unreachable` from `RemoteHostClient` are meaningful
 * to the UI as-is (and `transport` — a 4xx the remote emitted — is a
 * connectivity story from the user's point of view, so it becomes
 * `unreachable`). Errors raised by this module carry a contract `kind`
 * directly, which passes straight through; anything else is `internal`.
 *
 * @param {unknown} error
 * @returns {{ kind: string, message: string }}
 */
export function classifyError(error) {
  const rawKind = typeof error === 'object' && error !== null ? /** @type {{ kind?: unknown }} */ (error).kind : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RemoteHostError) {
    if (PASSTHROUGH_KINDS.has(error.kind)) return { kind: error.kind, message };
    if (error.kind === 'transport') return { kind: 'unreachable', message };
    return { kind: 'internal', message };
  }
  if (typeof rawKind === 'string' && ERROR_KINDS.has(rawKind)) return { kind: rawKind, message };
  return { kind: 'internal', message };
}

/**
 * Remove every occurrence of a secret from a message, as a belt-and-braces
 * guard on top of never putting the token into a message in the first place.
 *
 * Covers the bare token, `token=<token>` and `?token=<token>` shapes, and a
 * percent-encoded URL embedding.
 *
 * @param {string} message
 * @param {Array<string|undefined|null>} secrets - raw tokens (or cookie values) to scrub
 * @returns {string}
 */
export function sanitizeMessage(message, secrets = []) {
  let text = String(message);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    const forms = new Set([secret]);
    try {
      forms.add(encodeURIComponent(secret));
    } catch {
      // `encodeURIComponent` cannot throw for a normal token; ignore if it does.
    }
    for (const form of forms) {
      if (form === '') continue;
      text = text.split(form).join('[redacted]');
    }
  }
  // Query-shaped leftovers: `token=…` (which is how the credential URL embeds it).
  text = text.replace(/([?&]|\b)token=[^\s&"']*/gi, (match) => (match.startsWith('token=') ? 'token=[redacted]' : `${match[0]}token=[redacted]`));
  return text;
}

/**
 * Build the one browser URL that opens a remote host's own Web UI through its
 * tunnel.
 *
 * **Token containment — read before changing this function.** The string
 * returned here is the ONLY value this module is ever allowed to hand a token
 * to. A token must never appear in a log line, in an `error.message`, in an
 * `error.kind`, or in any other response field; `url` is the single field that
 * carries it. The remote UI answers `GET /?token=<token>` by setting its
 * session cookie and `302`-redirecting to a clean `./`, so the token also does
 * not linger in the address bar.
 *
 * **The one seam to replace.** If the hand-off ever becomes a local
 * cookie-injection reverse proxy (no token in the URL at all), ONLY the body of
 * this function changes — it would return `http://127.0.0.1:<port>/` after
 * injecting the cookie. Every caller keeps working, because nothing else
 * constructs or parses a remote-UI URL, and nothing else touches the token on
 * this path.
 *
 * @param {string} alias - SSH alias the port belongs to (call-site clarity only; it is not part of the URL)
 * @param {number} localPort - the tunnel's local loopback port
 * @param {string} token - the remote launch token
 * @returns {string} `http://127.0.0.1:<localPort>/?token=<token>`
 */
export function browserUrlFor(alias, localPort, token) {
  return `http://127.0.0.1:${localPort}/?token=${encodeURIComponent(token)}`;
}

/**
 * Mask a credential token for display, and also mask anything too short to be
 * masked meaningfully — a 4-character token would otherwise survive masking
 * verbatim, which CONTRACT.md §3.3 forbids.
 *
 * @param {string} token
 * @returns {string} a display-only string that is never the token
 */
export function safeMaskToken(token) {
  if (typeof token !== 'string' || token.length === 0) return '';
  const masked = maskToken(token);
  if (masked === token) return '******';
  return masked;
}

/**
 * Read the title out of a remote `session/list` item. `projections.values.title`
 * is documented as nullable, and the whole projection may be absent.
 *
 * @param {unknown} item
 * @returns {string|null}
 */
export function readSessionTitle(item) {
  if (typeof item !== 'object' || item === null) return null;
  const projections = /** @type {{ projections?: unknown }} */ (item).projections;
  if (typeof projections !== 'object' || projections === null) return null;
  const values = /** @type {{ values?: unknown }} */ (projections).values;
  if (typeof values !== 'object' || values === null) return null;
  const title = /** @type {{ title?: unknown }} */ (values).title;
  return typeof title === 'string' ? title : null;
}

/**
 * Map one remote `session/list` item to a `RemoteSessionView`.
 *
 * Defensive by design: `items` may be missing entirely and individual fields
 * may be absent or of the wrong type, and a malformed item must not take down
 * the whole host listing.
 *
 * @param {unknown} item
 * @param {string} host - alias
 * @returns {{ host: string, sessionId: string, cwd: string, title: string|null, updatedAt: number, running: boolean }}
 */
export function mapRemoteSession(item, host) {
  const record = typeof item === 'object' && item !== null ? /** @type {Record<string, unknown>} */ (item) : {};
  return {
    host,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
    cwd: typeof record.cwd === 'string' ? record.cwd : '',
    title: readSessionTitle(record),
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    running: record.running === true
  };
}

/**
 * Project the unwrapped `session/list` value into `RemoteSessionView[]`.
 * @param {unknown} value
 * @param {string} host - alias
 * @returns {Array<ReturnType<typeof mapRemoteSession>>}
 */
export function mapRemoteSessions(value, host) {
  if (typeof value !== 'object' || value === null) return [];
  const items = /** @type {{ items?: unknown }} */ (value).items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => mapRemoteSession(item, host));
}

/**
 * Resolve the `HostView.state` for one host (CONTRACT.md §2 + §3.2).
 *
 * Precedence:
 *  1. no stored credential  → `idle`: nothing has been probed, and there is
 *     nothing to probe with. (`needs-credentials` is reserved for a credential
 *     that exists but was refused — CONTRACT.md §3.2.)
 *  2. a live client state   → `connecting` / `ready` / `unreachable` / `needs-credentials`
 *  3. a recorded failure    → `needs-credentials` or `unreachable`
 *  4. otherwise             → `idle`
 *
 * @param {{ hasCredential: boolean, clientState?: string, lastFailureKind?: string }} input
 * @returns {'idle'|'connecting'|'ready'|'needs-credentials'|'unreachable'}
 */
export function resolveHostState(input) {
  if (!input.hasCredential) return 'idle';
  const clientState = input.clientState;
  if (clientState === 'connecting' || clientState === 'ready' || clientState === 'unreachable') return clientState;
  if (clientState === 'needs-credentials') return 'needs-credentials';
  if (input.lastFailureKind === 'needs-credentials') return 'needs-credentials';
  if (input.lastFailureKind !== undefined && input.lastFailureKind !== '') return 'unreachable';
  return 'idle';
}

/**
 * Project one SSH host plus its stored credential and runtime state into a
 * `HostView` (CONTRACT.md §2).
 *
 * This is the single place that decides what the browser may see, so it is the
 * single place that has to guarantee no secret escapes: only `maskToken` output
 * is used for `tokenMasked`, and `error` is passed through `sanitizeMessage`.
 *
 * @param {object} input
 * @param {{ alias: string, hostName: string, user?: string, port?: number, proxyJump?: string }} input.sshHost
 * @param {{ alias: string, port: number, token: string, enabled?: boolean }|undefined} input.entry - stored credential
 * @param {{ state?: string, lastFailure?: { kind?: string, message?: string } }} [input.runtime]
 * @returns {object} HostView
 */
export function buildHostView(input) {
  const { sshHost, entry } = input;
  const runtime = input.runtime ?? {};
  const hasCredential = entry !== undefined && typeof entry.token === 'string' && entry.token.length > 0;
  const state = resolveHostState({
    hasCredential,
    ...(runtime.state !== undefined && runtime.state !== 'unknown' ? { clientState: runtime.state } : {}),
    ...(runtime.lastFailure?.kind !== undefined ? { lastFailureKind: runtime.lastFailure.kind } : {})
  });

  /** @type {Record<string, unknown>} */
  const view = {
    alias: sshHost.alias,
    hostName: sshHost.hostName,
    ...(sshHost.user !== undefined ? { user: sshHost.user } : {}),
    ...(sshHost.proxyJump !== undefined ? { proxyJump: sshHost.proxyJump } : {}),
    hasCredential,
    ...(hasCredential ? { tokenMasked: safeMaskToken(entry.token) } : {}),
    enabled: entry === undefined ? true : entry.enabled !== false,
    state
  };

  if (runtime.lastFailure?.message !== undefined && runtime.lastFailure.message !== '') {
    view.error = sanitizeMessage(runtime.lastFailure.message, [entry?.token]);
  }
  return view;
}

/** Build a lookup keyed by `alias`; the first declaration wins, like OpenSSH. */
function byAlias(hosts) {
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const host of hosts) if (!map.has(host.alias)) map.set(host.alias, host);
  return map;
}

// ---------------------------------------------------------------------------
// default I/O seam (the only place that performs real I/O)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} HostsIo
 * @property {(options: { configPath?: string|null, home?: string }) => Promise<{ hosts: any[], configPath: string, missing: boolean }>} [listSshHosts]
 * @property {(options: { file?: string }) => Promise<any>} [readStore]
 * @property {(alias: string, credential: { port: number, token: string }, options: { file?: string }) => Promise<any>} [upsertHost]
 * @property {(alias: string, options: { file?: string }) => Promise<boolean>} [removeHost]
 * @property {(options: { alias: string, remotePort: number, sshBinary?: string, onLog?: (line: string) => void }) => any} [createTunnel]
 * @property {(options: object) => any} [createClient]
 * @property {(options: { env?: NodeJS.ProcessEnv }) => string} [resolveStorePath]
 */

/** @type {HostsIo} */
export const DEFAULT_IO = {
  listSshHosts,
  readStore,
  upsertHost,
  removeHost,
  createTunnel: (options) => new Tunnel(options),
  createClient: (options) => new RemoteHostClient(options),
  resolveStorePath: (options = {}) => storePath(options.env)
};

// ---------------------------------------------------------------------------
// the aggregation service
// ---------------------------------------------------------------------------

/**
 * Holds per-host state for the lifetime of the plugin.
 *
 * All host state (SSH tunnel child process, remote session cookie, last known
 * status) lives in the `#hosts` map: a host is reused across requests and its
 * tunnel is only ever created on demand, which is what keeps `/hosts/list`
 * free of SSH.
 */
export class RemoteHosts {
  /** @type {Map<string, { tunnel: any, client: any, state: string, failed?: boolean, lastFailure?: { kind?: string, message?: string } }>} */
  #hosts = new Map();
  /**
   * Last known terminal status per alias. It survives the deletion of the live
   * client so a credential rejection stays visible until the user supplies a
   * new credential.
   * @type {Map<string, { state: string, lastFailure?: { kind?: string, message?: string } }>}
   */
  #terminal = new Map();
  /** @type {boolean} */
  #disposed = false;
  /** @type {string|undefined} */
  #cachedConfigPath;

  /**
   * @param {object} [options]
   * @param {Partial<typeof DEFAULT_CONFIG>} [options.config]
   * @param {HostsIo} [options.io]
   */
  constructor(options = {}) {
    this.config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
    this.io = { ...DEFAULT_IO, ...(options.io ?? {}) };
  }

  /** Store file used for every credential read and write. */
  storeFile() {
    return this.io.resolveStorePath({ env: undefined });
  }

  /** Options passed to the credentials module, so reads and writes agree. */
  #storeOptions() {
    return { file: this.storeFile() };
  }

  /** The SSH config path that was actually read (reported by the parser). */
  get sshConfigPath() {
    return this.#cachedConfigPath;
  }

  /**
   * Read the SSH config (filesystem only).
   * @returns {Promise<{ hosts: any[], configPath: string, missing: boolean }>}
   */
  async readSshHosts() {
    const result = await this.io.listSshHosts({
      ...(this.config.sshConfigPath !== null && this.config.sshConfigPath !== undefined
        ? { configPath: this.config.sshConfigPath }
        : {})
    });
    this.#cachedConfigPath = result.configPath;
    return result;
  }

  /**
   * `/hosts/list` — CONTRACT.md §3.1: no SSH, no network, no child process.
   * Reads the SSH config and the credential store and nothing else.
   *
   * @returns {Promise<{ sshConfigPath: string, hosts: object[] }>}
   */
  async listHosts() {
    const ssh = await this.readSshHosts();
    const store = await this.io.readStore(this.#storeOptions());
    return { sshConfigPath: ssh.configPath, hosts: this.#projectAll(ssh.hosts, store) };
  }

  /**
   * Project every SSH host, merging the store and any live runtime state.
   * @param {any[]} sshHosts
   * @param {{ hosts?: Record<string, any> }} store
   */
  #projectAll(sshHosts, store) {
    const entries = store?.hosts ?? {};
    return sshHosts.map((sshHost) =>
      buildHostView({
        sshHost,
        entry: entries[sshHost.alias],
        runtime: this.#runtimeFor(sshHost.alias)
      })
    );
  }

  /**
   * Runtime facts about one alias, never touching the network.
   *
   * A live client's state wins; once the client has been dropped (a credential
   * rejection deletes it) the terminal status recorded alongside the failure
   * keeps `needs-credentials` visible to `/hosts/list` until the next
   * successful interaction.
   */
  #runtimeFor(alias) {
    const host = this.#hosts.get(alias);
    const terminal = this.#terminal.get(alias);
    if (host === undefined) {
      return terminal === undefined ? {} : { state: terminal.state, lastFailure: terminal.lastFailure };
    }
    if (host.failed === true) {
      // A recorded failure outranks whatever the client last reported.
      return { state: 'unreachable', lastFailure: host.lastFailure ?? terminal?.lastFailure };
    }
    return {
      state: host.client?.state,
      ...(host.lastFailure !== undefined
        ? { lastFailure: host.lastFailure }
        : terminal?.lastFailure !== undefined
          ? { lastFailure: terminal.lastFailure }
          : {})
    };
  }

  /**
   * Lazily create (and cache) the tunnel + remote client for one alias.
   *
   * `connectTimeoutMs` from CONTRACT.md §6 is re-applied here because
   * `RemoteHostClient.ensureReady()` calls `tunnel.ensureOpen()` with no
   * arguments, so the configured budget would otherwise never reach the
   * tunnel. The wrapper (not the raw `Tunnel`) is what gets cached, so the
   * browser hand-off in `openRemote()` inherits the same budget and the same
   * `localPort` view.
   *
   * @param {string} alias
   * @param {{ port: number, token: string }} entry
   */
  #hostFor(alias, entry) {
    const existing = this.#hosts.get(alias);
    if (existing !== undefined) return existing;
    const timeoutMs = this.config.connectTimeoutMs;
    const rawTunnel = this.io.createTunnel({ alias, remotePort: entry.port });
    const tunnel = {
      ensureOpen: (options = {}) => rawTunnel.ensureOpen({ timeoutMs, ...options }),
      close: () => rawTunnel.close(),
      dispose: () => rawTunnel.dispose(),
      get localPort() {
        return rawTunnel.localPort;
      }
    };
    const client = this.io.createClient({ alias, remotePort: entry.port, token: entry.token, tunnel });
    const host = { tunnel, client, state: client.state ?? 'unknown', failed: false };
    this.#hosts.set(alias, host);
    return host;
  }

  /**
   * Drop cached tunnel + cookie for one alias so the next interaction starts
   * from the credential currently on disk (used by `/hosts/add` and whenever a
   * credential is rejected).
   *
   * @param {string} alias
   */
  async dropHost(alias) {
    const host = this.#hosts.get(alias);
    this.#hosts.delete(alias);
    if (host === undefined) return;
    try {
      host.client?.invalidateSession?.();
    } catch {
      // A client that cannot invalidate is about to be dropped anyway.
    }
    try {
      await host.tunnel?.dispose?.();
    } catch {
      // Disposal is best effort; the process may already be gone.
    }
  }

  /**
   * Resolve one alias, refusing anything that is not a literal SSH config host.
   * @param {any[]} sshHosts
   * @param {string} alias
   */
  #requireSshHost(sshHosts, alias) {
    const host = byAlias(sshHosts).get(alias);
    if (host === undefined) {
      throw Object.assign(new Error(`no host named ${JSON.stringify(alias)} in the SSH config`), {
        kind: 'unknown-host'
      });
    }
    return host;
  }

  /**
   * Read one stored credential, refusing unknown aliases and unconfigured hosts.
   * @param {string} alias
   */
  async #requireEntry(alias) {
    const ssh = await this.readSshHosts();
    this.#requireSshHost(ssh.hosts, alias);
    const store = await this.io.readStore(this.#storeOptions());
    const entry = store?.hosts?.[alias];
    if (entry === undefined || typeof entry.token !== 'string' || entry.token.length === 0) {
      throw Object.assign(new Error(`no credential stored for ${alias}`), { kind: 'needs-credentials' });
    }
    return entry;
  }

  /**
   * Run one remote call that must succeed, normalising every failure.
   * @param {string} alias
   * @param {unknown} payload
   * @param {(value: unknown) => unknown} take
   * @returns {Promise<unknown>}
   */
  async #callRemote(alias, payload, take) {
    const entry = await this.#requireEntry(alias);
    const host = this.#hostFor(alias, entry);
    try {
      const envelope = await host.client.call('session/list', payload);
      const value = unwrapResponse(envelope);
      if (value === undefined) {
        throw Object.assign(new Error(`${alias}: the remote did not return a usable session list`), {
          kind: 'unreachable'
        });
      }
      host.state = host.client.state;
      host.failed = false;
      host.lastFailure = undefined;
      return take(value);
    } catch (error) {
      await this.#recordFailure(alias, error, entry);
      throw error;
    }
  }

  /**
   * Record a failure and, for a credential rejection, drop the cached cookie so
   * the next request re-exchanges the token (CONTRACT.md §3.2).
   *
   * A terminal status is kept even after the host's client is dropped, so the
   * very next `/hosts/list` reports `needs-credentials` (or `unreachable`)
   * rather than falling back to `idle`.
   *
   * @param {string} alias
   * @param {unknown} error
   * @param {{ token: string }} entry
   * @returns {Promise<{ kind: string, message: string }>}
   */
  async #recordFailure(alias, error, entry) {
    const { kind, message } = classifyError(error);
    const safe = sanitizeMessage(message, [entry?.token]);
    if (kind === 'needs-credentials') {
      await this.dropHost(alias);
    } else {
      const host = this.#hosts.get(alias);
      if (host !== undefined) {
        host.client?.invalidateSession?.();
        // Any non-credential failure means the host is not usable right now.
        // The client may still be holding a stale `ready`, which would make the
        // next `/hosts/list` claim the host is fine, so record the failure
        // explicitly and let `#runtimeFor` prefer it.
        host.failed = true;
        host.lastFailure = { kind, message: safe };
      }
    }
    this.#terminal.set(alias, {
      state: kind === 'needs-credentials' ? 'needs-credentials' : 'unreachable',
      lastFailure: { kind, message: safe }
    });
    return { kind, message: safe };
  }

  /**
   * Probe one host and normalise its outcome. Never throws: `/hosts/probe`
   * reports per-host failures inside an `ok: true` response.
   *
   * @param {string} alias
   * @returns {Promise<{ alias: string, ok: boolean, kind?: string, message?: string }>}
   */
  async probeOne(alias) {
    try {
      await this.#callRemote(alias, { args: { _request: {} } }, () => undefined);
      this.#terminal.delete(alias);
      return { alias, ok: true };
    } catch (error) {
      const { kind, message } = classifyError(error);
      return { alias, ok: false, kind, message };
    }
  }

  /**
   * Probe every enabled host that has a credential. Errors are per host: the
   * aggregate response stays `ok: true` (CONTRACT.md §2 `HostsProbeView`).
   *
   * @param {string} [alias] - limit the probe to one host
   * @returns {Promise<object[]>} fresh `HostView[]`
   */
  async probeHosts(alias) {
    const ssh = await this.readSshHosts();
    const store = await this.io.readStore(this.#storeOptions());
    const entries = store?.hosts ?? {};

    let aliases;
    if (alias !== undefined) {
      this.#requireSshHost(ssh.hosts, alias);
      aliases = [alias];
    } else {
      aliases = ssh.hosts
        .map((host) => host.alias)
        .filter((name) => {
          const entry = entries[name];
          return entry !== undefined && entry.enabled !== false && typeof entry.token === 'string';
        });
    }

    await Promise.all(aliases.map((name) => this.probeOne(name)));

    return this.#projectAll(ssh.hosts, store);
  }

  /**
   * `/remote/sessions` — pull the remote session list for one host.
   * @param {string} alias
   * @returns {Promise<{ sessions: object[], error?: { kind: string, message: string } }>}
   */
  async listSessionsFor(alias) {
    const entry = await this.#requireEntry(alias);
    try {
      const sessions = await this.#callRemote(alias, { args: { _request: {} } }, (value) =>
        mapRemoteSessions(value, alias)
      );
      return { sessions };
    } catch (error) {
      const { kind, message } = classifyError(error);
      return { sessions: [], error: { kind, message: sanitizeMessage(message, [entry.token]) } };
    }
  }

  /**
   * `/remote/open` — make sure one host's tunnel is usable and build the browser
   * URL for its own Web UI.
   *
   * One tunnel serves both jobs: the `ssh -L` forward already targets the
   * remote `dsh web` port, so RPC and the Web UI share it and no second tunnel
   * is ever opened. The cached entry is reused and only `ensureOpen()` is
   * called; that method is idempotent and shares one in-flight startup, so
   * repeated or concurrent clicks still result in exactly one ssh child.
   *
   * The token travels only inside the returned `url` (see `browserUrlFor`).
   * Failures are classified with the same vocabulary as every other route and
   * their messages are scrubbed before they leave this method — the caller (and
   * `handle()`'s outer catch) must never see a token in an error.
   *
   * Opening a tunnel is deliberately a transport-only operation: it does not
   * touch the recorded host status, which stays owned by the probe and RPC
   * paths (`#recordFailure` / `#callRemote`).
   *
   * @param {string} alias
   * @returns {Promise<{ alias: string, url: string }>} `url` is the only place a token appears
   * @throws {Error & { kind: 'unknown-host'|'needs-credentials'|'unreachable' }} contract-shaped
   */
  async openRemote(alias) {
    const entry = await this.#requireEntry(alias);
    const host = this.#hostFor(alias, entry);
    let localPort;
    try {
      localPort = await host.tunnel.ensureOpen();
    } catch (error) {
      // Any failure to bring the tunnel up is a connectivity story. A raw `ssh`
      // error carries no `kind`, and `classifyError` would call that `internal`;
      // from the user's point of view it is `unreachable`. The message is
      // scrubbed here because the thrown error also travels through
      // `handle()`'s catch, which does not know this host's token.
      const { message } = classifyError(error);
      throw Object.assign(new Error(sanitizeMessage(message, [entry.token])), { kind: 'unreachable' });
    }
    if (typeof localPort !== 'number' || !Number.isInteger(localPort) || localPort <= 0) {
      throw Object.assign(new Error(`${alias}: the tunnel reported no usable local port`), { kind: 'unreachable' });
    }
    return { alias, url: browserUrlFor(alias, localPort, entry.token) };
  }

  // -------------------------------------------------------------------------
  // route handlers (CONTRACT.md §1/§2)
  // -------------------------------------------------------------------------

  /** POST /hosts/list */
  async handleHostsList() {
    const view = await this.listHosts();
    return Response.json({ ok: true, sshConfigPath: view.sshConfigPath, hosts: view.hosts });
  }

  /** POST /hosts/add */
  async handleHostsAdd(request) {
    const body = await readJsonBody(request);
    const alias = body?.alias;
    const credential = body?.credential;
    if (typeof alias !== 'string' || alias.trim() === '') {
      return errorResponse('bad-request', 'body must contain a non-empty "alias"');
    }
    if (typeof credential !== 'string' || credential.trim() === '') {
      return errorResponse('bad-request', 'body must contain a non-empty "credential"');
    }

    const ssh = await this.readSshHosts();
    let sshHost;
    try {
      sshHost = this.#requireSshHost(ssh.hosts, alias);
    } catch (error) {
      const { kind, message } = classifyError(error);
      return errorResponse(kind === 'unknown-host' ? 'unknown-host' : kind, message);
    }

    const parsed = parseCredentialUrl(credential);
    if (!parsed.ok) return errorResponse('bad-request', parsed.reason);

    await this.io.upsertHost(alias, { port: parsed.port, token: parsed.token }, this.#storeOptions());
    // A fresh credential must take effect immediately: drop the old tunnel and
    // its cookie rather than reusing a session minted from the old token.
    await this.dropHost(alias);
    this.#terminal.delete(alias);

    const store = await this.io.readStore(this.#storeOptions());
    const host = buildHostView({ sshHost, entry: store?.hosts?.[alias], runtime: this.#runtimeFor(alias) });
    return Response.json({ ok: true, host });
  }

  /** POST /hosts/remove */
  async handleHostsRemove(request) {
    const body = await readJsonBody(request);
    const alias = body?.alias;
    if (typeof alias !== 'string' || alias.trim() === '') {
      return errorResponse('bad-request', 'body must contain a non-empty "alias"');
    }
    await this.dropHost(alias);
    this.#terminal.delete(alias);
    const removed = await this.io.removeHost(alias, this.#storeOptions());
    return Response.json({ ok: true, removed: removed === true });
  }

  /** POST /hosts/probe */
  async handleHostsProbe(request) {
    const body = await readJsonBody(request);
    const alias = body?.alias;
    if (alias !== undefined && typeof alias !== 'string') {
      return errorResponse('bad-request', '"alias" must be a string when present');
    }
    let hosts;
    try {
      hosts = await this.probeHosts(alias);
    } catch (error) {
      const { kind, message } = classifyError(error);
      return errorResponse(kind, message);
    }
    return Response.json({ ok: true, hosts });
  }

  /** POST /remote/sessions */
  async handleRemoteSessions(request) {
    const body = await readJsonBody(request);
    const alias = body?.alias;
    if (typeof alias !== 'string' || alias.trim() === '') {
      return errorResponse('bad-request', 'body must contain a non-empty "alias"');
    }
    const ssh = await this.readSshHosts();
    try {
      this.#requireSshHost(ssh.hosts, alias);
    } catch (error) {
      const { kind, message } = classifyError(error);
      return errorResponse(kind === 'unknown-host' ? 'unknown-host' : kind, message);
    }
    try {
      const result = await this.listSessionsFor(alias);
      return Response.json({
        ok: true,
        host: alias,
        sessions: result.sessions,
        ...(result.error !== undefined ? { error: result.error } : {})
      });
    } catch (error) {
      // Reachable only for a missing credential: `listSessionsFor` maps remote
      // failures into the per-host `error` field.
      const { kind, message } = classifyError(error);
      return errorResponse(kind, message);
    }
  }

  /**
   * POST /remote/open
   *
   * Success is `{ ok: true, alias, url }`; `url` is the only field in this
   * module that is allowed to contain a token. Every failure is a contract
   * error whose `message` has been scrubbed of that token.
   */
  async handleRemoteOpen(request) {
    const body = await readJsonBody(request);
    const alias = body?.alias;
    if (typeof alias !== 'string' || alias.trim() === '') {
      return errorResponse('bad-request', 'body must contain a non-empty "alias"');
    }
    try {
      const target = await this.openRemote(alias);
      // NOTE: never log `target.url` — it carries the launch token.
      return Response.json({ ok: true, alias: target.alias, url: target.url });
    } catch (error) {
      const { kind, message } = classifyError(error);
      // `openRemote` already scrubbed the token it knew about; the extra pass
      // (with no named secret) still redacts any `token=…` shape, so nothing can
      // reach the client inside an error message or a kind.
      return errorResponse(kind, sanitizeMessage(message));
    }
  }

  /**
   * Dispatch one registered route to its handler. Kept separate so tests can
   * drive the exact request/response path without a running Host.
   *
   * @param {string} route
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async handle(route, request) {
    if (this.#disposed) return errorResponse('internal', 'plugin is disposed');
    try {
      switch (route) {
        case `${ROUTE_PREFIX}/hosts/list`:
          return await this.handleHostsList();
        case `${ROUTE_PREFIX}/hosts/add`:
          return await this.handleHostsAdd(request);
        case `${ROUTE_PREFIX}/hosts/remove`:
          return await this.handleHostsRemove(request);
        case `${ROUTE_PREFIX}/hosts/probe`:
          return await this.handleHostsProbe(request);
        case `${ROUTE_PREFIX}/remote/sessions`:
          return await this.handleRemoteSessions(request);
        case `${ROUTE_PREFIX}/remote/open`:
          return await this.handleRemoteOpen(request);
        default:
          return errorResponse('internal', `unhandled route ${route}`);
      }
    } catch (error) {
      const { kind, message } = classifyError(error);
      return errorResponse(kind, message);
    }
  }

  /** Kill every tunnel and forget every cookie. Safe to call more than once. */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const hosts = [...this.#hosts.values()];
    this.#hosts.clear();
    this.#terminal.clear();
    await Promise.all(
      hosts.map(async (host) => {
        try {
          host.client?.invalidateSession?.();
        } catch {
          // Best effort: the tunnel teardown below is what matters.
        }
        try {
          // `Tunnel.dispose()` kills the ssh child process.
          await host.tunnel?.dispose?.();
        } catch {
          // Never let one stuck child block plugin disposal.
        }
      })
    );
  }
}

/**
 * Read and parse a JSON request body, tolerating an empty or malformed body.
 * @param {Request} request
 * @returns {Promise<Record<string, any>|undefined>}
 */
export async function readJsonBody(request) {
  if (request === undefined || request === null) return undefined;
  let text;
  try {
    text = await request.text();
  } catch {
    return undefined;
  }
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Register the six routes through an injected registrar.
 *
 * The registrar is `ctx.connection.fetch.register` in production and a plain
 * recording function under test; either way the returned disposer unregisters
 * exactly what was registered.
 *
 * @param {RemoteHosts} hosts
 * @param {(route: { path: string, methods: readonly string[], requestBody: string, fetch: (request: Request) => Promise<Response> }) => unknown} register
 * @returns {() => Promise<void>}
 */
export function registerRoutes(hosts, register) {
  /** @type {Array<() => unknown>} */
  const disposers = [];
  try {
    for (const route of ROUTES) {
      const disposer = register({
        path: route.path,
        methods: route.methods,
        requestBody: route.requestBody,
        fetch: (request) => hosts.handle(route.path, request)
      });
      if (typeof disposer === 'function') disposers.push(disposer);
    }
  } catch (error) {
    // A duplicate path throws in the framework. Undo whatever succeeded so a
    // hot reload cannot leave half the routes behind, then surface the cause.
    for (const disposer of disposers.reverse()) {
      try {
        Promise.resolve(disposer()).catch(() => {});
      } catch {
        // Ignore: the original failure is the useful one.
      }
    }
    throw error;
  }
  return async () => {
    for (const disposer of disposers.reverse()) {
      try {
        await disposer();
      } catch {
        // Unregistering must not throw during teardown.
      }
    }
  };
}

/**
 * Cordis plugin: registers the routes when a Connection service exists.
 *
 * `enabled: false` registers nothing at all (CONTRACT.md §6) — not even the
 * Connection dependency is entered — while disposal always kills any tunnel
 * that was opened in the meantime (CONTRACT.md §3.4).
 *
 * @param {any} ctx - Cordis context
 * @param {object} [config] - the profile patch `config` block (CONTRACT.md §6)
 * @returns {() => Promise<void>} disposer
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  const hosts = new RemoteHosts({
    config: resolved,
    ...(config !== null && typeof config === 'object' && config.io !== undefined ? { io: config.io } : {})
  });

  if (resolved.enabled !== false) {
    ctx.effect(
      () =>
        ctx.inject(['connection'], (connectionCtx) =>
          connectionCtx.effect(
            () =>
              registerRoutes(hosts, (route) => connectionCtx.connection.fetch.register(route)),
            'remote-hosts: routes'
          )
        ),
      'remote-hosts: host half'
    );
  }

  return () => hosts.dispose();
}

/** Cordis: declare the `connection` dependency before the plugin is applied. */
apply.inject = ['connection'];

/** Shape of the `config` block (CONTRACT.md §6). Validated structurally here
 * rather than with schemastery, which is not a declared dependency of this
 * package; unknown keys are preserved but ignored. */
export function resolveConfig(raw = {}) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  return {
    enabled: input.enabled === undefined ? DEFAULT_CONFIG.enabled : input.enabled !== false,
    sshConfigPath:
      typeof input.sshConfigPath === 'string' && input.sshConfigPath.trim() !== '' ? input.sshConfigPath : null,
    connectTimeoutMs:
      typeof input.connectTimeoutMs === 'number' && Number.isFinite(input.connectTimeoutMs) && input.connectTimeoutMs > 0
        ? input.connectTimeoutMs
        : DEFAULT_CONFIG.connectTimeoutMs
  };
}

export default apply;
