/**
 * Minimal OpenSSH client-config reader.
 *
 * Scope: exactly what this plugin needs to place an SSH tunnel —
 * Host aliases, HostName, User, Port, ProxyJump, IdentityFile, and Include.
 *
 * OpenSSH semantics that matter here:
 *  - A `Host` line carries one or more patterns; a block applies when one of its
 *    patterns matches. `*` and `?` glob; a leading `!` negates.
 *  - Within the merged configuration for one alias, the FIRST value obtained
 *    wins — so file order is significant and we must not "later wins".
 *  - `Include` is expanded in place, relative paths resolve against ~/.ssh.
 *
 * @module ssh-config
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** A resolved host entry, as needed to build `ssh -L`. */
/**
 * @typedef {object} SshHost
 * @property {string} alias        - the name usable as `ssh <alias>` when the block matches literally
 * @property {string} hostName     - resolved HostName (falls back to the alias)
 * @property {string} [user]       - resolved User
 * @property {number} [port]       - resolved Port
 * @property {string} [proxyJump]  - resolved ProxyJump target
 * @property {string[]} identityFiles - resolved IdentityFile paths (may be empty)
 * @property {string} source       - absolute path of the file that declared the block
 */

const MAX_INCLUDE_DEPTH = 8;

/** Expand a leading `~` the way OpenSSH does. */
function expandHome(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return value;
}

