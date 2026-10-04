/**
 * Credential parsing and caching for remote Harness hosts.
 *
 * A user supplies one string per remote host:
 *
 *     http://127.0.0.1:3080/?token=<the-token-dsh-web-printed>
 *
 * Both facts the plugin needs are on the remote side of an SSH tunnel, so this
 * module only *parses* and *stores* them. The tunnel and the token→cookie
 * exchange live in `tunnel.mjs` / `remote-client.mjs`.
 *
 * Storage: `$DSH_HOME/plugins/dsh-remote-hosts.json`, mode 0600, atomic
 * write (temp file + rename). The token never enters the process environment,
 * a log line, or an error message.
 *
 * @module credentials
 */

import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const STORE_VERSION = 1;

/**
 * @typedef {object} StoredHost
 * @property {string} alias       - SSH config alias (the tunnel target)
 * @property {number} port        - remote `dsh web` port parsed from the URL
 * @property {string} token       - remote launch token parsed from the URL
 * @property {boolean} enabled    - whether the host participates in aggregation
 * @property {string} [addedAt]   - ISO timestamp
 */

/**
 * @typedef {object} Store
 * @property {number} version
 * @property {Record<string, StoredHost>} hosts
 */

/** Resolve the DSH home the same way the harness does. */
export function resolveDshHome(env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : path.join(homedir(), '.dsh');
}

/**
 * Parse the credential string a user pastes.
 *
 * Accepts the exact shape `dsh web` prints, including a LAN form such as
 * `http://10.0.0.5:3080/?token=…`; only the port and token are retained, since
 * the plugin reaches the host through its own tunnel.
 *
 * @param {string} input
 * @returns {{ ok: true, port: number, token: string } | { ok: false, reason: string }}
 */
export function parseCredentialUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, reason: 'credential is empty' };
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'credential is not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol ${url.protocol}` };
  }
  const token = url.searchParams.get('token');
  if (token === null || token === '') {
    return {
      ok: false,
      reason: 'credential URL has no ?token=… — copy the URL that `dsh web` printed'
    };
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: `invalid port ${JSON.stringify(url.port)}` };
  }
  return { ok: true, port, token };
}

/**
 * Redact a token for display: keep a short prefix so a user can tell two
 * credentials apart without exposing the whole secret.
 * @param {string} token
 * @returns {string}
 */
export function maskToken(token) {
  if (typeof token !== 'string' || token.length === 0) return '';
  if (token.length <= 6) return '******';
  return `${token.slice(0, 3)}…${token.slice(-3)}`;
}

/** File name of this package's store. */
const STORE_FILE = 'dsh-remote-hosts.json';
/** File name of the predecessor package's store, read once as a migration source. */
const LEGACY_STORE_FILE = 'dsh-remote-aggregator.json';

/** Path of the store file. */
export function storePath(env = process.env) {
  return path.join(resolveDshHome(env), 'plugins', STORE_FILE);
}

/**
 * Path of the predecessor package's store. It is only ever read, never written:
 * a credential saved before the package rename would otherwise have to be
 * pasted again.
 */
export function legacyStorePath(env = process.env) {
  return path.join(resolveDshHome(env), 'plugins', LEGACY_STORE_FILE);
}

/**
 * Read one store file, or `undefined` when it does not exist.
 * A present-but-unreadable or malformed file yields an EMPTY store (never
 * `undefined`), so a corrupt new store cannot resurrect legacy data.
 * @param {string} file
 * @returns {Promise<Store | undefined>}
 */
async function readStoreFile(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    return { version: STORE_VERSION, hosts: {} };
  }
  try {
    const parsed = JSON.parse(text);
    const hosts = parsed?.hosts && typeof parsed.hosts === 'object' ? parsed.hosts : {};
    return { version: STORE_VERSION, hosts };
  } catch {
    return { version: STORE_VERSION, hosts: {} };
  }
}

/**
 * Read the store. A missing or unreadable file yields an empty store rather
 * than an error: first run must not fail. On the first run after the package
 * rename the predecessor store is used as a read-only fallback, so a saved
 * credential survives; the next write lands in this package's own file.
 * @param {object} [options]
 * @param {string} [options.file]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<Store>}
 */
export async function readStore(options = {}) {
  const explicit = options.file !== undefined;
  const file = options.file ?? storePath(options.env);
  const primary = await readStoreFile(file);
  if (primary !== undefined) return primary;
  if (!explicit) {
    const legacy = await readStoreFile(legacyStorePath(options.env));
    if (legacy !== undefined) return legacy;
  }
  return { version: STORE_VERSION, hosts: {} };
}

/**
 * Write the store atomically with owner-only permissions.
 * @param {Store} store
 * @param {object} [options]
 * @param {string} [options.file]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<string>} the file written
 */
export async function writeStore(store, options = {}) {
  const file = options.file ?? storePath(options.env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const body = `${JSON.stringify({ version: STORE_VERSION, hosts: store.hosts }, null, 2)}\n`;
  await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(temp, 0o600);
  } catch {
    // Best effort: Windows does not model POSIX modes the same way.
  }
  await rename(temp, file);
  return file;
}

/**
 * Add or replace one host entry.
 * @param {string} alias
 * @param {{ port: number, token: string }} credential
 * @param {object} [options]
 * @returns {Promise<StoredHost>}
 */
export async function upsertHost(alias, credential, options = {}) {
  const store = await readStore(options);
  const entry = {
    alias,
    port: credential.port,
    token: credential.token,
    enabled: true,
    addedAt: new Date().toISOString()
  };
  store.hosts[alias] = entry;
  await writeStore(store, options);
  return entry;
}

/**
 * Remove one host entry.
 * @param {string} alias
 * @param {object} [options]
 * @returns {Promise<boolean>} whether an entry was removed
 */
export async function removeHost(alias, options = {}) {
  const store = await readStore(options);
  if (!(alias in store.hosts)) return false;
  delete store.hosts[alias];
  await writeStore(store, options);
  return true;
}

/**
 * Flip a host's participation flag.
 * @param {string} alias
 * @param {boolean} enabled
 * @param {object} [options]
 * @returns {Promise<StoredHost|undefined>}
 */
export async function setHostEnabled(alias, enabled, options = {}) {
  const store = await readStore(options);
  const entry = store.hosts[alias];
  if (entry === undefined) return undefined;
  const next = { ...entry, enabled };
  store.hosts[alias] = next;
  await writeStore(store, options);
  return next;
}

/**
 * Project stored hosts for the browser: the token is never included.
 * @param {Store} store
 * @returns {Array<{ alias: string, port: number, enabled: boolean, tokenMasked: string, addedAt?: string }>}
 */
export function publicHosts(store) {
  return Object.values(store.hosts).map((entry) => ({
    alias: entry.alias,
    port: entry.port,
    enabled: entry.enabled !== false,
    tokenMasked: maskToken(entry.token),
    ...(entry.addedAt !== undefined ? { addedAt: entry.addedAt } : {})
  }));
}
