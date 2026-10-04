/**
 * Static verification harness for remote-hosts/client.js.
 *
 * No browser and no npm here: this loads the real lib/client.js artifact the way
 * @deepseek-ai/dsh-client-modules serves it — one classic (non-module) combo
 * script that only REGISTERS a Lazy-CJS factory — then materializes that factory
 * against a minimal fake DOM + fake fetch and drives the panel the way the UI
 * and contract require. Run:
 *   node --experimental-vm-modules verify-client-harness.mjs
 *
 * Lazy-CJS is load-bearing: a raw ESM artifact parses fine as a vm module but
 * dies in the real page with `Unexpected token 'export'`.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** The registration id must be the package name plus the `dsh.client` package name. */
const EXPECTED_ID = 'dsh-remote-hosts';

/* ---------------------------------------------------------------- *
 * Minimal DOM
 * ---------------------------------------------------------------- */

class TextNode {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.childNodes = [];
    this.parentNode = null;
  }
  get textContent() { return this.data; }
}

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img']);

class Element {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.classList = makeClassList(this);
    this.value = '';
    this.disabled = false;
    this.hidden = false;
  }

  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes.length ? this.childNodes[0] : null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() {
    const els = this.children;
    return els.length ? els[els.length - 1] : null;
  }
  // Real DOM `dataset` reflects `data-*` ATTRIBUTES in both directions. The
  // panel mixes the two (`group.dataset.collapsed = …`, `[data-ra-host=…]`
  // selectors), so the fake must too: a selector like
  // `.ra-badge[data-kind="connecting"]` has to see what `dataset.kind` wrote.
  get dataset() {
    if (!this._dataset) this._dataset = makeDataset(this);
    return this._dataset;
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  // placePanel() reads `anchor.nextSibling` and `root.previousElementSibling`
  // to decide whether the panel is already in place.
  get nextSibling() {
    const parent = this.parentNode;
    if (!parent) return null;
    const i = parent.childNodes.indexOf(this);
    return i < 0 ? null : (parent.childNodes[i + 1] || null);
  }
  get previousSibling() {
    const parent = this.parentNode;
    if (!parent) return null;
    const i = parent.childNodes.indexOf(this);
    return i < 1 ? null : (parent.childNodes[i - 1] || null);
  }
  get nextElementSibling() {
    let node = this.nextSibling;
    while (node && node.nodeType !== 1) node = node.nextSibling;
    return node;
  }
  get previousElementSibling() {
    let node = this.previousSibling;
    while (node && node.nodeType !== 1) node = node.previousSibling;
    return node;
  }
  get textContent() {
    return this.childNodes.map((n) => (n.nodeType === 3 ? n.data : n.textContent)).join('');
  }
  set textContent(v) {
    this.childNodes = [];
    if (v !== undefined && v !== null && v !== '') this.appendChild(new TextNode(v));
  }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  // The real DOM reflects these IDL attributes; the panel sets them as
  // properties (`input.name = 'credential'`) and selects by attribute.
  get name() { return this.getAttribute('name') || ''; }
  set name(v) { this.setAttribute('name', v); }
  get type() { return this.getAttribute('type') || ''; }
  set type(v) { this.setAttribute('type', v); }

  appendChild(node) {
    if (!node) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  insertBefore(node, ref) {
    if (ref === null || ref === undefined) return this.appendChild(node);
    const i = this.childNodes.indexOf(ref);
    // The real DOM throws NotFoundError for a foreign reference node, and
    // placePanel()'s try/catch exists for exactly that: keep the throw real so
    // a missing/broken fake capability cannot pass as the guarded fallback.
    if (i < 0) throw new Error('insertBefore: reference node is not a child of this node');
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.splice(i, 0, node);
    return node;
  }
  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
    if (name === 'class') this._syncClasses(String(value));
  }
  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }
  removeAttribute(name) { this.attributes.delete(String(name)); }
  _syncClasses(value) {
    this._classList = new Set(value.split(/\s+/).filter(Boolean));
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, extra = {}) {
    const ev = Object.assign({
      type,
      target: this,
      preventDefault() {},
      stopPropagation() {
        ev._stopped = true;
      }
    }, extra);
    const handlers = this.listeners.get(type) || [];
    for (const fn of handlers) fn(ev);
    return ev;
  }
  focus() { this.ownerDocument.activeElement = this; }
  isConnectedTo(root) {
    let node = this;
    while (node) {
      if (node === root) return true;
      node = node.parentNode;
    }
    return false;
  }
  get isConnected() {
    return this.isConnectedTo(this.ownerDocument.documentElement);
  }
  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (matches(child, selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length ? all[0] : null;
  }
  contains(node) {
    let cur = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0 }; }
}

/** `dataset.raPlacement` <-> `data-ra-placement`, the real DOM's camelCase rule. */
function dataAttrName(prop) {
  return 'data-' + String(prop).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function datasetPropName(attr) {
  return attr.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

/**
 * `element.dataset` as the real DOM defines it: a live view over the `data-*`
 * attributes (`delete el.dataset.tone` removes `data-tone`, and reading an
 * absent key yields `undefined`, never `null`).
 */
function makeDataset(el) {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      const value = el.getAttribute(dataAttrName(prop));
      return value === null ? undefined : value;
    },
    set(_target, prop, value) {
      el.setAttribute(dataAttrName(prop), String(value));
      return true;
    },
    has(_target, prop) {
      return typeof prop === 'string' && el.getAttribute(dataAttrName(prop)) !== null;
    },
    deleteProperty(_target, prop) {
      el.removeAttribute(dataAttrName(prop));
      return true;
    },
    ownKeys() {
      return [...el.attributes.keys()].filter((n) => n.startsWith('data-')).map(datasetPropName);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      const value = el.getAttribute(dataAttrName(prop));
      if (value === null) return undefined;
      return { value, writable: true, enumerable: true, configurable: true };
    }
  });
}

function makeClassList(el) {
  return {
    add(...names) {
      const set = el._classList || new Set();
      for (const n of names) set.add(n);
      el._classList = set;
      el.setAttribute('class', [...set].join(' '));
    },
    remove(...names) {
      const set = el._classList || new Set();
      for (const n of names) set.delete(n);
      el._classList = set;
    },
    contains(name) {
      const cls = el.getAttribute('class') || '';
      return cls.split(/\s+/).includes(name);
    }
  };
}

