/**
 * Direct-run tests for the host half (`lib/index.mjs`).
 *
 *   node test/host.test.mjs
 *
 * `node --test` cannot be used here: it spawns a child process and this sandbox
 * refuses piped stdio (`spawn EPERM`). Running the file directly still runs
 * `node:test` in-process, which is why the file ends with an explicit summary
 * and a non-zero exit code on failure.
 *
 * No DSH, no SSH and no network are involved: the tests drive the real route
 * handlers through the real registration function, with the I/O seam (SSH
 * config reader, credential store, tunnel factory, remote client factory)
 * replaced by recording fakes. That is exactly the seam that makes the
 * `/hosts/list` purity claim testable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONFIG,
  ROUTE_PREFIX,
  ROUTES,
  RemoteHosts,
  apply,
  browserUrlFor,
  buildHostView,
  classifyError,
  mapRemoteSessions,
  readJsonBody,
  registerRoutes,
  resolveConfig,
  resolveHostState,
  safeMaskToken,
  sanitizeMessage
} from '../lib/index.mjs';
import { listSshHosts } from '../lib/ssh-config.mjs';
import { readStore, removeHost, upsertHost } from '../lib/credentials.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');

/** Secrets used throughout; every assertion checks these never escape. */
const TOKEN = 'TESTTOKEN0000000000000000000000000000000000';
const OTHER_TOKEN = 'QQ7x1GAXn0DJkD5ycdKdH5QY8hABacDkP7XXrMtDZZZ';
const SHORT_TOKEN = 'abcd';

/** A minimal ssh config: a literal host, a host with its own HostName/User,
 * and a host with no credential in the store. */
const SSH_CONFIG = [
  '# fixture config for the host-half tests',
  'Host alpha',
  '  HostName a.example.com',
  '  User alice',
  '',
  'Host beta',
  '',
  'Host gamma',
  '  HostName g.example.com',
  '  ProxyJump bastion',
  ''
].join('\n');

/**
 * The plugin directory is the only place whose artifacts survive across tool
 * calls, so fixtures live here rather than in the OS temp directory.
 */
async function makeScratch(label) {
  await mkdir(join(PLUGIN_ROOT, 'test'), { recursive: true });
  const dir = await mkdtemp(join(PLUGIN_ROOT, 'test', `.tmp-${label}-`));
  return {
    dir,
    configPath: join(dir, 'ssh_config'),
    storeFile: join(dir, 'dsh-remote-hosts.json'),
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** Write the SSH config fixture. */
async function writeSshConfig(configPath, text = SSH_CONFIG) {
  await writeFile(configPath, text, 'utf8');
}

/** Populate the credential store fixture atomically via the real writer. */
async function seedStore(storeFile, hosts) {
  for (const [alias, entry] of Object.entries(hosts)) {
    await upsertHost(alias, { port: entry.port, token: entry.token }, { file: storeFile });
  }
}

/** Run one route through the real hosts, with the network counter armed. */
async function post(hosts, route, body) {
  const request = new Request(`http://127.0.0.1:19387${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  });
  const response = await hosts.handle(route, request);
  return { status: response.status, body: await response.json() };
}

/**
 * Build an hosts plus its fakes over a scratch directory.
 *
 * @param {object} options
 * @param {string} options.configPath
 * @param {string} options.storeFile
 * @param {(alias: string) => void} [options.answer]
 */
function makeHarness(options) {
  const { configPath, storeFile } = options;
  const answer = options.answer ?? (() => {});
  /** @type {Array<object>} */
  const tunnels = [];
  /** @type {Array<object>} */
  const clients = [];
  /** @type {string[]} */
  const unknownRequests = [];

  const io = {
    listSshHosts: (request) => listSshHosts({ ...request, configPath }),
    readStore: (request) => readStore(request),
    upsertHost: (alias, credential, request) => upsertHost(alias, credential, request),
    removeHost: (alias, request) => removeHost(alias, request),
    resolveStorePath: () => storeFile,
    createTunnel: (config) => {
      const tunnel = {
        config,
        ensureOpenCalls: 0,
        closeCalls: 0,
        disposeCalls: 0,
        disposed: false,
        localPort: 41000 + tunnels.length,
        async ensureOpen() {
          tunnel.ensureOpenCalls += 1;
          return tunnel.localPort;
        },
        async close() {
          tunnel.closeCalls += 1;
        },
        async dispose() {
          tunnel.disposeCalls += 1;
          tunnel.disposed = true;
        }
      };
      tunnels.push(tunnel);
      return tunnel;
    },
    createClient: (config) => {
      const client = {
        config,
        state: 'unknown',
        calls: [],
        invalidateCalls: 0,
        hasSession: false,
        async ensureReady() {
          client.state = 'ready';
          client.hasSession = true;
        },
        async call(endpoint, payload) {
          client.calls.push({ endpoint, payload });
          answer(config.alias);
          // The real `RemoteHostClient.call()` runs `ensureReady()` first, so a
          // successful call leaves the client `ready`. The fake must do the same
          // or the hosts cannot propagate a `ready` state.
          client.state = 'ready';
          client.hasSession = true;
          return {
            type: 'server-response',
            rpcId: 'rpc-1',
            result: { ok: true, value: { items: [] } }
          };
        },
        invalidateSession() {
          client.invalidateCalls += 1;
          client.hasSession = false;
          if (client.state === 'ready') client.state = 'unknown';
        },
        async dispose() {
          await config.tunnel.dispose();
        }
      };
      clients.push(client);
      return client;
    }
  };

  const hosts = new RemoteHosts({
    config: { enabled: true, sshConfigPath: configPath },
    io
  });

  return {
    hosts,
    io,
    tunnels,
    clients,
    unknownRequests,
    byAlias(alias) {
      return clients.find((client) => client.config.alias === alias);
    },
    tunnelFor(alias) {
      return tunnels.find((tunnel) => tunnel.config.alias === alias);
    }
  };
}

/**
 * A `connection.fetch.register` look-alike: records every route and refuses a
 * duplicate exact path the way the real route table does.
 */
function makeRegistrar() {
  /** @type {Map<string, object>} */
  const routes = new Map();
  /** @type {Array<string>} */
  const disposals = [];
  return {
    routes,
    disposals,
    register(route) {
      if (routes.has(route.path)) throw new Error(`route already registered: ${route.path}`);
      routes.set(route.path, route);
      return async () => {
        disposals.push(route.path);
        routes.delete(route.path);
      };
    },
    async fetch(route, body) {
      const entry = routes.get(route);
      assert.ok(entry !== undefined, `route ${route} is not registered`);
      const request = new Request(`http://127.0.0.1:19387${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {})
      });
      const response = await entry.fetch(request);
      return { status: response.status, body: await response.json() };
    }
  };
}