/** Split one config line into the keyword and its value, honouring quotes. */
function splitDirective(line) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  const space = trimmed.search(/[ \t]/);
  let key;
  let rest;
  if (eq >= 0 && (space < 0 || eq < space)) {
    key = trimmed.slice(0, eq);
    rest = trimmed.slice(eq + 1);
  } else if (space >= 0) {
    key = trimmed.slice(0, space);
    rest = trimmed.slice(space + 1);
  } else {
    key = trimmed;
    rest = '';
  }
  // Strip an inline comment that is not inside quotes.
  let value = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) break;
    value += ch;
  }
  return { key: key.toLowerCase(), value: value.trim().replace(/^["']|["']$/g, '') };
}

/**
 * Compile one `Host` pattern the way OpenSSH matches it.
 * @param {string} pattern - single pattern, possibly `!`-negated
 * @returns {{negated: boolean, regex: RegExp}}
 */
function compilePattern(pattern) {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  const escaped = body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return { negated, regex: new RegExp(`^${escaped}$`, 'i') };
}

/**
 * Does one `Host` line's pattern list accept this alias?
 * A pattern list matches when at least one positive pattern matches and no
 * negated pattern matches.
 * @param {string[]} patterns
 * @param {string} alias
 * @returns {boolean}
 */
export function patternsMatch(patterns, alias) {
  let positive = false;
  for (const raw of patterns) {
    const { negated, regex } = compilePattern(raw);
    if (negated) {
      if (regex.test(alias)) return false;
      continue;
    }
    if (regex.test(alias)) positive = true;
  }
  return positive;
}

/**
 * Read and flatten a config file (expanding `Include` in place).
 * @param {string} file - absolute path
 * @param {string} home
 * @param {number} depth
 * @param {string[]} visiting - cycle guard
 * @returns {Promise<Array<{patterns: string[]|null, key: string, value: string, source: string}>>}
 */
async function readConfig(file, home, depth, visiting) {
  if (depth > MAX_INCLUDE_DEPTH) return [];
  if (visiting.includes(file)) return [];
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const nextVisiting = [...visiting, file];
  /** @type {Array<{patterns: string[]|null, key: string, value: string, source: string}>} */
  const out = [];
  let currentPatterns = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const directive = splitDirective(rawLine);
    if (directive === null) continue;
    const { key, value } = directive;
    if (key === 'host') {
      // `Host` with no arguments is invalid; ignore rather than match everything.
      currentPatterns = value.split(/\s+/).filter((token) => token !== '');
      out.push({ patterns: currentPatterns, key: '__block__', value, source: file });
      continue;
    }
    if (key === 'match') {
      // `Match` blocks are conditional on runtime facts we do not model; stop
      // attributing directives to the preceding Host so we never mis-resolve.
      currentPatterns = null;
      continue;
    }
    if (key === 'include') {
      const expanded = expandHome(value, home);
      const targets = expanded.split(/\s+/).filter((token) => token !== '');
      for (const target of targets) {
        const resolved = path.isAbsolute(target) ? target : path.join(path.dirname(file), target);
        // Support a simple trailing-glob Include such as ~/.ssh/conf.d/*.
        if (resolved.includes('*') || resolved.includes('?')) {
          const dir = path.dirname(resolved);
          const base = path.basename(resolved);
          const { readdir } = await import('node:fs/promises');
          let names = [];
          try {
            names = await readdir(dir);
          } catch {
            names = [];
          }
          const compiled = compilePattern(base);
          for (const name of names.sort()) {
            if (!compiled.regex.test(name)) continue;
            out.push(...(await readConfig(path.join(dir, name), home, depth + 1, nextVisiting)));
          }
          continue;
        }
        out.push(...(await readConfig(resolved, home, depth + 1, nextVisiting)));
      }
      continue;
    }
    if (currentPatterns === null) continue; // file-global default: applies to every host
    out.push({ patterns: currentPatterns, key, value, source: file });
  }
  return out;
}

/**
 * Resolve one alias against the flattened config, honouring first-match-wins.
 * @param {Array<{patterns: string[]|null, key: string, value: string, source: string}>} entries
 * @param {string} alias
 * @param {string} home
 * @returns {SshHost}
 */
function resolveAlias(entries, alias, home) {
  /** @type {Record<string, string>} */
  const resolved = {};
  let source = '';
  for (const entry of entries) {
    // `patterns === null` entries are file-global defaults and always apply,
    // but a Host-scoped value already set must keep winning.
    if (entry.patterns !== null && !patternsMatch(entry.patterns, alias)) continue;
    if (entry.patterns !== null && source === '') source = entry.source;
    if (resolved[entry.key] === undefined) resolved[entry.key] = entry.value;
  }
  const identityFiles = [];
  // IdentityFile repeats; the first-match-wins rule applies per occurrence, so
  // collect every declaration that applied to this alias in file order.
  for (const entry of entries) {
    if (entry.key !== 'identityfile') continue;
    if (entry.patterns !== null && !patternsMatch(entry.patterns, alias)) continue;
    identityFiles.push(expandHome(entry.value, home));
  }
  const portText = resolved.port;
  const port = portText !== undefined && /^\d+$/.test(portText) ? Number(portText) : undefined;
  return {
    alias,
    hostName: resolved.hostname ?? alias,
    ...(resolved.user !== undefined ? { user: resolved.user } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(resolved.proxyjump !== undefined && resolved.proxyjump.toLowerCase() !== 'none'
      ? { proxyJump: resolved.proxyjump }
      : {}),
    identityFiles,
    source
  };
}

/**
 * List every concretely named host declared in the user's SSH config.
 *
 * Only literal aliases are listed: a pattern entry such as `Host *.example.com`
 * is not an addressable target, so it is skipped. Block order is preserved.
 *
 * @param {object} [options]
 * @param {string} [options.configPath] - override (tests); defaults to ~/.ssh/config
 * @param {string} [options.home]
 * @returns {Promise<{ hosts: SshHost[], configPath: string, missing: boolean }>}
 */
export async function listSshHosts(options = {}) {
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? path.join(home, '.ssh', 'config');
  const entries = await readConfig(configPath, home, 0, []);
  const missing = entries.length === 0;

  /** @type {string[]} */
  const aliases = [];
  for (const entry of entries) {
    if (entry.key !== '__block__' || entry.patterns === null) continue;
    for (const pattern of entry.patterns) {
      // Skip negations, wildcards and multi-pattern aliases that are not literal.
      if (pattern.startsWith('!')) continue;
      if (/[*?]/.test(pattern)) continue;
      if (!aliases.includes(pattern)) aliases.push(pattern);
    }
  }

  const hosts = aliases.map((alias) => resolveAlias(entries, alias, home));
  return { hosts, configPath, missing };
}