/** Tiny selector engine: tag, .class, [attr], [attr="v"], plus descendant combinators. */
function matches(el, selector) {
  const parts = String(selector).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  if (!matchesCompound(el, parts[parts.length - 1])) return false;
  let ancestor = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (ancestor) {
      if (ancestor.nodeType === 1 && matchesCompound(ancestor, parts[i])) {
        found = true;
        ancestor = ancestor.parentNode;
        break;
      }
      ancestor = ancestor.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

function matchesCompound(el, sel) {
  const m = /^([a-zA-Z]*)((?:[.#][\w-]+)*)((?:\[[^\]]+\])*)$/.exec(sel);
  if (!m) return false;
  const [, tag, marks, attrs] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  // `#id` and `.class` share the marks group; both must be honored, or an id
  // selector degrades into "matches every element" (see harness regression).
  const markTokens = marks.match(/[.#][\w-]+/g) || [];
  for (const token of markTokens) {
    if (token.startsWith('.')) {
      if (!el.classList.contains(token.slice(1))) return false;
    } else if (el.getAttribute('id') !== token.slice(1)) {
      return false;
    }
  }
  const attrTokens = attrs.match(/\[[^\]]+\]/g) || [];
  for (const token of attrTokens) {
    const body = token.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq < 0) {
      if (el.getAttribute(body) === null) return false;
    } else {
      const name = body.slice(0, eq);
      const value = body.slice(eq + 1).replace(/^["']|["']$/g, '');
      if (el.getAttribute(name) !== value) return false;
    }
  }
  return true;
}

function createDocument() {
  const doc = new Element('html');
  const head = new Element('head');
  const body = new Element('body');
  doc.appendChild(head);
  doc.appendChild(body);
  doc.head = head;
  doc.body = body;
  doc.documentElement = doc;
  doc.readyState = 'complete';
  doc.activeElement = null;
  doc.createElement = (tag) => {
    const node = new Element(tag);
    node.ownerDocument = doc;
    return node;
  };
  doc.createElementNS = (_ns, tag) => doc.createElement(tag);
  doc.createTextNode = (data) => new TextNode(data);
  doc.getElementById = (id) => doc.querySelector('#' + id);
  doc.querySelector = (sel) => (sel.startsWith('#') ? findById(doc, sel.slice(1)) : Element.prototype.querySelector.call(doc, sel));
  doc.querySelectorAll = (sel) => Element.prototype.querySelectorAll.call(doc, sel);
  doc.addEventListener = () => {};
  doc.hidden = false;
  return doc;

  function findById(root, id) {
    for (const child of root.childNodes) {
      if (child.nodeType !== 1) continue;
      if (child.getAttribute('id') === id) return child;
      const deeper = findById(child, id);
      if (deeper) return deeper;
    }
    return null;
  }
}

/* ---------------------------------------------------------------- *
 * MutationObserver spy (watchPlacement coverage)
 * ---------------------------------------------------------------- */

/**
 * Minimal MutationObserver stand-in.
 *
 * lib/client.js never reads the delivered records — it only reacts to "the
 * child list of the node I watch changed" — so the spy records the
 * observe()/disconnect() contract, survives the re-entrant callback
 * (watchPlacement() calls watchPlacement() again) and lets the harness deliver
 * one notification by hand through `fire()`.
 */
function createObserverSpy() {
  const instances = [];
  class SpyMutationObserver {
    constructor(callback) {
      this.callback = typeof callback === 'function' ? callback : null;
      this.observed = [];        // [{ target, options }]
      this.disconnectCount = 0;
      this.fireCount = 0;
      instances.push(this);
    }
    observe(target, options) {
      this.observed.push({ target, options });
    }
    disconnect() {
      this.disconnectCount += 1;
    }
    takeRecords() { return []; }
    /** Test-only: deliver one "observed child list changed" notification. */
    fire() {
      this.fireCount += 1;
      if (this.callback) this.callback([], this);
      return this;
    }
  }
  return {
    MutationObserver: SpyMutationObserver,
    instances,
    latest: () => (instances.length ? instances[instances.length - 1] : null),
    observeCalls: () => instances.reduce((all, o) => all.concat(o.observed), [])
  };
}

/* ---------------------------------------------------------------- *
 * Fake fetch + fixtures
 * ---------------------------------------------------------------- */

const CONTRACT = {
  hosts: [
    { alias: 'csj-92', hostName: '10.0.0.92', user: 'csj', proxyJump: 'lab-j', hasCredential: true, tokenMasked: 'TES…000', enabled: true, state: 'idle' },
    { alias: 'stale-host', hostName: '10.0.0.93', user: 'csj', hasCredential: true, tokenMasked: 'AA1…Zz', enabled: true, state: 'idle' },
    { alias: 'plain-host', hostName: '10.0.0.94', enabled: true, state: 'idle' }
  ]
};

const SESSIONS = {
  'csj-92': [
    { host: 'csj-92', sessionId: 'session-c393ae82-1111-2222-3333-444455556666', cwd: '/home/csj/Workspace/vec', title: 'vec: refactor tunnel', updatedAt: Date.now() - 60000, running: true },
    { host: 'csj-92', sessionId: 'session-c393ae82-7777-8888-9999-000011112222', cwd: '/home/csj/Workspace/vec', title: null, updatedAt: Date.now() - 7200000, running: false },
    { host: 'csj-92', sessionId: 'session-aaaa', cwd: '/home/csj/Workspace/agg', title: 'hosts', updatedAt: Date.now() - 300000, running: false }
  ]
};

function makeTraffic() {
  return [];
}

/**
 * Two *finished* sessions for csj-92 (a host that also carries `proxyJump`).
 * renderGroupMeta only appends the "(N running)" suffix when something runs, so
 * this fixture pins the plain `N sessions` count chip in the expanded body.
 */
const IDLE_SESSIONS = [
  { host: 'csj-92', sessionId: 'session-idle-0001', cwd: '/home/csj/Workspace/vec', title: 'idle one', updatedAt: Date.now() - 60000, running: false },
  { host: 'csj-92', sessionId: 'session-idle-0002', cwd: '/home/csj/Workspace/vec', title: 'idle two', updatedAt: Date.now() - 120000, running: false }
];

/** Deliberately carries a live-looking token: it must never reach the panel DOM. */
const OPEN_URL = 'http://127.0.0.1:51234/?token=TOKEN-abc123';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- *
 * Section 7 fixtures: shell sidebar DOM + fake client services
 * ---------------------------------------------------------------- */

/**
 * The shell's left column: a region element holding the official
 * `[data-slot="sidebar.workspaces"]` outlet. `regionSlot: null` omits the
 * region's own `data-slot="sidebar"` so the column-fallback anchor cannot catch
 * the panel and the flex-column guard is the only variable under test.
 */
function mountSidebarDom(doc, { regionSlot = 'sidebar', tail = false } = {}) {
  const region = doc.createElement('div');
  region.className = 'shell-region';
  if (regionSlot) region.setAttribute('data-slot', regionSlot);
  const anchor = doc.createElement('div');
  anchor.setAttribute('data-slot', 'sidebar.workspaces');
  region.appendChild(anchor);
  // A sibling AFTER the anchor makes "inserted right after the anchor" and
  // "appended to the region" distinguishable outcomes.
  let tailEl = null;
  if (tail) {
    tailEl = doc.createElement('div');
    tailEl.className = 'shell-region-tail';
    region.appendChild(tailEl);
  }
  doc.body.appendChild(region);
  return { region, anchor, tail: tailEl };
}

/** The `open` button of one host group (the group head is rebuilt on notify). */
function openButton(doc, alias) {
  const group = doc.querySelector(`section.ra-group[data-ra-host="${alias}"]`);
  assert.ok(group, `group for ${alias} rendered`);
  const actions = group.querySelector('.ra-group-actions');
  assert.ok(actions, 'group has actions');
  return actions.children.find((b) => b.textContent === 'open') || null;
}

/** Records the `sidebarRight` surface calls the open flow is allowed to make. */
function makeRightService({ openTabThrows = false, expandedAfterToggle = null } = {}) {
  const target = { host: 'dock', tabId: 't1' };
  const right = {
    openTabCalls: [],
    fullscreenCalls: [],
    expandedCalls: 0,
    toggleExpandedCalls: 0,
    target,
    openTab(kind, opts) {
      this.openTabCalls.push([kind, opts]);
      if (openTabThrows) throw new Error('sidebarRight: no session surface is mounted');
      return { id: 'browser' };
    },
    isExpanded() {
      this.expandedCalls++;
      return expandedAfterToggle === null || this.expandedCalls === 1;
    },
    mountedSurface() { return { layout: { mode: 'push' } }; },
    commandTarget() { return target; },
    toggleFullscreen(t) { this.fullscreenCalls.push(t); },
    toggleExpanded() { this.toggleExpandedCalls++; }
  };
  return right;
}

/** The exact `ctx.get()` shape the browser tab reveal resolves through. */
function openContext(right, { browser = true } = {}) {
  return {
    get(name) {
      if (name === 'sidebarRight') return right;
      if (name === 'sidebarRightTabs') {
        return { get: (kind) => (kind === 'browser' && browser ? { id: 'browser' } : undefined) };
      }
      return undefined;
    }
  };
}

function makeFetch(traffic, flags = {}) {
  return async function fetchImpl(url, init) {
    const body = init && init.body ? JSON.parse(init.body) : {};
    traffic.push({ url, method: init && init.method, body });
    if (flags.failAll) throw new Error('network down');
    if (url.endsWith('/hosts/list')) {
      return json({ ok: true, sshConfigPath: '/home/u/.ssh/config', hosts: flags.hosts || CONTRACT.hosts });
    }
    if (url.endsWith('/hosts/add')) {
      if (body.alias === 'plain-host' && !body.credential) {
        return json({ ok: false, error: { kind: 'bad-request', message: 'missing credential' } });
      }
      if (flags.rejectCredential) {
        return json({ ok: false, error: { kind: 'needs-credentials', message: 'token rejected by remote' } });
      }
      return json({ ok: true, host: { alias: body.alias, hostName: '10.0.0.9', hasCredential: true, tokenMasked: 'XX9…Qq', enabled: true, state: 'idle' } });
    }
    if (url.endsWith('/hosts/remove')) {
      return json({ ok: true, removed: true });
    }
    if (url.endsWith('/hosts/probe')) {
      // `probePending` leaves the probe in flight forever so the loading state
      // can be inspected instead of only its eventual outcome.
      if (flags.probePending) return new Promise(() => {});
      if (body.alias === 'stale-host') {
        return json({ ok: true, hosts: [{ alias: 'stale-host', hostName: '10.0.0.93', hasCredential: false, enabled: true, state: 'needs-credentials', error: 'remote rejected token' }] });
      }
      return json({ ok: true, hosts: [{ alias: body.alias, hostName: '10.0.0.92', hasCredential: true, tokenMasked: 'TES…000', enabled: true, state: 'ready', sessionCount: 3 }] });
    }
    if (url.endsWith('/remote/sessions')) {
      if (body.alias === 'stale-host') {
        return json({ ok: true, host: 'stale-host', sessions: [], error: { kind: 'needs-credentials', message: 'remote rejected token' } });
      }
      if (flags.sessionsError) {
        return json({ ok: false, error: { kind: 'unreachable', message: 'ssh connect failed' } });
      }
      // `flags.sessions` replaces the per-alias fixture (e.g. sessions that are
      // all finished, so the count chip stays the plain "N sessions" label).
      if (flags.sessions) {
        return json({ ok: true, host: body.alias, sessions: flags.sessions[body.alias] || [] });
      }
      return json({ ok: true, host: body.alias, sessions: SESSIONS[body.alias] || [] });
    }
    if (url.endsWith('/remote/open')) {
      if (flags.openFails) {
        return json({ ok: false, error: { kind: 'unreachable', message: 'ssh connect failed' } });
      }
      return json({ ok: true, alias: body.alias, url: flags.openUrl || OPEN_URL });
    }
    return json({ ok: false, error: { kind: 'bad-request', message: 'unknown endpoint' } });
  };
}

function json(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return value; }
  };
}

/* ---------------------------------------------------------------- *
 * Load the module
 * ---------------------------------------------------------------- */

async function loadClient({ traffic, flags, document: doc, style, mutationObserver = true }) {
  // `style` is a live holder so one test can flip flexDirection to 'row' and
  // watch placePanel() refuse the region. Default is the real shell's column.
  const computed = style || { flexDirection: 'column' };
  // MutationObserver defaults to the spy so watchPlacement() is exercised; one
  // fixture opts out to keep the "page without MutationObserver" guard covered.
  const observers = createObserverSpy();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Promise,
    Date,
    Math,
    JSON,
    Object,
    Array,
    isFinite,
    fetch: makeFetch(traffic, flags),
    document: doc,
    // placePanel() guards on getComputedStyle(region).flexDirection === 'column'.
    getComputedStyle(node) {
      if (!node || node.nodeType !== 1) return {};
      return { flexDirection: computed.flexDirection };
    },
    CSS: undefined,
    MutationObserver: mutationObserver ? observers.MutationObserver : undefined
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  // The boot loader's queue facade: a plugin bundle only registers its factory.
  const registrations = [];
  sandbox.__ModuleLoader__ = {
    mode: 'queue',
    pendingQueue: registrations,
    load(registration) { registrations.push(registration); }
  };

  const context = vm.createContext(sandbox);
  // Classic script, exactly like the served combo: any surviving top-level
  // `import`/`export` is a SyntaxError here, which is the bug this guards.
  new vm.Script(SOURCE, { filename: 'client.js' }).runInContext(context);

  assert.equal(registrations.length, 1, 'bundle must register exactly one factory');
  const [registration] = registrations;
  assert.equal(registration.id, EXPECTED_ID, 'factory id must be the manifest package name');
  assert.equal(typeof registration.factory, 'function', 'factory must be callable');

  const factoryRequire = (specifier) => {
    throw new Error(`client bundle must not require anything (got ${specifier})`);
  };
  const ns = registration.factory(factoryRequire);
  assert.ok(ns && typeof ns === 'object', 'factory must return an exports object');
  return { ns, registration, sandbox, observers };
}

/* ---------------------------------------------------------------- *
 * Checks
 * ---------------------------------------------------------------- */

const results = [];
function dump(node, depth = 0) {
  const pad = '  '.repeat(depth);
  const label = node.nodeType === 3
    ? pad + '"' + node.data + '"'
    : pad + node.tagName + (node.className ? '.' + node.className.split(/\s+/).join('.') : '')
      + (node.getAttribute('data-ra-host') ? '[' + node.getAttribute('data-ra-host') + ']' : '');
  return [label].concat(node.childNodes.map((c) => dump(c, depth + 1))).join('\n');
}
function check(name, fn) {
  // Return the record itself: composite checks read `boot.ok`/`boot.error`.
  const record = { name, ok: true };
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push(record);
      return record;
    })
    .catch((err) => {
      record.ok = false;
      record.error = err;
      results.push(record);
      return record;
    });
}

function endpoints(traffic) {
  return traffic.map((t) => t.url.replace(/^.*\/api\/dshRemoteHosts/, ''));
}

async function main() {
  /* --- 1. module shape ------------------------------------------------ */
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const { ns, sandbox } = await loadClient({ traffic, document: doc });
    await check('module exports apply (Cordis entry) + default', () => {
      assert.equal(typeof ns.apply, 'function', 'named export apply must exist');
      assert.equal(typeof ns.default, 'function', 'default export must exist');
    });
    const boot = await check('apply(ctx) returns a handle and mounts once', async () => {
      const handle = ns.apply({});
      assert.equal(handle.mounted, true, 'mounted flag');
      const panels = doc.querySelectorAll('#dsh-remote-hosts-panel');
      assert.equal(panels.length, 1, 'exactly one panel node');
      assert.equal(doc.body.contains(panels[0]), true, 'panel lives under document.body');
      assert.equal(typeof sandbox.__dshRemoteHosts, 'object', 'debug handle exposed');
    });
    const twice = await check('mount is idempotent (no double mount)', () => {
      ns.apply({});
      ns.apply(undefined);
      assert.equal(doc.querySelectorAll('#dsh-remote-hosts-panel').length, 1);
    });
    const lazy = await check('lazy: only /hosts/list on load, no probe/sessions', async () => {
      await new Promise((r) => setTimeout(r, 10));
      const seen = endpoints(traffic);
      assert.deepEqual(seen, ['/hosts/list'], 'only the cheap endpoint may be called on load');
    });
    results.push({ name: 'module shape/boot', ok: boot.ok && twice.ok && lazy.ok, error: boot.error || twice.error || lazy.error });
  }

  /* --- 2. groups, lazy expand, cwd grouping --------------------------- */
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const { ns } = await loadClient({ traffic, document: doc });
    ns.apply({});
    await new Promise((r) => setTimeout(r, 20));

    // The panel rebuilds its children on every notify, so group nodes are
    // re-queried after each interaction instead of being held across a render.
    const group = (alias) => doc.querySelector(`section.ra-group[data-ra-host="${alias}"]`);
    const headOf = (alias) => group(alias).querySelector('.ra-group-head');

    await check('one collapsible group per host', () => {
      const groups = doc.querySelectorAll('section.ra-group');
      assert.equal(groups.length, 3, 'three host groups rendered');
      const aliases = groups.map((g) => g.getAttribute('data-ra-host'));
      assert.deepEqual(aliases.slice().sort(), ['csj-92', 'plain-host', 'stale-host']);
      for (const g of groups) {
        const head = g.querySelector('.ra-group-head');
        assert.ok(head, 'group has a clickable header');
        assert.equal(head.getAttribute('role'), 'button');
      }
    });
    await check('groups start collapsed and probe nothing', () => {
      for (const g of doc.querySelectorAll('section.ra-group')) assert.equal(g.dataset.collapsed, 'true');
      assert.deepEqual(endpoints(traffic), ['/hosts/list']);
    });

    await check('expanding a group calls probe + /remote/sessions exactly once each', async () => {
      headOf('csj-92').dispatch('click');
      await new Promise((r) => setTimeout(r, 30));
      const seen = endpoints(traffic);
      assert.equal(seen.filter((e) => e === '/hosts/probe').length, 1, 'one probe');
      assert.equal(seen.filter((e) => e === '/remote/sessions').length, 1, 'one sessions call');
      assert.equal(headOf('csj-92').getAttribute('aria-expanded'), 'true');
    });
    await check('workspaces grouped by cwd with sessions under each', () => {
      const workspaces = group('csj-92').querySelectorAll('.ra-ws');
      assert.equal(workspaces.length, 2, 'two distinct cwds -> two workspace groups');
      const cwds = workspaces.map((w) => w.getAttribute('data-ra-cwd')).sort();
      assert.deepEqual(cwds, ['/home/csj/Workspace/agg', '/home/csj/Workspace/vec']);
      const vec = workspaces.find((w) => w.getAttribute('data-ra-cwd') === '/home/csj/Workspace/vec');
      assert.equal(vec.querySelectorAll('.ra-session').length, 2, 'both vec sessions listed');
      assert.equal(vec.querySelector('.ra-ws-name').textContent, 'vec', 'basename shown');
    });
    await check('session row shows title, or sessionId when title is null', () => {
      const rows = group('csj-92').querySelectorAll('.ra-session');
      const texts = rows.map((r) => r.textContent);
      assert.ok(texts.some((t) => t.includes('vec: refactor tunnel')), 'title rendered');
      const nullTitle = rows.find((r) => r.getAttribute('data-ra-session').includes('7777'));
      assert.ok(nullTitle.textContent.includes('session-c393'), 'null title falls back to sessionId');
    });
    await check('running indicator present for running session only', () => {
      const rows = group('csj-92').querySelectorAll('.ra-session');
      const running = rows.filter((r) => r.classList.contains('ra-running'));
      assert.equal(running.length, 1, 'exactly one running row');
      assert.ok(running[0].querySelector('.ra-dot.ra-dot-on'), 'running dot lit');
      assert.ok(running[0].textContent.includes('running'), 'running tag');
    });
    await check('collapsing again does not re-probe', async () => {
      const before = endpoints(traffic).length;
      // The panel debounces duplicate activations (click + keyboard) by 120ms.
      await new Promise((r) => setTimeout(r, 150));
      headOf('csj-92').dispatch('click');
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(endpoints(traffic).length, before, 'no traffic on collapse');
      // Compare a boolean: inspecting a fake DOM node on failure is misleading.
      assert.equal(group('csj-92').querySelector('.ra-group-body') === null, true, 'body removed when collapsed');
      assert.equal(headOf('csj-92').getAttribute('aria-expanded'), 'false', 'header reports collapsed');
    });
  }

  /* --- 3. needs-credentials re-entry --------------------------------- */
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const { ns } = await loadClient({ traffic, document: doc });
    ns.apply({});
    await new Promise((r) => setTimeout(r, 20));

    const stale = () => doc.querySelector('section.ra-group[data-ra-host="stale-host"]');
    stale().querySelector('.ra-group-head').dispatch('click');
    await new Promise((r) => setTimeout(r, 30));

    await check('needs-credentials shows inline re-entry form', () => {
      const form = stale().querySelector('form[data-ra-cred-form="stale-host"]');
      assert.ok(form, 'credential form rendered for the failing host');
      const input = form.querySelector('input[name="credential"]');
      assert.equal(input.type, 'password', 'credential input is masked');
      assert.ok(form.textContent.includes('rejected'), 'host error surfaced');
    });
    await check('submitting the form calls /hosts/add then re-probes', async () => {
      const form = stale().querySelector('form[data-ra-cred-form="stale-host"]');
      const input = form.querySelector('input[name="credential"]');
      input.value = 'http://127.0.0.1:3080/?token=SECRET-TOKEN-VALUE';
      input.dispatch('input');
      form.dispatch('submit');
      await new Promise((r) => setTimeout(r, 40));
      const seen = endpoints(traffic);
      assert.ok(seen.includes('/hosts/add'), '/hosts/add called');
      const add = traffic.find((t) => t.url.endsWith('/hosts/add'));
      assert.deepEqual(add.body, { alias: 'stale-host', credential: 'http://127.0.0.1:3080/?token=SECRET-TOKEN-VALUE' });
      assert.ok(seen.filter((e) => e === '/hosts/probe').length >= 2, 're-probed after credential save');
    });
    await check('the pasted token is never rendered back into the DOM', () => {
      assert.equal(doc.body.textContent.includes('SECRET-TOKEN-VALUE'), false, 'raw token must never be displayed');
      assert.equal(doc.body.textContent.includes('token='), false, 'no URL echo in the panel');
    });
  }

  /* --- 4. failure handling ------------------------------------------- */
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const { ns } = await loadClient({ traffic, flags: { sessionsError: true }, document: doc });
    ns.apply({});
    await new Promise((r) => setTimeout(r, 20));
    const csj = () => doc.querySelector('section.ra-group[data-ra-host="csj-92"]');
    csj().querySelector('.ra-group-head').dispatch('click');
    await new Promise((r) => setTimeout(r, 30));
    await check('host error surfaces as an error box, not as success', () => {
      const box = csj().querySelector('.ra-group-error');
      assert.ok(box, 'error box rendered');
      assert.ok(box.textContent.includes('unreachable'), 'error kind shown');
      assert.equal(csj().querySelectorAll('.ra-session').length, 0, 'no phantom sessions');
    });
  }
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const { ns } = await loadClient({ traffic, flags: { failAll: true }, document: doc });
    ns.apply({});
    await new Promise((r) => setTimeout(r, 30));
    await check('HTTP 200 {ok:false} / transport failure is treated as failure', () => {
      const panel = doc.getElementById('dsh-remote-hosts-panel');
      assert.ok(panel, 'panel still mounted after failure');
      assert.ok(panel.querySelector('.ra-banner'), 'banner shown for the failed list');
      assert.equal(panel.textContent.includes('No SSH hosts found'), false, 'no false empty-success state');
    });
  }

  /* --- 5. management UI ---------------------------------------------- */
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const { ns } = await loadClient({ traffic, document: doc });
    ns.apply({});
    await new Promise((r) => setTimeout(r, 20));
    const panel = doc.getElementById('dsh-remote-hosts-panel');
    const manageBtn = panel.querySelectorAll('.ra-header .ra-btn')[1];
    if (!manageBtn) {
      console.log('DEBUG panel html:\n' + dump(panel));
      console.log('DEBUG header btns: ' + JSON.stringify(panel.querySelectorAll('.ra-btn').map((b) => b.className)));
    }
    manageBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 20));
    await check('management UI lists ssh-config hosts (masked only)', () => {
      const select = panel.querySelector('select.ra-select');
      assert.ok(select, 'host picker rendered');
      const options = select.querySelectorAll('option').map((o) => o.textContent);
      assert.ok(options.some((o) => o.startsWith('csj-92')), 'ssh-config host listed');
      assert.ok(options.some((o) => o.includes('TES…000')), 'masked credential shown');
      assert.equal(select.querySelectorAll('option').some((o) => o.textContent.includes('SECRET')), false);
    });
    await check('remove host calls /hosts/remove and drops the group', async () => {
      const csj = panel.querySelector('section.ra-group[data-ra-host="csj-92"]');
      const removeBtn = csj.querySelector('.ra-group-actions .ra-danger');
      removeBtn.dispatch('click');
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(traffic.some((t) => t.url.endsWith('/hosts/remove')), '/hosts/remove called');
      assert.equal(panel.querySelector('section.ra-group[data-ra-host="csj-92"]'), null, 'group gone');
    });
  }

  /* --- 6. served-artifact contract (the crash regression) -------------- */
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const { ns } = await loadClient({ traffic, document: doc });
    await check('artifact exports apply/default through the Lazy-CJS factory', () => {
      assert.equal(typeof ns.apply, 'function');
      assert.equal(ns.default, ns.apply, 'default export is the same apply');
    });
    await check('artifact carries no top-level import/export (raw ESM = SyntaxError in the page)', () => {
      const offenders = SOURCE.split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /^\s*(?:import|export)\b/.test(line));
      assert.deepEqual(offenders, [], `top-level module syntax found at ${JSON.stringify(offenders)}`);
      assert.match(SOURCE, /window\.__ModuleLoader__\.load\(\{/, 'must register with the boot loader');
      assert.match(SOURCE, /id: 'dsh-remote-hosts'/, 'registration id must be the package name');
    });
    await check('combo concatenation still parses (loader joins artifacts with ";")', () => {
      const sibling = 'window.__ModuleLoader__.load({ id: "sibling", factory: () => ({}) });';
      // buildComboScript does `${prepareSource(resource).source};\n` per artifact.
      assert.doesNotThrow(() => new vm.Script(`${SOURCE};\n${sibling};\n`, { filename: 'combo.js' }));
    });
  }

  /* --- 7a. panel placement in the shell's sidebar region --------------- */
  {
    // 1. Happy path: the anchor's parent is a flex column.
    {
      const traffic = makeTraffic();
      const doc = createDocument();
      const { region, anchor, tail } = mountSidebarDom(doc, { tail: true });
      const { ns } = await loadClient({ traffic, document: doc, style: { flexDirection: 'column' } });
      await check('placement: panel lands after [data-slot="sidebar.workspaces"] inside the column', () => {
        const handle = ns.apply({});
        assert.equal(handle.mounted, true, 'apply still mounts');
        const panel = doc.getElementById('dsh-remote-hosts-panel');
        assert.ok(panel, 'panel exists');
        assert.equal(panel.parentElement, region, 'panel is a direct child of the region');
        assert.equal(panel.previousElementSibling, anchor, 'panel sits immediately after the anchor');
        assert.equal(anchor.nextElementSibling, panel, 'anchor now points at the panel');
        assert.equal(panel.nextElementSibling, tail, 'the panel precedes the region tail');
        assert.deepEqual(region.children, [anchor, panel, tail], 'region order is anchor, panel, tail');
        assert.equal(panel.dataset.raPlacement, 'sidebar', 'placement recorded in the dataset');
        assert.notEqual(panel.parentNode, doc.body, 'panel is no longer a direct body child');
        assert.equal(doc.body.children.includes(panel), false, 'not among body.children');
        assert.equal(region.children.length, 3, 'region holds the anchor, the panel and the tail');
      });
    }

    // 2. Guard: the same DOM, but the region is not a flex column. The region
    //    omits `data-slot="sidebar"` so the column-fallback anchor cannot catch
    //    the panel and flexDirection is the only variable left.
    {
      const traffic = makeTraffic();
      const doc = createDocument();
      mountSidebarDom(doc, { regionSlot: null });
      const { ns } = await loadClient({ traffic, document: doc, style: { flexDirection: 'row' } });
      await check('placement guard: a non-column region is refused (body + overlay, still visible)', () => {
        const handle = ns.apply({});
        assert.equal(handle.mounted, true, 'apply still mounts');
        const panel = doc.getElementById('dsh-remote-hosts-panel');
        assert.equal(panel.parentNode, doc.body, 'panel stays a direct body child');
        assert.equal(panel.dataset.raPlacement, 'overlay', 'overlay placement recorded');
        assert.equal(doc.body.children.includes(panel), true, 'panel reachable under the body');
        assert.equal(panel.hidden, false, 'panel stays visible');
        assert.ok(panel.querySelector('.ra-shell'), 'panel is really rendered');
      });

      // Same DOM and selectors, only flexDirection differs: proves the guard is
      // what flips the placement, not something else in the fixture.
      const doc2 = createDocument();
      mountSidebarDom(doc2, { regionSlot: null });
      const second = await loadClient({ traffic: makeTraffic(), document: doc2, style: { flexDirection: 'column' } });
      await check('placement guard is the cause: column flips the same DOM to sidebar', () => {
        second.ns.apply({});
        const panel = doc2.getElementById('dsh-remote-hosts-panel');
        assert.equal(panel.dataset.raPlacement, 'sidebar', 'column region accepted');
        assert.notEqual(panel.parentNode, doc2.body, 'panel moved out of the body');
      });
    }

    // `[data-slot="sidebar"]` is the *fallback* anchor and placePanel() now
    // applies the very same flex-column guard to the anchor node itself. In the
    // real shell that node lives in the frame's grid-item column, which is not a
    // flex column and clips its overflow — an unconditional append there yields
    // an invisible panel, which is worse than the honest overlay. So with
    // flexDirection 'row' the fallback is refused too.
    {
      const traffic = makeTraffic();
      const doc = createDocument();
      const { region } = mountSidebarDom(doc, { regionSlot: 'sidebar' });
      const { ns } = await loadClient({ traffic, document: doc, style: { flexDirection: 'row' } });
      await check('placement guard: row [data-slot="sidebar"] fallback is refused too (body + overlay, visible)', () => {
        ns.apply({});
        const panel = doc.getElementById('dsh-remote-hosts-panel');
        assert.equal(panel.parentNode, doc.body, 'panel stays a direct body child');
        assert.equal(panel.dataset.raPlacement, 'overlay', 'overlay placement recorded');
        assert.equal(panel.parentElement === region, false, 'never appended into the row region');
        assert.equal(region.children.includes(panel), false, 'not a child of the row region');
        assert.equal(doc.body.children.includes(panel), true, 'still reachable under the body');
        assert.equal(panel.hidden, false, 'panel stays visible');
        assert.ok(panel.querySelector('.ra-shell'), 'panel is really rendered');
      });
    }

    // Positive control for the fallback: NO `sidebar.workspaces` outlet exists,
    // but the region's own `[data-slot="sidebar"]` outlet is a flex column, so
    // the panel is appended into it. Pins the guarded fallback against being
    // tightened into a dead path ("no overlay" is not the same as "sidebar").
    {
      const traffic = makeTraffic();
      const doc = createDocument();
      // The sandbox's getComputedStyle answers with the fixture's flexDirection
      // for whatever node is asked, so `isSidebarRegion(fallback)` holds here.
      const region = doc.createElement('div');
      region.className = 'shell-region';
      region.setAttribute('data-slot', 'sidebar');
      const head = doc.createElement('div');
      head.className = 'shell-region-head';
      region.appendChild(head);
      doc.body.appendChild(region);
      const { ns } = await loadClient({ traffic, document: doc, style: { flexDirection: 'column' } });
      await check('placement fallback: column [data-slot="sidebar"] without a workspaces outlet hosts the panel', () => {
        ns.apply({});
        const panel = doc.getElementById('dsh-remote-hosts-panel');
        assert.equal(doc.querySelectorAll('[data-slot="sidebar.workspaces"]').length, 0, 'fixture has no primary outlet');
        assert.equal(panel.parentElement, region, 'panel appended into the column outlet');
        assert.equal(region.children.includes(panel), true, 'panel is a child of that outlet');
        assert.equal(panel.dataset.raPlacement, 'sidebar', 'sidebar placement recorded');
        assert.notEqual(panel.parentNode, doc.body, 'panel is no longer a direct body child');
        assert.equal(doc.body.children.includes(panel), false, 'not among body.children');
        assert.equal(panel.previousElementSibling, head, 'appended after the existing outlet content');
        assert.ok(panel.querySelector('.ra-shell'), 'panel is really rendered');
      });
    }

    // 3. No anchor at all.
    {
      const traffic = makeTraffic();
      const doc = createDocument();
      const { ns } = await loadClient({ traffic, document: doc, style: { flexDirection: 'column' } });
      await check('placement fallback: no anchor -> direct body child marked overlay', () => {
        ns.apply({});
        const panel = doc.getElementById('dsh-remote-hosts-panel');
        assert.equal(panel.parentNode, doc.body, 'panel appended to the body');
        assert.equal(panel.dataset.raPlacement, 'overlay', 'overlay placement recorded');
        assert.ok(panel.querySelector('.ra-shell'), 'panel still rendered');
      });
    }
  }

  /* --- 7b. one-click open in the official Browser tab ------------------ */
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const right = makeRightService();
    const { ns } = await loadClient({ traffic, document: doc });
    const handle = ns.apply(openContext(right));
    await tick();
    assert.equal(handle.mounted, true, 'open fixture mounted');

    await check('open: POST /remote/open, one openTab(browser,{params:{url}}), one fullscreen', async () => {
      const btn = openButton(doc, 'csj-92');
      assert.ok(btn, 'group head exposes an open button');
      btn.dispatch('click');
      await tick(40);
      const opens = traffic.filter((t) => t.url.endsWith('/remote/open'));
      assert.equal(opens.length, 1, 'exactly one /remote/open request');
      assert.equal(opens[0].method, 'POST', 'POST method');
      assert.deepEqual(opens[0].body, { alias: 'csj-92' }, 'only the alias is sent');
      assert.equal(right.openTabCalls.length, 1, 'openTab called exactly once');
      const [kind, opts] = right.openTabCalls[0];
      assert.equal(kind, 'browser', 'official Browser tab type');
      assert.equal(opts.params.url, OPEN_URL, 'URL is exactly what the host half returned');
      assert.equal(right.fullscreenCalls.length, 1, 'fullscreen requested once');
      assert.equal(right.fullscreenCalls[0], right.target, 'argument came from commandTarget()');
      assert.equal(right.fullscreenCalls[0].host, 'dock', 'docked pane target');
      assert.equal(right.toggleExpandedCalls, 0, 'no restore when the panel stayed expanded');
      assert.equal(doc.body.textContent.includes('TOKEN-abc123'), false, 'the token must never be rendered');
      const banner = doc.getElementById('dsh-remote-hosts-panel').querySelector('.ra-banner');
      assert.ok(banner, 'opened note shown');
      assert.equal(banner.dataset.tone, 'ok', 'note, not an error');
    });
  }
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const right = makeRightService();
    const { ns } = await loadClient({ traffic, document: doc });
    ns.apply(openContext(right));
    await tick();
    await check('open: double click is deduped while in flight (one request, one tab)', async () => {
      const btn = openButton(doc, 'csj-92');
      btn.dispatch('click');
      btn.dispatch('click');
      await tick(40);
      assert.equal(traffic.filter((t) => t.url.endsWith('/remote/open')).length, 1, 'one request only');
      assert.equal(right.openTabCalls.length, 1, 'one tab only');
      assert.equal(doc.body.textContent.includes('TOKEN-abc123'), false, 'the token must never be rendered');
    });
  }

  /* --- 7c. degraded open: error in the panel, never a throw ------------ */
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const right = makeRightService();
    const { ns } = await loadClient({ traffic, document: doc });
    // The browser tab KIND is not registered in this profile.
    ns.apply(openContext(right, { browser: false }));
    await tick();
    await check('open degrade: Browser kind unregistered -> banner, openTab never called, no throw', async () => {
      assert.doesNotThrow(() => openButton(doc, 'csj-92').dispatch('click'), 'click must not throw');
      await tick(40);
      assert.equal(right.openTabCalls.length, 0, 'openTab never reached');
      assert.equal(right.fullscreenCalls.length, 0, 'fullscreen never requested');
      const banner = doc.getElementById('dsh-remote-hosts-panel').querySelector('.ra-banner');
      assert.ok(banner, 'error banner rendered inside the panel');
      assert.equal(banner.dataset.tone, 'bad', 'error tone');
      assert.ok(banner.textContent.includes('Browser tab is not installed'), 'reason shown: ' + banner.textContent);
      assert.equal(doc.body.textContent.includes('TOKEN-abc123'), false, 'the token must never be rendered');
    });
  }
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const { ns } = await loadClient({ traffic, document: doc });
    // No client services at all: `ctx.get()` yields undefined for everything.
    ns.apply({ get: () => undefined });
    await tick();
    await check('open degrade: no sidebarRight service -> banner, no throw', async () => {
      assert.doesNotThrow(() => openButton(doc, 'csj-92').dispatch('click'), 'click must not throw');
      await tick(40);
      const banner = doc.getElementById('dsh-remote-hosts-panel').querySelector('.ra-banner');
      assert.ok(banner, 'error banner rendered');
      assert.equal(banner.dataset.tone, 'bad', 'error tone');
      assert.ok(banner.textContent.includes('no right-hand panel'), 'reason shown: ' + banner.textContent);
      assert.equal(doc.body.textContent.includes('TOKEN-abc123'), false, 'the token must never be rendered');
    });
  }
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const right = makeRightService({ openTabThrows: true });
    const { ns } = await loadClient({ traffic, document: doc });
    ns.apply(openContext(right));
    await tick();
    await check('open degrade: no session surface on screen -> banner, no throw, no leak', async () => {
      assert.doesNotThrow(() => openButton(doc, 'csj-92').dispatch('click'), 'click must not throw');
      await tick(40);
      assert.equal(right.openTabCalls.length, 1, 'openTab was attempted once');
      assert.equal(right.fullscreenCalls.length, 0, 'fullscreen skipped after the failure');
      const banner = doc.getElementById('dsh-remote-hosts-panel').querySelector('.ra-banner');
      assert.ok(banner, 'error banner rendered');
      assert.equal(banner.dataset.tone, 'bad', 'error tone');
      assert.ok(banner.textContent.includes('no session surface is mounted'), 'reason shown: ' + banner.textContent);
      assert.equal(doc.body.textContent.includes('TOKEN-abc123'), false, 'the token must never be rendered');
    });
  }

  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const right = makeRightService();
    const { ns } = await loadClient({ traffic, document: doc, flags: { openFails: true } });
    // The host half cannot bring the tunnel up, so no URL ever arrives.
    ns.apply(openContext(right));
    await tick();
    await check('open degrade: /remote/open failure -> banner, no tab, no throw, no leak', async () => {
      assert.doesNotThrow(() => openButton(doc, 'csj-92').dispatch('click'), 'click must not throw');
      await tick(40);
      assert.equal(traffic.filter((t) => t.url.endsWith('/remote/open')).length, 1, 'the request was attempted');
      assert.equal(right.openTabCalls.length, 0, 'no tab opened without a URL');
      assert.equal(right.fullscreenCalls.length, 0, 'no fullscreen either');
      const banner = doc.getElementById('dsh-remote-hosts-panel').querySelector('.ra-banner');
      assert.ok(banner, 'error banner rendered');
      assert.equal(banner.dataset.tone, 'bad', 'error tone');
      assert.ok(banner.textContent.includes('ssh connect failed'), 'reason shown: ' + banner.textContent);
      assert.equal(doc.body.textContent.includes('TOKEN-abc123'), false, 'the token must never be rendered');
    });
  }

  /* --- 7d. fullscreen niceties ---------------------------------------- */
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const right = makeRightService();
    const { ns, sandbox } = await loadClient({ traffic, document: doc });
    sandbox.window.innerWidth = 500; // the seat auto-fullscreens on its own here
    ns.apply(openContext(right));
    await tick();
    await check('fullscreen: a narrow window keeps the tab open but does not toggle', async () => {
      openButton(doc, 'csj-92').dispatch('click');
      await tick(40);
      assert.equal(right.openTabCalls.length, 1, 'tab still opened');
      assert.equal(right.fullscreenCalls.length, 0, 'toggle suppressed below 768px');
      const banner = doc.getElementById('dsh-remote-hosts-panel').querySelector('.ra-banner');
      assert.equal(banner && banner.dataset.tone, 'ok', 'still reported as opened');
    });
  }
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const right = makeRightService({ expandedAfterToggle: false });
    const { ns } = await loadClient({ traffic, document: doc });
    ns.apply(openContext(right));
    await tick();
    await check('fullscreen: a collapsing toggle is reverted with toggleExpanded()', async () => {
      openButton(doc, 'csj-92').dispatch('click');
      await tick(40);
      assert.equal(right.fullscreenCalls.length, 1, 'toggle requested');
      assert.equal(right.toggleExpandedCalls, 1, 'panel restored once');
      assert.equal(right.openTabCalls.length, 1, 'tab stays open');
    });
  }

  /* --- 7e. placement observer: watchPlacement() coverage --------------- */
  {
    const traffic = makeTraffic();
    const doc = createDocument();
    const { region, anchor } = mountSidebarDom(doc, { tail: true });
    const { ns, sandbox, observers } = await loadClient({
      traffic, document: doc, style: { flexDirection: 'column' }
    });
    const handle = ns.apply({});
    const panelOf = () => doc.getElementById('dsh-remote-hosts-panel');

    await check('observer: exactly one childList watch, on the sidebar region, never subtree', () => {
      const calls = observers.observeCalls();
      assert.equal(calls.length, 1, 'one observe() call for the whole mount');
      const call = calls[0];
      assert.equal(call.target, region, 'the observed node is the region holding the anchor');
      // Cross-realm object: compare the keys rather than deepEqual's prototype check.
      assert.deepEqual(Object.keys(call.options), ['childList'], 'childList is the only option set');
      assert.equal(call.options.childList, true, 'childList watch');
      assert.notEqual(call.options.subtree, true, 'a subtree watch on a streaming conversation is forbidden');
      assert.equal(observers.instances.length, 1, 'exactly one observer constructed');
    });

    await check('observer: a re-rendered region re-attaches the panel after the anchor', () => {
      const panel = panelOf();
      assert.equal(panel.parentElement, region, 'precondition: panel placed inside the region');
      assert.equal(panel.previousElementSibling, anchor, 'precondition: right after the anchor');
      const observer = observers.latest();
      assert.ok(observer, 'the mount constructed an observer');
      region.removeChild(panel);
      assert.equal(panel.parentNode, null, 'simulated shell re-render detached the panel');
      assert.equal(panel.isConnected, false, 'detached panel is disconnected');
      observer.fire();
      assert.equal(observer.fireCount, 1, 'the callback ran exactly once');
      assert.equal(panel.parentElement, region, 'panel is back inside the region');
      assert.equal(panel.previousElementSibling, anchor, 'still immediately after the anchor');
      assert.equal(panel.dataset.raPlacement, 'sidebar', 'placement still recorded as sidebar');
      assert.equal(panel.isConnected, true, 'panel reachable from the document again');
      assert.equal(observers.observeCalls().length, 1, 're-attach reused the existing watch');
      assert.equal(observers.instances.length, 1, 'no second observer was constructed');
    });

    await check('observer: dispose() disconnects the watch and is idempotent', () => {
      const observer = observers.latest();
      const before = observer.disconnectCount;
      handle.dispose();
      assert.equal(observer.disconnectCount, before + 1, 'dispose() disconnected the observer once');
      assert.equal(panelOf(), null, 'panel removed from the document');
      assert.equal(typeof sandbox.__dshRemoteHosts.dispose, 'function', 'console handle exposes dispose()');
      assert.doesNotThrow(() => sandbox.__dshRemoteHosts.dispose(), 'a second dispose must not throw');
      assert.equal(observer.disconnectCount, before + 1, 'the second dispose had nothing left to disconnect');
    });
  }
  {
    // Guard path: a page that ships no MutationObserver at all must still mount
    // and place the panel (watchPlacement() returns before constructing one).
    const traffic = makeTraffic();
    const doc = createDocument();
    const { region } = mountSidebarDom(doc, {});
    const { ns, sandbox } = await loadClient({
      traffic, document: doc, style: { flexDirection: 'column' }, mutationObserver: false
    });
    await check('observer: a page without MutationObserver still mounts the placed panel', () => {
      assert.equal(sandbox.MutationObserver, undefined, 'fixture really removed MutationObserver');
      assert.doesNotThrow(() => ns.apply({}), 'missing MutationObserver must not throw');
      const panel = doc.getElementById('dsh-remote-hosts-panel');
      assert.equal(panel.parentElement, region, 'placement does not depend on the observer');
      assert.equal(panel.dataset.raPlacement, 'sidebar', 'still placed in the sidebar');
      assert.equal(panel.isConnected, true, 'panel connected');
    });
  }

  /* --- 8. presence regressions: one badge per head, real theme tokens --- */
  {
    /** The injected <style> element's text: the served CSS, verbatim. */
    const styleText = (doc) => {
      const node = doc.getElementById('dsh-remote-hosts-style');
      assert.ok(node, 'mount must inject the panel stylesheet');
      return node.textContent;
    };
    const headOf = (doc, alias) =>
      doc.querySelector(`section.ra-group[data-ra-host="${alias}"] .ra-group-head`);

    // 8.1 A collapsed host row is the alias + exactly ONE state badge + actions.
    //     ProxyJump / session count moved into the expanded body, so any chip
    //     reappearing here is the regression.
    {
      const traffic = makeTraffic();
      const doc = createDocument();
      const { ns } = await loadClient({ traffic, document: doc });
      ns.apply({});
      await tick(20);

      await check('header carries exactly one badge and no chips', () => {
        const heads = doc.querySelectorAll('.ra-group-head');
        assert.equal(heads.length, 3, 'three collapsed host headers rendered');
        assert.equal(doc.querySelectorAll('.ra-group-head .ra-badge').length, 3, 'one badge per header, three in total');
        for (const head of heads) {
          const alias = head.parentElement.getAttribute('data-ra-host');
          assert.equal(head.querySelectorAll('.ra-badge').length, 1, 'exactly one badge in ' + alias);
          assert.equal(head.querySelectorAll('.ra-chip').length, 0, 'no detail chip in ' + alias);
          assert.equal(head.querySelectorAll('.ra-chip-busy').length, 0, 'no busy chip in ' + alias);
        }
      });
    }

    // 8.2 Expanding a host forwards the detail to the head of the body.
    //     csj-92 carries `proxyJump: 'lab-j'`; IDLE_SESSIONS keeps the count
    //     chip at the plain "N sessions" label (no "(N running)" suffix).
    {
      const traffic = makeTraffic();
      const doc = createDocument();
      const { ns } = await loadClient({
        traffic, document: doc, flags: { sessions: { 'csj-92': IDLE_SESSIONS } }
      });
      ns.apply({});
      await tick(20);
      assert.ok(headOf(doc, 'csj-92'), 'csj-92 fixture host rendered');
      headOf(doc, 'csj-92').dispatch('click');
      await tick(40);

      await check('jump + session count lead the expanded body', () => {
        const body = doc.querySelector('section.ra-group[data-ra-host="csj-92"] .ra-group-body');
        assert.ok(body, 'expanded group has a body');
        const meta = body.firstElementChild;
        assert.ok(meta, 'body is not empty');
        assert.equal(meta.classList.contains('ra-group-meta'), true, 'first element child is .ra-group-meta');
        const texts = meta.querySelectorAll('.ra-chip').map((c) => c.textContent);
        const jump = meta.querySelectorAll('.ra-chip').find((c) => c.textContent.startsWith('jump:'));
        assert.ok(jump, 'jump chip leads the body: ' + JSON.stringify(texts));
        assert.equal(jump.textContent, 'jump:lab-j', 'ProxyJump target rendered');
        const count = meta.querySelectorAll('.ra-chip').find((c) => /\d+ sessions?/.test(c.textContent));
        assert.ok(count, 'session count chip present: ' + JSON.stringify(texts));
        assert.equal(count.textContent, '2 sessions', 'plain count label when nothing runs');
        // The same two chips must be gone from the (always visible) title row.
        const head = headOf(doc, 'csj-92');
        assert.equal(head.querySelectorAll('.ra-chip').length, 0, 'title row is chip-free');
        assert.equal(head.textContent.includes('jump:'), false, 'no jump chip in the title row');
        assert.equal(/\d+ sessions?/.test(head.textContent), false, 'no session-count chip in the title row');
        assert.equal(head.querySelectorAll('.ra-badge').length, 1, 'still exactly one badge when expanded');
      });
    }

    // 8.3 Loading used to add a separate `…` busy chip. It now folds into the
    //     one badge: data-kind="connecting", text "loading".
    {
      const traffic = makeTraffic();
      const doc = createDocument();
      const { ns } = await loadClient({ traffic, document: doc, flags: { probePending: true } });
      ns.apply({});
      await tick(20);
      headOf(doc, 'csj-92').dispatch('click');
      await tick(40);

      await check('the loading state folds into the single header badge', () => {
        assert.ok(endpoints(traffic).includes('/hosts/probe'), 'the probe really is in flight');
        const head = headOf(doc, 'csj-92');
        const badges = head.querySelectorAll('.ra-badge');
        assert.equal(badges.length, 1, 'exactly one badge while loading');
        assert.equal(badges[0].getAttribute('data-kind'), 'connecting', 'badge carries data-kind="connecting"');
        assert.equal(badges[0].textContent, 'loading', 'badge text is the loading label');
        assert.equal(head.querySelectorAll('.ra-chip').length, 0, 'no busy chip beside the badge');
        assert.equal(doc.querySelectorAll('.ra-chip-busy').length, 0, 'the dashed busy chip is gone');
        // The attribute (not just the dataset) has to be there for CSS to match.
        assert.equal(doc.querySelectorAll('.ra-badge[data-kind="connecting"]').length, 1,
          '.ra-badge[data-kind="connecting"] selects the badge');
      });
    }

    // 8.4/8.5 The served stylesheet itself: the colour root cause and the
    //        washed-out mini buttons.
    {
      const traffic = makeTraffic();
      const doc = createDocument();
      const { ns } = await loadClient({ traffic, document: doc });
      ns.apply({});
      await tick(20);
      const css = styleText(doc);

      await check('theme tokens are the real DSH aliases (pale-grey regression)', () => {
        const tokens = [
          '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
          '--dsw-alias-bg-layer-1', '--dsw-alias-interactive-bg-hover',
          '--dsw-alias-border-l2', '--dsw-alias-brand-primary',
          '--dsw-alias-state-error-primary', '--dsw-alias-state-warn-primary',
          '--dsw-alias-state-success-primary'
        ];
        for (const token of tokens) {
          assert.match(css, new RegExp('var\\(' + token), token + ' must be read through var()');
        }
        // The old guessed names resolved to nothing and every colour fell back
        // to the pale grey literal. Anchor on the var() call: a comment in
        // client.js still mentions the old names.
        assert.doesNotMatch(css, /var\(--dsh-color-/, 'the guessed --dsh-color-* tokens must be gone');
        // Declared ONCE, in the panel's base rule: everything inside inherits.
        assert.match(css, /#dsh-remote-hosts-panel\{--ra-fg:var\(--dsw-alias-label-primary/,
          'the base rule declares the theme tokens on the panel root');
        const declared = css.match(/--ra-[a-z-]+(?=\s*:)/g) || [];
        const counts = {};
        for (const name of declared) counts[name] = (counts[name] || 0) + 1;
        assert.deepEqual(Object.keys(counts).filter((n) => counts[n] !== 1), [],
          'every --ra-* token is declared exactly once (duplicates belong to inheritance)');
        assert.deepEqual(Object.keys(counts).sort(), [
          '--ra-accent', '--ra-bad', '--ra-bg', '--ra-bg-soft', '--ra-border',
          '--ra-fg', '--ra-fg-dim', '--ra-ok', '--ra-warn'
        ], 'exactly the nine theme tokens are declared');
      });

      await check('mini buttons are no longer dimmed', () => {
        const rule = /\.ra-btn-mini\{([^}]*)\}/.exec(css);
        assert.ok(rule, '.ra-btn-mini rule exists in the served CSS');
        assert.doesNotMatch(rule[1], /opacity/, 'opacity:.75 on .ra-btn-mini made the buttons look disabled');
        assert.match(rule[1], /font-size:10px/, 'the rule still styles the mini buttons');
        // Positive control: the generic disabled rule keeps its own dimming, so
        // this check cannot pass by banning `opacity` from the stylesheet.
        assert.match(css, /\.ra-btn:disabled\{opacity:/, 'disabled buttons are still dimmed');
      });
    }
  }

  /* ---------------------------------------------------------------- */
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log('  PASS  ' + r.name);
    } else {
      failed++;
      console.log('  FAIL  ' + r.name);
      console.log('        ' + (process.env.STACK === '1' && r.error && r.error.stack
        ? r.error.stack
        : (r.error && r.error.message ? r.error.message : String(r.error))));
    }
  }
  console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('harness crashed:', err);
  process.exitCode = 2;
});