// ---------------------------------------------------------------------------
// 1. registration surface
// ---------------------------------------------------------------------------

test('registers exactly the six contract routes, once each', async () => {
  const scratch = await makeScratch('routes');
  try {
    await writeSshConfig(scratch.configPath);
    const harness = makeHarness(scratch);
    const registrar = makeRegistrar();

    const dispose = registerRoutes(harness.hosts, (route) => registrar.register(route));

    assert.deepEqual(
      [...registrar.routes.keys()],
      [
        `${ROUTE_PREFIX}/hosts/list`,
        `${ROUTE_PREFIX}/hosts/add`,
        `${ROUTE_PREFIX}/hosts/remove`,
        `${ROUTE_PREFIX}/hosts/probe`,
        `${ROUTE_PREFIX}/remote/sessions`,
        `${ROUTE_PREFIX}/remote/open`
      ]
    );
    for (const route of ROUTES) {
      const registered = registrar.routes.get(route.path);
      assert.deepEqual(registered.methods, ['POST']);
      assert.equal(registered.requestBody, 'buffered');
      assert.equal(typeof registered.fetch, 'function');
      assert.ok(route.path.startsWith('/api/'), `${route.path} must start with /api/`);
      // The framework's endpointFromPath requires this segment alphabet.
      for (const segment of route.path.split('/').slice(2)) {
        assert.match(segment, /^[A-Za-z0-9_$.-]+$/, `segment ${segment} must be path-safe`);
      }
    }

    const registeredPaths = [...registrar.routes.keys()];
    await dispose();
    assert.deepEqual(registrar.disposals, [...registeredPaths].reverse(), 'unregistered in reverse order');
    assert.equal(registrar.routes.size, 0, 'disposer must unregister every route');
  } finally {
    await scratch.cleanup();
  }
});

