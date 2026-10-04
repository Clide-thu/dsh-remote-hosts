/**
 * SSH tunnel lifecycle for one remote Host.
 *
 * One instance owns exactly one `ssh -L <localPort>:127.0.0.1:<remotePort>`
 * child process. Tunnels are **lazy**: nothing is spawned until a caller asks
 * for the local port, which is what makes the sidebar cheap to render.
 *
 * Two deliberate implementation choices:
 *
 * 1. **stderr goes to a file, never a pipe.** Piped stdio is unavailable under
 *    some sandboxed hosts (spawn fails with EPERM), and a pipe would also block
 *    forever without a reader. A temp file gives us the same diagnostics with
 *    none of that risk.
 * 2. **The local port is probed, then claimed with `ExitOnForwardFailure=yes`.**
 *    If the port is taken between probe and bind, ssh exits and `ensureOpen()`
 *    retries — a bounded, explicit race rather than a guessed port range.
 *
 * @module tunnel
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { openSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** @typedef {'idle'|'starting'|'open'|'failed'|'closed'} TunnelState */

/**
 * @typedef {object} TunnelOptions
 * @property {string} alias       - SSH config alias to connect to
 * @property {number} remotePort  - remote loopback port (the Host's `dsh web` port)
 * @property {string} [sshBinary] - defaults to `ssh` from PATH
 * @property {(line: string) => void} [onLog] - receives ssh stderr lines
 */

/** Ask the OS for a free loopback port. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        if (port === 0) reject(new Error('could not obtain a free local port'));
        else resolve(port);
      });
    });
  });
}

/**
 * Resolve once the forwarded port answers a real HTTP request.
 *
 * A "can I bind this port" probe is the wrong test: it succeeds while the port
 * is free and fails the moment ssh binds it, so it reports readiness inverted
 * and far too early. An actual request through the tunnel is the only signal
 * that the forward is live. Any HTTP status counts — 401 is the healthy answer
 * for an unauthenticated `GET /`.
 *
 * @param {number} port
 * @param {number} timeoutMs
 * @param {() => boolean} isAborted
 * @returns {Promise<boolean>}
 */
function waitForForward(port, timeoutMs, isAborted) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      if (isAborted()) return resolve(false);
      if (Date.now() > deadline) return resolve(false);
      const req = request(
        { host: '127.0.0.1', port, path: '/', method: 'GET', headers: { connection: 'close' } },
        (res) => {
          res.resume();
          resolve(true);
        }
      );
      req.setTimeout(2000, () => req.destroy());
      req.on('error', () => {
        req.destroy();
        setTimeout(attempt, 150);
      });
      req.end();
    };
    attempt();
  });
}

export class Tunnel {
  /** @type {TunnelState} */
  state = 'idle';
  /** @type {import('node:child_process').ChildProcess | undefined} */
  #child;
  /** @type {number | undefined} */
  #localPort;
  /** @type {Promise<number> | undefined} */
  #opening;
  /** @type {string | undefined} */
  #stderrDir;
  #disposed = false;

  /**
   * @param {TunnelOptions} options
   */
  constructor(options) {
    this.options = options;
  }

  /** The local loopback port, or undefined while the tunnel has never opened. */
  get localPort() {
    return this.#localPort;
  }

  /** Whether a child process is currently alive. */
  get isRunning() {
    return this.#child !== undefined && this.#child.exitCode === null && !this.#child.killed;
  }

  /**
   * Ensure the tunnel is running and return the local port.
   *
   * Concurrent callers share one startup; the in-flight promise is cleared on
   * settle so a later interaction (the lazy-retry path) can try again.
   *
   * @param {{ timeoutMs?: number, attempts?: number }} [options]
   * @returns {Promise<number>}
   */
  async ensureOpen(options = {}) {
    if (this.#disposed) throw new Error('tunnel has been disposed');
    if (this.isRunning && this.#localPort !== undefined) return this.#localPort;
    if (this.#opening !== undefined) return this.#opening;

    const timeoutMs = options.timeoutMs ?? 20000;
    const attempts = options.attempts ?? 3;
    this.#opening = (async () => {
      let lastError;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await this.#openOnce(timeoutMs);
        } catch (error) {
          lastError = error;
          // A bind race is the only retryable failure; ssh reporting an auth or
          // connectivity problem will simply fail again.
          if (this.#disposed) break;
        }
      }
      this.state = 'failed';
      throw lastError ?? new Error(`could not open a tunnel to ${this.options.alias}`);
    })().finally(() => {
      this.#opening = undefined;
    });
    return this.#opening;
  }

