/**
 * Real end-to-end check of the host half, against the live csj-92 host.
 *
 * Drives the real route handlers with real `Request` objects (the same shape the
 * framework passes), so request parsing and response serialisation are both
 * exercised. Deliberately does NOT boot a second DSH instance; a scratch
 * credential store keeps the user's real store untouched.
 *
 * Run: & <bundled node> test/e2e-live.mjs
 */

import { RemoteHosts, ROUTE_PREFIX } from '../lib/index.mjs';
import { parseCredentialUrl } from '../lib/credentials.mjs';

const ALIAS = 'csj-92';
// Live credential from the environment: never commit a real token.
const CREDENTIAL = process.env.DSH_E2E_CREDENTIAL ?? '';
if (CREDENTIAL === '') throw new Error('set DSH_E2E_CREDENTIAL (http://127.0.0.1:<port>/?token=…) before running the live test');
const STORE = new URL('../.e2e-store.json', import.meta.url).pathname.replace(/^\//, '');

const parsed = parseCredentialUrl(CREDENTIAL);
if (!parsed.ok) throw new Error(`credential parse failed: ${parsed.reason}`);

const hosts = new RemoteHosts({
  config: { enabled: true, connectTimeoutMs: 20000 },
  io: { resolveStorePath: () => STORE }
});

const line = (label, value) => console.log(`${label.padEnd(32)} ${value}`);

/** POST one route exactly as the framework would, and parse the JSON answer. */
async function call(path, body) {
  const route = `${ROUTE_PREFIX}/${path}`;
  const request = new Request(`http://127.0.0.1${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  });
  const response = await hosts.handle(route, request);
  return { status: response.status, body: await response.json() };
}

const started = Date.now();

try {
  // 1. /hosts/list — must be pure: no SSH, no network.
  const t0 = Date.now();
  const listed = await call('hosts/list');
  line('hosts/list status', listed.status);
  line('hosts/list ms', Date.now() - t0);
  line('sshConfigPath', listed.body.sshConfigPath);
  line('hosts discovered', listed.body.hosts.length);
  const target = listed.body.hosts.find((host) => host.alias === ALIAS);
  line(`${ALIAS} in config`, target === undefined ? 'NO' : 'yes');
  line(`${ALIAS} hasCredential`, target?.hasCredential);
  line(`${ALIAS} state`, target?.state);
  line('token leaked by hosts/list', JSON.stringify(listed.body).includes(parsed.token) ? 'LEAK!!' : 'no');

  // 2. store the credential (scratch file only)
  const added = await call('hosts/add', { alias: ALIAS, credential: CREDENTIAL });
  line('hosts/add status', added.status);
  line('hosts/add ok', added.body.ok);
  line('hosts/add tokenMasked', added.body.ok ? added.body.host.tokenMasked : added.body.error?.message);
  line('hosts/add raw token leak', JSON.stringify(added.body).includes(parsed.token) ? 'LEAK!!' : 'no');

  // 3. probe — the lazy path: tunnel + token exchange
  const t1 = Date.now();
  const probed = await call('hosts/probe', { alias: ALIAS });
  const probedHost = probed.body.hosts.find((host) => host.alias === ALIAS);
  line('hosts/probe ms (lazy connect)', Date.now() - t1);
  line('probe status', probed.status);
  line('probe state', probedHost?.state);
  line('probe sessionCount', probedHost?.sessionCount);
  if (probedHost?.error) line('probe error', probedHost.error);

  // 4. sessions — the aggregation source
  const sessions = await call('remote/sessions', { alias: ALIAS });
  line('remote/sessions status', sessions.status);
  line('remote/sessions ok', sessions.body.ok);
  line('sessions returned', sessions.body.sessions?.length ?? 0);
  const byCwd = new Map();
  for (const session of sessions.body.sessions ?? []) {
    const key = session.cwd ?? '(no cwd)';
    byCwd.set(key, (byCwd.get(key) ?? 0) + 1);
  }
  for (const [cwd, count] of byCwd) line('  cwd group', `${cwd}  -> ${count} session(s)`);
  const first = sessions.body.sessions?.[0];
  if (first) {
    line('sample session', first.sessionId);
    line('sample title', JSON.stringify(first.title));
    line('sample running', first.running);
  }
  line('raw token leak (sessions)', JSON.stringify(sessions.body).includes(parsed.token) ? 'LEAK!!' : 'no');

  line('total ms', Date.now() - started);
  console.log('\nE2E RESULT: PASS');
} catch (error) {
  console.error('\nE2E RESULT: FAIL');
  console.error(`${error?.name}: ${error?.message}`);
  if (error?.kind) console.error(`kind: ${error.kind}`);
  process.exitCode = 1;
} finally {
  await hosts.dispose();
}