test('a duplicate path fails loudly and leaves nothing half-registered', async () => {
  const scratch = await makeScratch('dup');
  try {
    await writeSshConfig(scratch.configPath);
    const harness = makeHarness(scratch);
    const registrar = makeRegistrar();

    // Poison the third route so registration must unwind the first two.
    const original = registrar.register;
    let seen = 0;
    const poisoned = {
      ...registrar,
      routes: registrar.routes,
      register(route) {
        seen += 1;
        if (seen === 3) throw new Error(`route already registered: ${route.path}`);
        return original.call(registrar, route);
      }
    };

    assert.throws(
      () => registerRoutes(harness.hosts, (route) => poisoned.register(route)),
      /already registered/
    );
    assert.equal(registrar.routes.size, 0, 'the two successful registrations must be undone');
  } finally {
    await scratch.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. /hosts/list projection + purity
// ---------------------------------------------------------------------------

test('/hosts/list merges ssh config hosts with stored credentials', async () => {
  const scratch = await makeScratch('list');
  try {
    await writeSshConfig(scratch.configPath);
    await seedStore(scratch.storeFile, {
      alpha: { port: 3080, token: TOKEN },
      beta: { port: 3099, token: OTHER_TOKEN }
    });
    const harness = makeHarness(scratch);

    const { status, body } = await post(harness.hosts, `${ROUTE_PREFIX}/hosts/list`);

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.sshConfigPath, scratch.configPath);
    assert.deepEqual(body.hosts.map((host) => host.alias), ['alpha', 'beta', 'gamma']);

    const alpha = body.hosts[0];
    assert.equal(alpha.hostName, 'a.example.com');
    assert.equal(alpha.user, 'alice');
    assert.equal(alpha.hasCredential, true);
    assert.equal(alpha.enabled, true);
    assert.equal(alpha.state, 'idle');
    assert.equal(alpha.tokenMasked, safeMaskToken(TOKEN));
    assert.ok(!('error' in alpha), 'a fresh host carries no error');

    const gamma = body.hosts[2];
    assert.equal(gamma.hostName, 'g.example.com');
    assert.equal(gamma.proxyJump, 'bastion');
    assert.equal(gamma.hasCredential, false);
    assert.equal(gamma.state, 'idle');
    assert.equal(gamma.enabled, true);
    assert.ok(!('tokenMasked' in gamma), 'no credential means no tokenMasked field');
  } finally {
    await scratch.cleanup();
  }
});

test('/hosts/list performs no SSH, no network and no file I/O at all', async () => {
  const scratch = await makeScratch('pure');
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (...args) => {
    fetchCalls += 1;
    return originalFetch(...args);
  };

  try {
    await writeSshConfig(scratch.configPath);
    await seedStore(scratch.storeFile, { alpha: { port: 3080, token: TOKEN } });

    // Wrap every filesystem-touching seam with a counter. The hosts can
    // only reach the filesystem through the injected seam, so a non-zero
    // counter here would disprove purity.
    let fileReads = 0;
    const harness = makeHarness(scratch);
    const io = {
      ...harness.io,
      listSshHosts: (request) => {
        fileReads += 1;
        return listSshHosts({ ...request, configPath: scratch.configPath });
      },
      readStore: (request) => {
        fileReads += 1;
        return readStore(request);
      }
    };
    const hosts = new RemoteHosts({
      config: { enabled: true, sshConfigPath: scratch.configPath },
      io
    });

    const { body } = await post(hosts, `${ROUTE_PREFIX}/hosts/list`);

    assert.equal(body.ok, true);
    assert.equal(body.hosts.length, 3);
    assert.equal(fileReads, 2, 'exactly one ssh-config read and one store read');
    for (const tunnel of harness.tunnels) assert.equal(tunnel.ensureOpenCalls, 0);
    assert.equal(harness.tunnels.length, 0, '/hosts/list must not create a tunnel');
    assert.equal(harness.clients.length, 0, '/hosts/list must not create a remote client');
    assert.equal(fetchCalls, 0, '/hosts/list must not touch the network');
  } finally {
    globalThis.fetch = originalFetch;
    await scratch.cleanup();
  }
});

test('the registered /hosts/list handler answers the same shape over the route table', async () => {
  const scratch = await makeScratch('route-list');
  try {
    await writeSshConfig(scratch.configPath);
    const harness = makeHarness(scratch);
    const registrar = makeRegistrar();
    await registerRoutes(harness.hosts, (route) => registrar.register(route));

    const { status, body } = await registrar.fetch(`${ROUTE_PREFIX}/hosts/list`, {});

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.hosts.length, 3);
  } finally {
    await scratch.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. token masking
// ---------------------------------------------------------------------------

test('no HostView field ever contains a raw token', async () => {
  const scratch = await makeScratch('mask');
  try {
    await writeSshConfig(scratch.configPath);
    await seedStore(scratch.storeFile, { alpha: { port: 3080, token: TOKEN } });

    const store = await readStore({ file: scratch.storeFile });
    const view = buildHostView({
      sshHost: (await listSshHosts({ configPath: scratch.configPath })).hosts[0],
      entry: store.hosts.alpha,
      runtime: { lastFailure: { kind: 'unreachable', message: `ssh refused ${TOKEN} from alpha` } }
    });

    const serialized = JSON.stringify(view);
    assert.ok(!serialized.includes(TOKEN), 'the raw token must not appear anywhere in a HostView');
    assert.equal(view.tokenMasked, 'TES…000');
    assert.ok(view.error.includes('[redacted]'));
    assert.ok(!view.error.includes(TOKEN));
    assert.equal(Object.keys(view).filter((key) => /token/i.test(key)).join(','), 'tokenMasked');
  } finally {
    await scratch.cleanup();
  }
});

test('a token too short to mask is masked anyway', () => {
  assert.equal(safeMaskToken(SHORT_TOKEN), '******');
  assert.notEqual(safeMaskToken(SHORT_TOKEN), SHORT_TOKEN);
  assert.equal(safeMaskToken(''), '');
  assert.equal(safeMaskToken(TOKEN), 'TES…000');
});

test('sanitizeMessage scrubs bare, query-shaped and percent-encoded secrets', () => {
  const message = `failed http://127.0.0.1:3080/?token=${TOKEN} (token=${TOKEN}) encoded ${encodeURIComponent(TOKEN)}`;
  const safe = sanitizeMessage(message, [TOKEN]);
  assert.ok(!safe.includes(TOKEN));
  assert.ok(!safe.includes(encodeURIComponent(TOKEN)));
  assert.ok(safe.includes('[redacted]'));
});

// ---------------------------------------------------------------------------
// 4. credential failure → needs-credentials + cookie reset
// ---------------------------------------------------------------------------

/** Wire a fake fetch that answers the token exchange with the given status. */
function refuseCredential(status) {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response('denied', { status, headers: { 'content-type': 'text/plain' } });
  };
  return {
    calls: seen,
    restore() {
      globalThis.fetch = originalFetch;
    }
  };
}

test('a rejected credential becomes needs-credentials, drops the cookie, and masks the token', async () => {
  const scratch = await makeScratch('credfail');
  const stub = refuseCredential(401);
  try {
    await writeSshConfig(scratch.configPath);
    await seedStore(scratch.storeFile, { alpha: { port: 3080, token: TOKEN } });

    // The remote client is real here: only the tunnel and the network are fake,
    // so the 401 goes through the genuine token→cookie exchange and the genuine
    // RemoteHostError classification.
    const { RemoteHostClient } = await import('../lib/remote-client.mjs');
    /** @type {Array<object>} */
    const tunnels = [];
    const io = {
      listSshHosts: (request) => listSshHosts({ ...request, configPath: scratch.configPath }),
      readStore: (request) => readStore(request),
      upsertHost: (alias, credential, request) => upsertHost(alias, credential, request),
      removeHost: (alias, request) => removeHost(alias, request),
      resolveStorePath: () => scratch.storeFile,
      createTunnel: (tunnelConfig) => {
        const tunnel = {
          config: tunnelConfig,
          localPort: 41111,
          disposeCalls: 0,
          async ensureOpen() {
            return tunnel.localPort;
          },
          async close() {},
          async dispose() {
            tunnel.disposeCalls += 1;
          }
        };
        tunnels.push(tunnel);
        return tunnel;
      },
      createClient: (clientConfig) => new RemoteHostClient(clientConfig)
    };
    const hosts = new RemoteHosts({
      config: { enabled: true, sshConfigPath: scratch.configPath },
      io
    });

    const sessions = await post(hosts, `${ROUTE_PREFIX}/remote/sessions`, { alias: 'alpha' });

    assert.equal(sessions.status, 200);
    assert.equal(sessions.body.ok, true);
    assert.equal(sessions.body.host, 'alpha');
    assert.deepEqual(sessions.body.sessions, []);
    assert.equal(sessions.body.error.kind, 'needs-credentials');
    assert.ok(!JSON.stringify(sessions.body).includes(TOKEN), 'the raw token must not leak');
    assert.equal(stub.calls.length, 1, 'the exchange was attempted exactly once');

    const after = await post(hosts, `${ROUTE_PREFIX}/hosts/list`);
    const alpha = after.body.hosts.find((host) => host.alias === 'alpha');
    assert.equal(alpha.state, 'needs-credentials');
    assert.equal(alpha.hasCredential, true, 'the stored credential survives; only the cookie was dropped');
    assert.match(alpha.error, /no longer valid/);
    assert.ok(!alpha.error.includes(TOKEN));
    assert.ok(!JSON.stringify(after.body).includes(TOKEN));
    assert.equal(tunnels[0].disposeCalls, 1, 'the rejected host tunnel is torn down');
  } finally {
    stub.restore();
    await scratch.cleanup();
  }
});

test('a transport failure is reported as unreachable without losing the credential', async () => {
  const scratch = await makeScratch('unreachable');
  const stub = refuseCredential(503);
  try {
    await writeSshConfig(scratch.configPath);
    await seedStore(scratch.storeFile, { alpha: { port: 3080, token: TOKEN } });

    const { RemoteHostClient } = await import('../lib/remote-client.mjs');
    const io = {
      listSshHosts: (request) => listSshHosts({ ...request, configPath: scratch.configPath }),
      readStore: (request) => readStore(request),
      upsertHost: (alias, credential, request) => upsertHost(alias, credential, request),
      removeHost: (alias, request) => removeHost(alias, request),
      resolveStorePath: () => scratch.storeFile,
      createTunnel: () => ({
        localPort: 41222,
        async ensureOpen() {
          return 41222;
        },
        async close() {},
        async dispose() {}
      }),
      createClient: (clientConfig) => new RemoteHostClient(clientConfig)
    };
    const hosts = new RemoteHosts({
      config: { enabled: true, sshConfigPath: scratch.configPath },
      io
    });

    const result = await post(hosts, `${ROUTE_PREFIX}/remote/sessions`, { alias: 'alpha' });
    assert.equal(result.body.ok, true);
    assert.equal(result.body.error.kind, 'needs-credentials', '503 without Set-Cookie is still a credential failure');

    const list = await post(hosts, `${ROUTE_PREFIX}/hosts/list`);
    const alpha = list.body.hosts.find((host) => host.alias === 'alpha');
    assert.equal(alpha.state, 'needs-credentials');
    assert.ok(!JSON.stringify(list.body).includes(TOKEN));
  } finally {
    stub.restore();
    await scratch.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. remote session mapping
// ---------------------------------------------------------------------------

test('/remote/sessions maps items, tolerating a custom factory response', async () => {
  const scratch = await makeScratch('sessions');
  try {
    await writeSshConfig(scratch.configPath);
    await seedStore(scratch.storeFile, { alpha: { port: 3080, token: TOKEN } });
    const harness = makeHarness(scratch);
    const hosts = harness.hosts;

    // Override the client factory through the seam already in place.
    const clients = [];
    hosts.io = {
      ...harness.io,
      createClient: (config) => {
        const client = {
          config,
          state: 'unknown',
          hasSession: false,
          async ensureReady() {
            client.state = 'ready';
          },
          async call() {
            return {
              type: 'server-response',
              rpcId: 'rpc-2',
              result: {
                ok: true,
                value: {
                  items: [
                    {
                      sessionId: 'session-1',
                      updatedAt: 1790649152972,
                      running: true,
                      cwd: '/home/csj/Workspace/vec',
                      projections: { kind: 'cached', asOfSeq: 2, values: { title: 'Vector work' } }
                    },
                    {
                      sessionId: 'session-2',
                      updatedAt: 1790649152973,
                      running: false,
                      cwd: '/home/csj/Workspace/vec',
                      projections: { kind: 'cached', asOfSeq: 3, values: { title: null } }
                    }
                  ]
                }
              }
            };
          },
          invalidateSession() {
            client.hasSession = false;
          },
          async dispose() {}
        };
        clients.push(client);
        return client;
      }
    };

    const { status, body } = await post(hosts, `${ROUTE_PREFIX}/remote/sessions`, { alias: 'alpha' });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.host, 'alpha');
    assert.equal(body.error, undefined);
    assert.deepEqual(body.sessions, [
      {
        host: 'alpha',
        sessionId: 'session-1',
        cwd: '/home/csj/Workspace/vec',
        title: 'Vector work',
        updatedAt: 1790649152972,
        running: true
      },
      {
        host: 'alpha',
        sessionId: 'session-2',
        cwd: '/home/csj/Workspace/vec',
        title: null,
        updatedAt: 1790649152973,
        running: false
      }
    ]);
  } finally {
    await scratch.cleanup();
  }
});

test('mapRemoteSessions is defensive about missing and malformed items', () => {
  assert.deepEqual(mapRemoteSessions(undefined, 'alpha'), []);
  assert.deepEqual(mapRemoteSessions({}, 'alpha'), []);
  assert.deepEqual(mapRemoteSessions({ items: null }, 'alpha'), []);
  assert.deepEqual(mapRemoteSessions({ items: [] }, 'alpha'), []);
  assert.deepEqual(mapRemoteSessions({ items: [null, 7, 'nope'] }, 'alpha'), [
    { host: 'alpha', sessionId: '', cwd: '', title: null, updatedAt: 0, running: false },
    { host: 'alpha', sessionId: '', cwd: '', title: null, updatedAt: 0, running: false },
    { host: 'alpha', sessionId: '', cwd: '', title: null, updatedAt: 0, running: false }
  ]);
  assert.deepEqual(
    mapRemoteSessions({ items: [{ sessionId: 's', cwd: '/w', projections: { values: { title: 42 } } }] }, 'alpha'),
    [{ host: 'alpha', sessionId: 's', cwd: '/w', title: null, updatedAt: 0, running: false }]
  );
});

// ---------------------------------------------------------------------------
// 6. /hosts/add, /hosts/remove, /hosts/probe
// ---------------------------------------------------------------------------

test('/hosts/add validates the alias, parses the credential and drops the cached client', async () => {
  const scratch = await makeScratch('add');
  try {
    await writeSshConfig(scratch.configPath);
    const harness = makeHarness(scratch);
    const hosts = harness.hosts;

    // Unknown alias.
    const unknown = await post(hosts, `${ROUTE_PREFIX}/hosts/add`, {
      alias: 'nope',
      credential: `http://127.0.0.1:3080/?token=${TOKEN}`
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.ok, false);
    assert.equal(unknown.body.error.kind, 'unknown-host');
    assert.ok(!JSON.stringify(unknown.body).includes(TOKEN));

    // Malformed credential: the parser's reason is surfaced verbatim.
    const bad = await post(hosts, `${ROUTE_PREFIX}/hosts/add`, {
      alias: 'alpha',
      credential: 'http://127.0.0.1:3080/'
    });
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.error.kind, 'bad-request');
    assert.match(bad.body.error.message, /token/);

    // A missing body is a bad request, not a crash.
    const empty = await post(hosts, `${ROUTE_PREFIX}/hosts/add`, {});
    assert.equal(empty.body.ok, false);
    assert.equal(empty.body.error.kind, 'bad-request');

    // Prime a live client, then replace the credential.
    await seedStore(scratch.storeFile, { alpha: { port: 3080, token: TOKEN } });
    const primed = await post(hosts, `${ROUTE_PREFIX}/hosts/probe`, { alias: 'alpha' });
    assert.equal(primed.body.ok, true);
    assert.equal(primed.body.hosts.find((host) => host.alias === 'alpha').state, 'ready');
    assert.equal(harness.tunnels.length, 1);
    const oldTunnel = harness.tunnels[0];
    assert.equal(harness.byAlias('alpha').calls.length, 1, 'the probe used the cached client');
    assert.equal(harness.byAlias('alpha').calls[0].endpoint, 'session/list');
    assert.deepEqual(harness.byAlias('alpha').calls[0].payload, { args: { _request: {} } });

    const added = await post(hosts, `${ROUTE_PREFIX}/hosts/add`, {
      alias: 'alpha',
      credential: `http://127.0.0.1:3099/?token=${OTHER_TOKEN}`
    });
    assert.equal(added.body.ok, true);
    assert.equal(added.body.host.alias, 'alpha');
    assert.equal(added.body.host.hasCredential, true);
    assert.equal(added.body.host.state, 'idle');
    assert.equal(added.body.host.tokenMasked, safeMaskToken(OTHER_TOKEN));
    assert.ok(!JSON.stringify(added.body).includes(OTHER_TOKEN));
    assert.equal(oldTunnel.disposeCalls, 1, 'the previous tunnel must be disposed');
    assert.equal(harness.byAlias('alpha').invalidateCalls, 1, 'the previous cookie must be cleared');

    const store = await readStore({ file: scratch.storeFile });
    assert.equal(store.hosts.alpha.port, 3099);
    assert.equal(store.hosts.alpha.token, OTHER_TOKEN);

    // The next probe builds a fresh client from the new credential.
    const reprobe = await post(hosts, `${ROUTE_PREFIX}/hosts/probe`, { alias: 'alpha' });
    assert.equal(reprobe.body.hosts.find((host) => host.alias === 'alpha').state, 'ready');
    assert.equal(harness.tunnels.length, 2);
    assert.equal(harness.tunnels[1].config.remotePort, 3099);
    // `byAlias` returns the first client for the alias, which is the dropped
    // one; the re-probe built a fresh client, so assert on the newest entry.
    const newestClient = harness.clients.filter((client) => client.config.alias === 'alpha').at(-1);
    assert.equal(newestClient.config.token, OTHER_TOKEN);
  } finally {
    await scratch.cleanup();
  }
});

test('/hosts/remove reports whether anything was removed', async () => {
  const scratch = await makeScratch('remove');
  try {
    await writeSshConfig(scratch.configPath);
    await seedStore(scratch.storeFile, { alpha: { port: 3080, token: TOKEN } });
    const harness = makeHarness(scratch);

    const first = await post(harness.hosts, `${ROUTE_PREFIX}/hosts/remove`, { alias: 'alpha' });
    assert.deepEqual(first, { status: 200, body: { ok: true, removed: true } });

    const second = await post(harness.hosts, `${ROUTE_PREFIX}/hosts/remove`, { alias: 'alpha' });
    assert.deepEqual(second, { status: 200, body: { ok: true, removed: false } });

    const missing = await post(harness.hosts, `${ROUTE_PREFIX}/hosts/remove`, {});
    assert.equal(missing.body.ok, false);
    assert.equal(missing.body.error.kind, 'bad-request');

    const list = await post(harness.hosts, `${ROUTE_PREFIX}/hosts/list`);
    assert.equal(list.body.hosts.find((host) => host.alias === 'alpha').hasCredential, false);
  } finally {
    await scratch.cleanup();
  }
});

test('/hosts/probe skips hosts without credentials and stays ok:true on per-host failure', async () => {
  const scratch = await makeScratch('probe');
  try {
    await writeSshConfig(scratch.configPath);
    await seedStore(scratch.storeFile, {
      alpha: { port: 3080, token: TOKEN },
      beta: { port: 3099, token: OTHER_TOKEN }
    });
    const harness = makeHarness(scratch);
    harness.hosts.io = {
      ...harness.io,
      createClient: (config) => ({
        config,
        state: 'ready',
        async ensureReady() {},
        async call() {
          if (config.alias === 'beta') throw new Error('tunnel request failed');
          return { type: 'server-response', rpcId: 'r', result: { ok: true, value: { items: [] } } };
        },
        invalidateSession() {},
        async dispose() {}
      })
    };

    const { status, body } = await post(harness.hosts, `${ROUTE_PREFIX}/hosts/probe`, {});

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const byAlias = Object.fromEntries(body.hosts.map((host) => [host.alias, host]));
    assert.equal(byAlias.alpha.state, 'ready');
    assert.equal(byAlias.beta.state, 'unreachable');
    assert.ok(byAlias.beta.error.length > 0);
    assert.equal(byAlias.gamma.state, 'idle', 'a host without credentials is never probed');

    const unknown = await post(harness.hosts, `${ROUTE_PREFIX}/hosts/probe`, { alias: 'nope' });
    assert.equal(unknown.body.ok, false);
    assert.equal(unknown.body.error.kind, 'unknown-host');
  } finally {
    await scratch.cleanup();
  }
});

test('/remote/sessions rejects an unknown alias before any tunnel is created', async () => {
  const scratch = await makeScratch('unknown-session');
  try {
    await writeSshConfig(scratch.configPath);
    const harness = makeHarness(scratch);

    const result = await post(harness.hosts, `${ROUTE_PREFIX}/remote/sessions`, { alias: 'nope' });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.kind, 'unknown-host');
    assert.equal(harness.tunnels.length, 0);
  } finally {
    await scratch.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6b. /remote/open — the browser hand-off
// ---------------------------------------------------------------------------

test('browserUrlFor builds a loopback URL that carries the token in the query only', () => {
  assert.equal(browserUrlFor('alpha', 41234, TOKEN), `http://127.0.0.1:41234/?token=${TOKEN}`);
  // A token that needs escaping must be percent-encoded, never spliced raw.
  assert.equal(browserUrlFor('alpha', 41234, 'a b&c=d'), 'http://127.0.0.1:41234/?token=a%20b%26c%3Dd');
});

test('/remote/open reuses one cached tunnel and returns the browser URL for its port', async () => {
  const scratch = await makeScratch('open');
  try {
    await writeSshConfig(scratch.configPath);
    await seedStore(scratch.storeFile, { alpha: { port: 3080, token: TOKEN } });
    const harness = makeHarness(scratch);

    const first = await post(harness.hosts, `${ROUTE_PREFIX}/remote/open`, { alias: 'alpha' });

    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.body).sort(), ['alias', 'ok', 'url'], 'url is the only token-bearing field');
    assert.equal(first.body.ok, true);
    assert.equal(first.body.alias, 'alpha');
    assert.ok(first.body.url.startsWith('http://127.0.0.1:'), 'the URL must point at loopback');
    assert.ok(first.body.url.includes('/?token='), 'the URL must carry the launch token');
    assert.ok(first.body.url.includes(TOKEN));
    assert.equal(harness.tunnels.length, 1, 'the first open creates exactly one tunnel');

    // The port in the URL is the port of THIS host's tunnel wrapper (the object
    // handed to the client), not a freshly guessed one.
    const wrapper = harness.byAlias('alpha').config.tunnel;
    assert.equal(wrapper.localPort, harness.tunnelFor('alpha').localPort);
    assert.equal(first.body.url, browserUrlFor('alpha', wrapper.localPort, TOKEN));
    assert.equal(harness.tunnels[0].config.remotePort, 3080, 'the tunnel targets the stored remote port');

    // Repeated clicks — one of them concurrent — must not open another ssh.
    const [second, third] = await Promise.all([
      post(harness.hosts, `${ROUTE_PREFIX}/remote/open`, { alias: 'alpha' }),
      post(harness.hosts, `${ROUTE_PREFIX}/remote/open`, { alias: 'alpha' })
    ]);
    assert.equal(second.body.url, first.body.url);
    assert.equal(third.body.url, first.body.url);
    assert.equal(harness.tunnels.length, 1, 'a repeated/concurrent click must reuse the cached tunnel');
    assert.equal(harness.tunnels[0].ensureOpenCalls, 3, 'each click goes through the idempotent ensureOpen');
    assert.equal(
      harness.clients.filter((client) => client.config.alias === 'alpha').length,
      1,
      'the cached client is reused too'
    );
  } finally {
    await scratch.cleanup();
  }
});

test('/remote/open classifies a missing alias, an unknown alias and a missing credential', async () => {
  const scratch = await makeScratch('open-bad');
  try {
    await writeSshConfig(scratch.configPath);
    const harness = makeHarness(scratch);

    const empty = await post(harness.hosts, `${ROUTE_PREFIX}/remote/open`, {});
    assert.equal(empty.status, 200);
    assert.equal(empty.body.ok, false);
    assert.equal(empty.body.error.kind, 'bad-request');
    assert.match(empty.body.error.message, /alias/);

    const wrongType = await post(harness.hosts, `${ROUTE_PREFIX}/remote/open`, { alias: 7 });
    assert.equal(wrongType.body.error.kind, 'bad-request');

    const unknown = await post(harness.hosts, `${ROUTE_PREFIX}/remote/open`, { alias: 'nope' });
    assert.equal(unknown.body.error.kind, 'unknown-host');
    assert.equal('url' in unknown.body, false);

    // `gamma` is in the SSH config but has no stored credential.
    const noCredential = await post(harness.hosts, `${ROUTE_PREFIX}/remote/open`, { alias: 'gamma' });
    assert.equal(noCredential.body.error.kind, 'needs-credentials');
    assert.equal('url' in noCredential.body, false);

    assert.equal(harness.tunnels.length, 0, 'no rejected request may open a tunnel');
    assert.equal(harness.clients.length, 0);
    assert.ok(!JSON.stringify([empty, wrongType, unknown, noCredential]).includes(TOKEN));
  } finally {
    await scratch.cleanup();
  }
});

test('/remote/open reports a tunnel failure as unreachable and never echoes the token', async () => {
  const scratch = await makeScratch('open-unreachable');
  try {
    await writeSshConfig(scratch.configPath);
    await seedStore(scratch.storeFile, { alpha: { port: 3080, token: TOKEN } });
    const harness = makeHarness(scratch);

    // The ssh child fails, and its captured stderr happens to quote the
    // credential URL. That must not survive into the response.
    harness.hosts.io = {
      ...harness.io,
      createTunnel: (config) => ({
        config,
        localPort: undefined,
        async ensureOpen() {
          throw new Error(
            `ssh to ${config.alias} exited before the tunnel became usable: bad bind for http://127.0.0.1:3080/?token=${TOKEN}`
          );
        },
        async close() {},
        async dispose() {}
      })
    };

    const { status, body } = await post(harness.hosts, `${ROUTE_PREFIX}/remote/open`, { alias: 'alpha' });

    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.error.kind, 'unreachable');
    assert.equal('url' in body, false, 'a failed open must not hand back a URL');
    assert.ok(!body.error.message.includes(TOKEN), 'the token must never reach an error message');
    assert.ok(!JSON.stringify(body).includes(TOKEN), 'the token must never reach the response');
    assert.ok(body.error.message.includes('[redacted]'), 'the token is replaced, not silently dropped');
    assert.match(body.error.message, /exited before the tunnel became usable/);
  } finally {
    await scratch.cleanup();
  }
});

test('/remote/open is registered on the route table and dispatched to its handler', async () => {
  const scratch = await makeScratch('open-route');
  try {
    await writeSshConfig(scratch.configPath);
    await seedStore(scratch.storeFile, { alpha: { port: 3080, token: TOKEN } });
    const harness = makeHarness(scratch);
    const registrar = makeRegistrar();
    await registerRoutes(harness.hosts, (route) => registrar.register(route));

    // The descriptor itself carries the contract RouteDescriptor shape.
    const descriptor = ROUTES.find((route) => route.path === `${ROUTE_PREFIX}/remote/open`);
    assert.ok(descriptor !== undefined, '/remote/open must be listed in ROUTES');
    assert.deepEqual(descriptor.methods, ['POST']);
    assert.equal(descriptor.requestBody, 'buffered');

    const registered = registrar.routes.get(`${ROUTE_PREFIX}/remote/open`);
    assert.equal(registered.path, `${ROUTE_PREFIX}/remote/open`);
    assert.deepEqual(registered.methods, ['POST']);
    assert.equal(registered.requestBody, 'buffered');
    assert.equal(typeof registered.fetch, 'function');

    const { status, body } = await registrar.fetch(`${ROUTE_PREFIX}/remote/open`, { alias: 'alpha' });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.alias, 'alpha');
    assert.equal(body.url, browserUrlFor('alpha', harness.tunnels[0].localPort, TOKEN));
    assert.equal(harness.tunnels.length, 1);

    const unknown = await registrar.fetch(`${ROUTE_PREFIX}/remote/open`, { alias: 'nope' });
    assert.equal(unknown.body.error.kind, 'unknown-host');
  } finally {
    await scratch.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. lifecycle
// ---------------------------------------------------------------------------

test('dispose kills every cached tunnel exactly once', async () => {
  const scratch = await makeScratch('dispose');
  try {
    await writeSshConfig(scratch.configPath);
    await seedStore(scratch.storeFile, {
      alpha: { port: 3080, token: TOKEN },
      beta: { port: 3099, token: OTHER_TOKEN }
    });
    const harness = makeHarness(scratch);

    await post(harness.hosts, `${ROUTE_PREFIX}/hosts/probe`, {});
    assert.equal(harness.tunnels.length, 2, 'both credentialed hosts opened a tunnel');

    await harness.hosts.dispose();
    for (const tunnel of harness.tunnels) {
      assert.equal(tunnel.disposeCalls, 1, `${tunnel.config.alias} must be disposed exactly once`);
      assert.equal(tunnel.disposed, true);
    }

    // Idempotent, and a disposed hosts refuses further work.
    await harness.hosts.dispose();
    for (const tunnel of harness.tunnels) assert.equal(tunnel.disposeCalls, 1);

    const after = await post(harness.hosts, `${ROUTE_PREFIX}/hosts/list`);
    assert.equal(after.status, 200);
    assert.equal(after.body.ok, false);
    assert.equal(after.body.error.kind, 'internal');
  } finally {
    await scratch.cleanup();
  }
});

test('the Cordis plugin registers through ctx.inject and disposes its tunnels', async () => {
  const scratch = await makeScratch('apply');
  try {
    await writeSshConfig(scratch.configPath);
    await seedStore(scratch.storeFile, { alpha: { port: 3080, token: TOKEN } });
    const harness = makeHarness(scratch);
    const registrar = makeRegistrar();

    /** @type {Array<{ run: () => unknown, disposer?: unknown, label?: string }>} */
    const effects = [];
    /** @type {unknown} */
    let pluginDisposer;
    const fakeConnectionCtx = {
      connection: { fetch: { register: (route) => registrar.register(route) } },
      effect(run, label) {
        const entry = { run, label };
        effects.push(entry);
        entry.disposer = run();
        return entry.disposer;
      }
    };
    const ctx = {
      inject(services, callback) {
        assert.deepEqual(services, ['connection']);
        return callback(fakeConnectionCtx);
      },
      effect(run, label) {
        const entry = { run, label };
        effects.push(entry);
        entry.disposer = run();
        return entry.disposer;
      }
    };

    // Route the hosts's I/O seam through the harness by pre-seeding the
    // store, then letting the real defaults run against the fixture config.
    pluginDisposer = apply(ctx, {
      enabled: true,
      sshConfigPath: scratch.configPath,
      io: harness.io
    });

    assert.equal(registrar.routes.size, 6);
    assert.deepEqual(
      effects.map((entry) => entry.label),
      ['remote-hosts: host half', 'remote-hosts: routes']
    );

    // A probe through the registered handler opens a tunnel...
    const probe = await registrar.fetch(`${ROUTE_PREFIX}/hosts/probe`, { alias: 'alpha' });
    assert.equal(probe.body.ok, true);
    assert.equal(harness.tunnels.length, 1);

    // ...and /remote/open reuses that same tunnel instead of opening a second one.
    const open = await registrar.fetch(`${ROUTE_PREFIX}/remote/open`, { alias: 'alpha' });
    assert.equal(open.body.ok, true);
    assert.equal(harness.tunnels.length, 1, '/remote/open must reuse the tunnel the probe created');
    assert.equal(harness.tunnels[0].ensureOpenCalls, 1, 'the open is what actually opened the tunnel');
    assert.equal(open.body.url, browserUrlFor('alpha', harness.tunnels[0].localPort, TOKEN));

    // ...and the returned disposer kills it.
    await pluginDisposer();
    assert.equal(harness.tunnels[0].disposeCalls, 1);
    assert.equal(registrar.routes.size, 6, 'unregistration is the framework effect, not the plugin return');

    // Teardown of the injected effect unregisters the routes.
    await effects[1].disposer();
    assert.equal(registrar.routes.size, 0);
  } finally {
    await scratch.cleanup();
  }
});

test('enabled:false registers nothing at all', async () => {
  let injectCalls = 0;
  const ctx = {
    inject() {
      injectCalls += 1;
      return () => {};
    },
    effect(run, label) {
      assert.equal(label, 'remote-hosts: host half');
      return run();
    }
  };

  const disposer = apply(ctx, { enabled: false });
  assert.equal(injectCalls, 0, 'a disabled plugin must not even enter the connection dependency');
  await disposer();
});

test('resolveConfig applies the contract defaults and rejects junk', () => {
  assert.deepEqual(resolveConfig(), DEFAULT_CONFIG);
  assert.deepEqual(resolveConfig({ enabled: false }), { ...DEFAULT_CONFIG, enabled: false });
  assert.deepEqual(resolveConfig({ sshConfigPath: '  ' }), DEFAULT_CONFIG);
  assert.deepEqual(resolveConfig(null), DEFAULT_CONFIG);
  assert.equal(resolveConfig({ sshConfigPath: 'C:/x/config' }).sshConfigPath, 'C:/x/config');
  assert.equal(resolveConfig({ connectTimeoutMs: -5 }).connectTimeoutMs, DEFAULT_CONFIG.connectTimeoutMs);
  assert.equal(resolveConfig({ connectTimeoutMs: 1234 }).connectTimeoutMs, 1234);
});

// ---------------------------------------------------------------------------
// 8. small pure helpers
// ---------------------------------------------------------------------------

test('classifyError maps remote error kinds onto the contract vocabulary', () => {
  // `unknown-host` is itself part of the contract vocabulary (CONTRACT.md §1),
  // so a plain object carrying it passes through unchanged rather than folding
  // to `internal`.
  assert.deepEqual(classifyError(Object.assign(new Error('x'), { kind: 'unknown-host' })), {
    kind: 'unknown-host',
    message: 'x'
  });
  // A kind outside the vocabulary folds to `internal`.
  assert.deepEqual(classifyError(Object.assign(new Error('x'), { kind: 'not-a-kind' })), {
    kind: 'internal',
    message: 'x'
  });
  assert.deepEqual(classifyError(new Error('boom')), { kind: 'internal', message: 'boom' });
  assert.deepEqual(classifyError('plain string'), { kind: 'internal', message: 'plain string' });
});

test('resolveHostState follows the documented precedence', () => {
  assert.equal(resolveHostState({ hasCredential: false }), 'idle');
  assert.equal(resolveHostState({ hasCredential: false, lastFailureKind: 'needs-credentials' }), 'idle');
  assert.equal(resolveHostState({ hasCredential: true }), 'idle');
  assert.equal(resolveHostState({ hasCredential: true, clientState: 'connecting' }), 'connecting');
  assert.equal(resolveHostState({ hasCredential: true, clientState: 'ready' }), 'ready');
  assert.equal(resolveHostState({ hasCredential: true, clientState: 'unreachable' }), 'unreachable');
  assert.equal(resolveHostState({ hasCredential: true, clientState: 'needs-credentials' }), 'needs-credentials');
  assert.equal(resolveHostState({ hasCredential: true, lastFailureKind: 'needs-credentials' }), 'needs-credentials');
  assert.equal(resolveHostState({ hasCredential: true, lastFailureKind: 'unreachable' }), 'unreachable');
});

test('buildHostView omits optional fields instead of emitting undefined', () => {
  const view = buildHostView({ sshHost: { alias: 'beta', hostName: 'beta' }, entry: undefined });
  assert.deepEqual(view, {
    alias: 'beta',
    hostName: 'beta',
    hasCredential: false,
    enabled: true,
    state: 'idle'
  });
  assert.equal('user' in view, false);
  assert.equal('proxyJump' in view, false);
  assert.equal('tokenMasked' in view, false);
  assert.equal('error' in view, false);
});

test('readJsonBody tolerates an empty, malformed or non-object body', async () => {
  const build = (body) =>
    new Request('http://127.0.0.1:19387/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body
    });
  assert.deepEqual(await readJsonBody(build('{"alias":"alpha"}')), { alias: 'alpha' });
  assert.equal(await readJsonBody(build('')), undefined);
  assert.equal(await readJsonBody(build('{oops')), undefined);
  assert.equal(await readJsonBody(build('"a string"')), undefined);
  assert.equal(await readJsonBody(build('null')), undefined);
  assert.equal(await readJsonBody(undefined), undefined);
});

// ---------------------------------------------------------------------------
// direct-run summary (node --test is unavailable in this sandbox)
// ---------------------------------------------------------------------------

process.on('exit', (code) => {
  if (code === 0) console.log('\nhost.test.mjs: all tests passed');
});