  /** Directory holding this tunnel's captured stderr. */
  #stderrPath() {
    if (this.#stderrDir === undefined) {
      this.#stderrDir = path.join(
        tmpdir(),
        `dsh-remote-hosts-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
      );
      mkdirSync(this.#stderrDir, { recursive: true });
    }
    return path.join(this.#stderrDir, 'ssh-stderr.log');
  }

  /** Read captured stderr, tolerating absence. */
  #readStderr() {
    try {
      return readFileSync(this.#stderrPath(), 'utf8');
    } catch {
      return '';
    }
  }

  async #openOnce(timeoutMs) {
    this.state = 'starting';
    const port = await findFreePort();
    const stderrPath = this.#stderrPath();
    const stderrFd = openSync(stderrPath, 'w');

    const args = [
      '-N',
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', `ConnectTimeout=${Math.max(5, Math.round(timeoutMs / 1000))}`,
      // The bind address is PINNED to loopback. Omitting it defers to the user's
      // `GatewayPorts` setting, where `yes` would publish the remote's whole Web
      // UI — the very origin this plugin opens in a local Browser tab — to the
      // LAN. `findFreePort()` and every client already use 127.0.0.1.
      '-L', `127.0.0.1:${port}:127.0.0.1:${this.options.remotePort}`,
      this.options.alias
    ];

    let child;
    try {
      child = spawn(this.options.sshBinary ?? 'ssh', args, {
        // Never 'pipe': piped stdio is refused under some sandboxes.
        stdio: ['ignore', 'ignore', stderrFd],
        windowsHide: true
      });
    } catch (error) {
      throw new Error(`could not start ssh for ${this.options.alias}: ${error?.message ?? error}`);
    }
    this.#child = child;

    let exited = false;
    const exit = new Promise((resolve) => {
      child.once('exit', () => {
        exited = true;
        resolve();
      });
      child.once('error', () => {
        exited = true;
        resolve();
      });
    });

    const outcome = await Promise.race([
      waitForForward(port, timeoutMs, () => exited || this.#disposed).then((ok) => (ok ? 'ready' : 'timeout')),
      exit.then(() => 'exited')
    ]);

    if (outcome !== 'ready') {
      child.kill();
      this.#child = undefined;
      this.state = 'failed';
      const captured = this.#readStderr().trim();
      for (const line of captured.split(/\r?\n/)) {
        if (line.trim() !== '') this.options.onLog?.(line.trim());
      }
      const last = captured === '' ? '' : `: ${captured.split(/\r?\n/).filter((l) => l.trim() !== '').pop()}`;
      throw new Error(
        outcome === 'exited'
          ? `ssh to ${this.options.alias} exited before the tunnel became usable${last}`
          : `ssh tunnel to ${this.options.alias} was not usable within ${timeoutMs} ms${last}`
      );
    }

    // Stream later diagnostics without a pipe: poll the file only when the child dies.
    child.once('exit', () => {
      if (this.#disposed) return;
      const captured = this.#readStderr().trim();
      if (captured !== '') {
        for (const line of captured.split(/\r?\n/)) this.options.onLog?.(line.trim());
      }
      // A tunnel that dies on its own must be re-openable by the next interaction.
      this.state = 'idle';
      this.#child = undefined;
      this.#localPort = undefined;
    });

    this.#localPort = port;
    this.state = 'open';
    return port;
  }

  /** Stop the tunnel and forget the port. Safe to call repeatedly. */
  async close() {
    const child = this.#child;
    this.#child = undefined;
    this.#localPort = undefined;
    this.state = 'closed';
    if (child === undefined || child.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  /** Permanently disable this tunnel and release its temp directory. */
  async dispose() {
    this.#disposed = true;
    await this.close();
    if (this.#stderrDir !== undefined) {
      try {
        rmSync(this.#stderrDir, { recursive: true, force: true });
      } catch {
        // Temp-file cleanup is best effort.
      }
      this.#stderrDir = undefined;
    }
  }
}
