/**
 * Sanity checks for the credential parser and store.
 * Run: node --test test/credentials.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseCredentialUrl,
  maskToken,
  readStore,
  writeStore,
  upsertHost,
  removeHost,
  setHostEnabled,
  publicHosts
} from '../lib/credentials.mjs';

test('parses the exact URL shape dsh web prints', () => {
  const result = parseCredentialUrl('http://127.0.0.1:3080/?token=TESTTOKEN0000000000000000000000000000000000');
  assert.deepEqual(result, { ok: true, port: 3080, token: 'TESTTOKEN0000000000000000000000000000000000' });
});

test('extracts port from a LAN-shaped credential too', () => {
  const result = parseCredentialUrl('http://10.0.0.5:3081/?token=abc123');
  assert.deepEqual(result, { ok: true, port: 3081, token: 'abc123' });
});

test('rejects credentials without a token', () => {
  const result = parseCredentialUrl('http://127.0.0.1:3080/');
  assert.equal(result.ok, false);
  assert.match(result.reason, /token/);
});

test('rejects malformed input', () => {
  assert.equal(parseCredentialUrl('').ok, false);
  assert.equal(parseCredentialUrl('not a url').ok, false);
  assert.equal(parseCredentialUrl('ftp://h:21/?token=x').ok, false);
});

test('masks a token without revealing it', () => {
  const token = 'TESTTOKEN0000000000000000000000000000000000';
  const masked = maskToken(token);
  assert.ok(!masked.includes(token));
  assert.ok(masked.length < token.length);
  assert.equal(maskToken('short'), '******');
  assert.equal(maskToken(''), '');
});

test('store round-trips and never leaks the token to the browser projection', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agg-creds-'));
  const file = path.join(dir, 'store.json');
  try {
    assert.deepEqual(await readStore({ file }), { version: 1, hosts: {} });

    await upsertHost('csj-92', { port: 3080, token: 'secret-token-value' }, { file });
    const store = await readStore({ file });
    assert.equal(store.hosts['csj-92'].port, 3080);
    assert.equal(store.hosts['csj-92'].token, 'secret-token-value');
    assert.equal(store.hosts['csj-92'].enabled, true);

    const projected = publicHosts(store);
    assert.equal(projected.length, 1);
    assert.equal(projected[0].alias, 'csj-92');
    assert.ok(!JSON.stringify(projected).includes('secret-token-value'));
    assert.ok(projected[0].tokenMasked.length > 0);

    await setHostEnabled('csj-92', false, { file });
    assert.equal((await readStore({ file })).hosts['csj-92'].enabled, false);

    assert.equal(await removeHost('csj-92', { file }), true);
    assert.equal(await removeHost('csj-92', { file }), false);
    assert.deepEqual((await readStore({ file })).hosts, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store file is written with owner-only permissions on POSIX', async () => {
  if (process.platform === 'win32') return;
  const dir = await mkdtemp(path.join(tmpdir(), 'agg-perm-'));
  const file = path.join(dir, 'store.json');
  try {
    await writeStore({ version: 1, hosts: {} }, { file });
    const info = await stat(file);
    assert.equal(info.mode & 0o777, 0o600);
    assert.ok((await readFile(file, 'utf8')).includes('"hosts"'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reads a credential from the predecessor store, then migrates it on write', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rh-migrate-'));
  const env = { ...process.env, DSH_HOME: dir };
  const current = path.join(dir, 'plugins', 'dsh-remote-hosts.json');
  const legacy = path.join(dir, 'plugins', 'dsh-remote-aggregator.json');
  try {
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, JSON.stringify({
      version: 1,
      hosts: { 'csj-92': { alias: 'csj-92', port: 3080, token: 'legacy-token', enabled: true } }
    }), 'utf8');

    // The fallback is read-only: a plain read must not create the new file.
    const store = await readStore({ env });
    assert.equal(store.hosts['csj-92'].token, 'legacy-token');
    assert.equal(existsSync(current), false, 'reading must not write the migrated file');

    // The first write lands in this package's own file, with the host preserved.
    await upsertHost('csj-92', { port: 3080, token: 'legacy-token' }, { env });
    assert.equal(existsSync(current), true, 'migrated store created on write');
    assert.equal((await readStore({ env })).hosts['csj-92'].token, 'legacy-token');

    // A corrupt current store yields an EMPTY store, never legacy data.
    await writeFile(current, '{ not json', 'utf8');
    assert.deepEqual((await readStore({ env })).hosts, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
