/**
 * dsh-remote-hosts - client (browser) half, as a built plugin bundle.
 *
 * Spec sources (frozen, do not deviate):
 *   - CONTRACT.md §1 endpoints, §2 data types, §3.1 lazy probing, §3.2 credentials, §3.3 security
 *   - DESIGN.md  §0/§5.3  one collapsible group per host, grouping by cwd
 *
 * Format: the DSH Web client does not load plugin sources. @deepseek-ai/dsh-client-modules
 * concatenates every package's `exports["./client"]` artifact into one classic
 * (non-module) combo script and executes it, so each artifact MUST be a Lazy-CJS
 * registration — `window.__ModuleLoader__.load({ id, factory })` — with no top-level
 * `import`/`export`. Raw ESM here fails the page with
 * `Uncaught SyntaxError: Unexpected token 'export'`, which dsh-desktop reports as
 * `web boot: 1 entry did not activate` and treats as fatal.
 *
 * The module body is dependency-free (plain DOM APIs + same-origin fetch) and
 * runs at materialization, not at script execution. The Cordis client loader
 * imports this package and calls the exported `apply(ctx)`.
 */

window.__ModuleLoader__.load({
	id: 'dsh-remote-hosts',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });


/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

var API_BASE = '/api/dshRemoteHosts';

var PANEL_DOM_ID = 'dsh-remote-hosts-panel';
var MOUNT_GUARD_KEY = '__dshRemoteHostsMounted';

/** Requirement: if the sidebar does not exist yet, retry a few times. */
var MOUNT_RETRY_MAX = 20; // ~10s total
var MOUNT_RETRY_DELAY_MS = 500;

var IDLE_REFRESH_MS = 30000;

/* ------------------------------------------------------------------ *
 * API layer — CONTRACT.md §1/§2. HTTP 200 + {ok:false,error} is a FAILURE.
 * ------------------------------------------------------------------ */

function ApiError(kind, message) {
  var err = new Error(typeof message === 'string' && message ? message : 'request failed');
  err.name = 'RemoteHostsApiError';
  err.kind = typeof kind === 'string' && kind ? kind : 'internal';
  return err;
}

/**
 * POST one endpoint. Always resolves to the parsed JSON body; throws ApiError
 * for transport/parse failures, non-2xx, `ok:false` payloads and missing bodies.
 */
function request(endpoint, body) {
  return fetch(API_BASE + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body === undefined || body === null ? {} : body)
  }).then(function (res) {
    if (!res.ok) {
      throw ApiError('transport', 'HTTP ' + res.status + ' from ' + endpoint);
    }
    return res.json().catch(function () {
      throw ApiError('transport', 'malformed JSON response from ' + endpoint);
    });
  }).then(function (payload) {
    if (!payload || typeof payload !== 'object') {
      throw ApiError('internal', 'empty response from ' + endpoint);
    }
    if (payload.ok === false) {
      var detail = payload.error;
      var kind = detail && typeof detail.kind === 'string' ? detail.kind : 'internal';
      var message = detail && typeof detail.message === 'string' ? detail.message : 'request failed';
      throw ApiError(kind, message);
    }
    if (payload.ok !== true) {
      throw ApiError('internal', 'unexpected response shape from ' + endpoint);
    }
    return payload;
  });
}

var api = {
  /** §3.1: must not trigger SSH/network on the host half. */
  listHosts: function () {
    return request('/hosts/list', {});
  },
  addHost: function (alias, credential) {
    return request('/hosts/add', { alias: alias, credential: credential });
  },
  removeHost: function (alias) {
    return request('/hosts/remove', { alias: alias });
  },
  probe: function (alias) {
    var body = {};
    if (typeof alias === 'string' && alias) body.alias = alias;
    return request('/hosts/probe', body);
  },
  remoteSessions: function (alias) {
    return request('/remote/sessions', { alias: alias });
  },
  /**
   * Ensure the host's tunnel and return the loopback URL of its own `dsh web`
   * UI. The host half owns the URL shape (today it carries the launch token;
   * a later cookie-injecting proxy can change that without touching this file),
   * so the client only ever hands `payload.url` to the Browser tab.
   */
  openHost: function (alias) {
    return request('/remote/open', { alias: alias });
  }
};

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

var STATE_INITIAL = {
  listLoaded: false,
  listLoading: false,
  listError: null,
  sshConfigPath: '',
  hosts: [],      // HostView[] (from /hosts/list)
  byAlias: {},    // alias -> HostView (visible hosts)
  hidden: {},     // alias -> true — tombstoned by remove, masks a stale list echo
  collapsed: {},  // alias -> boolean (explicit user toggle)
  group: {},      // alias -> {phase,error,probe:HostView|null,sessions:[],loadedAt,loading}
  globalError: null,
  globalNote: null
};

var state = cloneInitial();
var subscribers = [];
var idleRefreshTimer = null;

function cloneInitial() {
  return {
    listLoaded: STATE_INITIAL.listLoaded,
    listLoading: STATE_INITIAL.listLoading,
    listError: STATE_INITIAL.listError,
    sshConfigPath: STATE_INITIAL.sshConfigPath,
    hosts: [],
    byAlias: {},
    hidden: {},
    collapsed: {},
    group: {},
    globalError: null,
    globalNote: null
  };
}

function subscribe(fn) {
  if (typeof fn !== 'function') return function () {};
  subscribers.push(fn);
  return function () {
    var i = subscribers.indexOf(fn);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

function notify() {
  for (var i = 0; i < subscribers.length; i++) {
    try {
      subscribers[i](state);
    } catch (err) {
      /* a broken subscriber must not break the panel */
    }
  }
}

function groupState(alias) {
  var g = state.byAlias && state.byAlias[alias];
  var prev = state.group[alias] || {};
  return {
    phase: prev.phase || (g && g.state === 'needs-credentials' ? 'needs-credentials' : 'idle'),
    error: prev.error || null,
    probe: prev.probe || null,
    sessions: prev.sessions || [],
    loadedAt: prev.loadedAt || 0,
    loading: prev.loading === true
  };
}

function setGroup(alias, patch) {
  var next = groupState(alias);
  for (var key in patch) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  state.group[alias] = next;
}

/** Merge fresh HostView[] into state without dropping fields the host omitted. */
function mergeHosts(hosts) {
  if (!Array.isArray(hosts)) return;
  var index = {};
  var i;
  for (i = 0; i < state.hosts.length; i++) index[state.hosts[i].alias] = state.hosts[i];
  for (i = 0; i < hosts.length; i++) {
    var fresh = hosts[i];
    if (!fresh || typeof fresh.alias !== 'string' || !fresh.alias) continue;
    var prev = index[fresh.alias] || {};
    var merged = {};
    var key;
    for (key in prev) {
      if (Object.prototype.hasOwnProperty.call(prev, key)) merged[key] = prev[key];
    }
    for (key in fresh) {
      if (Object.prototype.hasOwnProperty.call(fresh, key) && fresh[key] !== undefined) {
        merged[key] = fresh[key];
      }
    }
    index[fresh.alias] = merged;
  }
  var out = [];
  for (var alias in index) {
    if (Object.prototype.hasOwnProperty.call(index, alias)) {
      // Hidden hosts are tombstoned with enabled === false by the management UI.
      if (index[alias].enabled === false) continue;
      out.push(index[alias]);
    }
  }
  out.sort(function (a, b) {
    return String(a.alias).localeCompare(String(b.alias));
  });
  state.hosts = out;
  state.byAlias = index;
}

function visibleHosts() {
  var out = [];
  for (var i = 0; i < state.hosts.length; i++) {
    var view = state.hosts[i];
    if (view.enabled === false) continue;
    if (state.hidden && state.hidden[view.alias] === true) continue;
    out.push(view);
  }
  return out;
}

function hostView(alias) {
  var list = visibleHosts();
  for (var i = 0; i < list.length; i++) {
    if (list[i].alias === alias) return list[i];
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Formatting helpers (never render a raw token)
 * ------------------------------------------------------------------ */

function baseName(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '';
  var parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  for (var i = parts.length - 1; i >= 0; i--) {
    if (parts[i]) return parts[i];
  }
  return cwd;
}

function shortSessionId(sessionId) {
  var s = String(sessionId == null ? '' : sessionId);
  if (s.length <= 22) return s;
  return s.slice(0, 12) + '…' + s.slice(-6);
}

function relativeTime(ms) {
  var t = Number(ms);
  if (!isFinite(t) || t <= 0) return '';
  var delta = Date.now() - t;
  if (delta < 0) delta = 0;
  var min = Math.floor(delta / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  var hours = Math.floor(min / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  if (days < 30) return days + 'd ago';
  return new Date(t).toISOString().slice(0, 10);
}

function hostStateLabel(view) {
  if (!view) return 'unknown';
  if (view.enabled === false) return 'disabled';
  switch (view.state) {
    case 'ready': return 'ready';
    case 'connecting': return 'connecting…';
    case 'needs-credentials': return 'needs credentials';
    case 'unreachable': return 'unreachable';
    default: return 'idle';
  }
}

function countSessions(sessions) {
  var count = 0;
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i] && sessions[i].running === true) count++;
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

/** Only ever display the masked form the host half sends. */
function tokenText(view) {
  if (!view) return '';
  if (typeof view.tokenMasked === 'string' && view.tokenMasked) return view.tokenMasked;
  if (view.hasCredential === true) return 'saved';
  return 'none';
}

/**
 * Official slot outlet for the left column's workspace/session region.
 *
 * `dsh-client-ui-renderer`'s `SlotOutlet` renders every slot as
 * `<div data-slot="<slotKey>" style="display:contents">` — a pure addressable
 * anchor that stays out of layout. A sibling inserted right after this one is
 * therefore a flex item of the left column itself, which is exactly "the same
 * level as the workspace panel, below it", without touching shipped markup.
 */
var SIDEBAR_ANCHOR_SELECTOR = '[data-slot="sidebar.workspaces"]';
/** Fallback anchor: the left column's own outlet, if the region is ever renamed. */
var SIDEBAR_COLUMN_SELECTOR = '[data-slot="sidebar"]';

/** @type {MutationObserver|null} */
var placementObserver = null;
/** @type {Node|null} */
var placementParent = null;

function queryFirst(selector) {
  try { return document.querySelector(selector); } catch (err) { return null; }
}

/** Whether `node` is the shell's sidebar region area: a flex column. */
function isSidebarRegion(node) {
  try {
    var style = window.getComputedStyle(node);
    return !!style && style.flexDirection === 'column';
  } catch (err) {
    return false;
  }
}

/**
 * Put the panel in the left column directly BELOW the official workspace /
 * session region — local workspaces on top, remote hosts underneath — instead
 * of the fixed overlay.
 *
 * Insertion also MOVES an already-placed root, so calling this again is
 * idempotent and doubles as the re-attach after a shell re-render. Falls back to
 * the column itself and then to the overlay, so the panel stays reachable even
 * if a future shell renames its slots.
 *
 * @param {HTMLElement} root
 * @returns {'sidebar'|'overlay'} the placement actually achieved
 */
function placePanel(root) {
  if (typeof document === 'undefined' || !document.body) return 'overlay';

  var anchor = queryFirst(SIDEBAR_ANCHOR_SELECTOR);
  var region = anchor && anchor.parentNode;
  // The anchor's parent is the shell's region area: the flex COLUMN that already
  // stacks the workspace list (`flex:1`) over everything below it. Guarding on
  // that keeps a future shell change from silently clipping the panel.
  if (region && region.nodeType === 1 && isSidebarRegion(region)) {
    if (root.parentNode !== region || root.previousElementSibling !== anchor) {
      try { region.insertBefore(root, anchor.nextSibling); } catch (err) { /* keep the current parent */ }
    }
    if (root.parentNode === region) {
      root.dataset.raPlacement = 'sidebar';
      return 'sidebar';
    }
  }

  var fallback = queryFirst(SIDEBAR_COLUMN_SELECTOR);
  // Same guard as the primary anchor. `[data-slot="sidebar"]`'s parent is the
  // frame's grid-item column, not a flex column, and it clips its overflow — an
  // unconditional append there would produce an invisible panel, which is worse
  // than the honest overlay.
  if (fallback && fallback !== root && isSidebarRegion(fallback) && root.parentNode !== fallback) {
    try { fallback.appendChild(root); } catch (err) { /* fall through to the overlay */ }
  }
  if (fallback && isSidebarRegion(fallback) && root.parentNode === fallback) {
    root.dataset.raPlacement = 'sidebar';
    return 'sidebar';
  }

  if (root.parentNode !== document.body) {
    try { document.body.appendChild(root); } catch (err) { return 'overlay'; }
  }
  root.dataset.raPlacement = 'overlay';
  return 'overlay';
}

/**
 * Keep the panel placed while the shell re-renders the left column.
 *
 * Observes only the direct children of the node that currently holds the anchor
 * (the column, or `document.body` before the shell exists) — never the whole
 * subtree, because a streaming conversation mutates the DOM constantly and this
 * plugin must not add per-mutation work.
 *
 * @param {HTMLElement} root
 */
function watchPlacement(root) {
  if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return;
  var anchor = queryFirst(SIDEBAR_ANCHOR_SELECTOR);
  var parent = anchor && anchor.parentNode && anchor.parentNode.nodeType === 1 ? anchor.parentNode : document.body;
  if (!parent) return;
  if (placementObserver && placementParent === parent) return;
  if (placementObserver) placementObserver.disconnect();
  placementParent = parent;
  placementObserver = new MutationObserver(function () {
    if (typeof document === 'undefined' || !document.body) return;
    if (!root.isConnected) {
      try { document.body.appendChild(root); } catch (err) { /* ignore */ }
    }
    placePanel(root);
    // The column itself may have been replaced: re-point the observer.
    watchPlacement(root);
  });
  placementObserver.observe(parent, { childList: true });
}

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

/** CSS.escape when present; conservative fallback for attribute selectors. */
function cssEscape(value) {
  var text = String(value == null ? '' : value);
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
    try { return CSS.escape(text); } catch (err) { /* fall through */ }
  }
  return text.replace(/["\\\]\[\(\)\s]/g, '\\$&');
}

function Panel(root) {  this.root = root;
  this.shell = null;
  this.bodyEl = null;
  this.sections = {
    banner: null,
    manage: null,
    list: null,
    footer: null
  };
  this.forms = {};   // alias -> inline credential re-entry form
  this.drafts = {};  // alias -> in-progress credential URL (kept in memory only)
  this.manageOpen = false;
  this.hostOptions = null;
  this.hostOptionsError = null;
  this.lastToggleAt = {};
  this.actor = null; // {kind, value} describing the element that had focus
  this.checkboxFocus = false;
}

Panel.prototype.render = function () {
  var self = this;
  var wasOpen = this.manageOpen;

  this.captureFocus();
  clear(this.root);

  var shell = el('div', 'ra-shell');
  shell.setAttribute('data-ra-panel', 'dsh-remote-hosts');
  this.shell = shell;

  var header = el('div', 'ra-header');
  header.appendChild(el('span', 'ra-title', 'Remote hosts'));
  var refresh = el('button', 'ra-btn ra-btn-icon', '⟳');
  refresh.type = 'button';
  refresh.title = 'Refresh host list (/hosts/list — no SSH)';
  refresh.setAttribute('aria-label', 'Refresh host list');
  refresh.addEventListener('click', function () { self.refreshList(); });
  header.appendChild(refresh);
  var manage = el('button', 'ra-btn ra-btn-icon', '＋');
  manage.type = 'button';
  manage.title = 'Add / remove SSH hosts';
  manage.setAttribute('aria-label', 'Add or remove SSH hosts');
  manage.setAttribute('aria-pressed', this.manageOpen ? 'true' : 'false');
  if (this.manageOpen) manage.classList.add('ra-btn-active');
  manage.addEventListener('click', function () {
    self.manageOpen = !self.manageOpen;
    if (self.manageOpen) self.loadHostOptions();
    self.render();
  });
  header.appendChild(manage);
  var collapseAll = el('button', 'ra-btn ra-btn-icon', this.allCollapsed() ? '⊞' : '⊟');
  collapseAll.type = 'button';
  collapseAll.title = this.allCollapsed() ? 'Expand all groups' : 'Collapse all groups';
  collapseAll.setAttribute('aria-label', collapseAll.title);
  collapseAll.addEventListener('click', function () {
    var collapse = !self.allCollapsed();
    var hosts = visibleHosts();
    for (var i = 0; i < hosts.length; i++) state.collapsed[hosts[i].alias] = collapse;
    notify();
  });
  header.appendChild(collapseAll);
  shell.appendChild(header);

  var body = el('div', 'ra-body');
  this.bodyEl = body;
  shell.appendChild(body);

  this.sections.banner = el('div', 'ra-banner-slot');
  body.appendChild(this.sections.banner);

  if (this.manageOpen) {
    this.sections.manage = el('div', 'ra-manage');
    this.renderManage(this.sections.manage);
    body.appendChild(this.sections.manage);
  } else {
    this.sections.manage = null;
    this.hostOptions = this.hostOptions && wasOpen ? this.hostOptions : null;
  }

  var list = el('div', 'ra-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Remote hosts');
  this.sections.list = list;
  body.appendChild(list);

  var scroll = el('div', 'ra-scroll');
  list.appendChild(scroll);

  var hosts = visibleHosts();
  if (state.listLoading && !state.listLoaded) {
    scroll.appendChild(el('div', 'ra-hint', 'Loading hosts…'));
  } else if (!hosts.length) {
    scroll.appendChild(el('div', 'ra-hint', state.listLoaded
      ? 'No SSH hosts found. Use ＋ to add one.'
      : 'Host list not loaded yet.'));
  } else {
    for (var i = 0; i < hosts.length; i++) {
      scroll.appendChild(this.renderGroup(hosts[i]));
    }
  }

  var footer = el('div', 'ra-footer');
  this.sections.footer = footer;
  if (state.sshConfigPath) {
    footer.appendChild(el('div', 'ra-foot-note', 'ssh config: ' + state.sshConfigPath));
  }
  footer.appendChild(el('div', 'ra-foot-note', state.listLoaded
    ? 'Expanding a group probes that host (lazy).'
    : 'Idle — nothing probed.'));
  body.appendChild(footer);

  // Rebuilds replace every node, so restore focus to the equivalent element.
  this.restoreFocus();

  this.root.appendChild(shell);
  this.applyFormVisibility();
  return this;
};

/** Remember which interactive element owns focus, by role rather than node. */
Panel.prototype.captureFocus = function () {
  var node = document.activeElement;
  if (!node || !this.root.contains(node)) {
    this.actor = null;
    this.checkboxFocus = false;
    return;
  }
  if (node.tagName === 'INPUT' || node.tagName === 'SELECT') {
    var form = node.closest ? node.closest('[data-ra-cred-form]') : null;
    if (node.name === 'credential' || (form && node.tagName === 'INPUT')) {
      var owner = form ? form.getAttribute('data-ra-cred-form') : null;
      this.actor = { kind: node.tagName === 'SELECT' ? 'select' : 'credential', alias: owner };
      return;
    }
    this.actor = { kind: 'input' };
    return;
  }
  this.actor = null;
};

/** Re-focus the equivalent element after a rebuild. */
Panel.prototype.restoreFocus = function () {
  var actor = this.actor;
  if (!actor) return;
  var target = null;
  if (actor.kind === 'credential' && actor.alias) {
    var form = this.root.querySelector('form[data-ra-cred-form="' + cssEscape(actor.alias) + '"]');
    if (form) target = form.querySelector('input[name="credential"]');
  } else if (actor.kind === 'select') {
    target = this.root.querySelector('select.ra-select');
  } else if (actor.kind === 'input') {
    target = this.root.querySelector('input.ra-input');
  }
  if (!target || typeof target.focus !== 'function') return;
  try {
    target.focus();
    if (typeof target.setSelectionRange === 'function' && typeof target.value === 'string') {
      var end = target.value.length;
      target.setSelectionRange(end, end);
    }
  } catch (err) { /* focus is best effort */ }
};

Panel.prototype.allCollapsed = function () {
  var hosts = visibleHosts();
  if (!hosts.length) return false;
  for (var i = 0; i < hosts.length; i++) {
    // Undefined means "default", and the default is collapsed (DESIGN §5.3).
    if (state.collapsed[hosts[i].alias] === false) return false;
  }
  return true;
};

Panel.prototype.renderGroup = function (view) {
  var self = this;
  var alias = view.alias;
  var g = groupState(alias);
  // DESIGN §5.3 / CONTRACT §3.1: a host group starts COLLAPSED so nothing but
  // /hosts/list runs on load; only an expand may probe. `undefined` = default.
  var collapsed = state.collapsed[alias] !== false;

  var group = el('section', 'ra-group');
  group.setAttribute('data-ra-host', alias);
  group.dataset.collapsed = collapsed ? 'true' : 'false';

  var head = el('div', 'ra-group-head');
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  head.title = view.hostName ? alias + ' → ' + view.hostName : alias;

  var caret = el('span', 'ra-caret', collapsed ? '▸' : '▾');
  caret.setAttribute('aria-hidden', 'true');
  head.appendChild(caret);
  head.appendChild(el('span', 'ra-host-alias', alias));

  var badges = el('span', 'ra-badges');
  var effectiveState = g.error && g.error.kind === 'needs-credentials'
    ? 'needs-credentials'
    : (view.state || 'idle');
  // The host row carries exactly ONE badge: the glanceable state. ProxyJump and
  // the session count moved into the expanded body's first row (renderGroupMeta)
  // — they are detail, and three chips made the row unreadable at a glance.
  badges.appendChild(g.loading
    ? badge('connecting', 'loading')
    : badge(effectiveState, hostStateLabel({ state: effectiveState })));
  head.appendChild(badges);

  var actions = el('span', 'ra-group-actions');
  var remove = el('button', 'ra-btn ra-btn-icon ra-danger', '×');
  remove.type = 'button';
  remove.title = 'Remove ' + alias + ' from this panel';
  remove.setAttribute('aria-label', 'Remove ' + alias);
  remove.addEventListener('click', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    self.removeHost(alias);
  });
  actions.appendChild(remove);
  // One click: ensure the SSH tunnel and show this host's own DSH Web UI in the
  // official Browser tab. No hand-maintained `ssh -L` and no per-API wrapping —
  // the tab loads the remote app itself through the tunnel.
  var open = el('button', 'ra-btn ra-btn-mini', 'open');
  open.type = 'button';
  open.title = 'Open ' + alias + ' in a local Browser tab (starts the SSH tunnel)';
  open.setAttribute('aria-label', 'Open ' + alias + ' in a Browser tab');
  open.addEventListener('click', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    self.openRemoteWeb(alias);
  });
  actions.appendChild(open);
  var auth = el('button', 'ra-btn ra-btn-mini', 'credential');
  auth.type = 'button';
  auth.title = 'Set or replace the credential URL for ' + alias;
  auth.addEventListener('click', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    self.openCredentialForm(alias);
  });
  actions.appendChild(auth);
  head.appendChild(actions);

  function toggle() {
    self.toggleGroup(alias);
  }
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
      ev.preventDefault();
      toggle();
    }
  });
  group.appendChild(head);

  if (!collapsed) {
    var content = el('div', 'ra-group-body');
    this.renderGroupBody(content, view, g);
    group.appendChild(content);
  }
  return group;
};

/**
 * The first row of an expanded host: the detail that does not belong in the
 * always-visible header — the ProxyJump target and the session count.
 *
 * @param {object} view - the host view
 * @param {object} g - the group's runtime state
 * @returns {HTMLElement|null} the row, or null when there is nothing to show
 */
Panel.prototype.renderGroupMeta = function (view, g) {
  var row = el('div', 'ra-group-meta');
  if (view.proxyJump) {
    var jump = el('span', 'ra-chip', 'jump:' + view.proxyJump);
    jump.title = 'ProxyJump ' + view.proxyJump;
    row.appendChild(jump);
  }
  var count = typeof view.sessionCount === 'number'
    ? view.sessionCount
    : (g.sessions.length || 0);
  if (count > 0) {
    var countChip = el('span', 'ra-chip', String(count) + ' session' + (count === 1 ? '' : 's'));
    if (g.sessions.length) {
      var running = countSessions(g.sessions);
      if (running > 0) countChip.textContent = count + ' (' + running + ' running)';
    }
    row.appendChild(countChip);
  }
  return row.childNodes.length ? row : null;
};

Panel.prototype.renderGroupBody = function (container, view, g) {
  var self = this;
  var alias = view.alias;

  // Detail moved out of the header leads the expanded body.
  var meta = this.renderGroupMeta(view, g);
  if (meta) container.appendChild(meta);

  // --- credential re-entry (lazy validation requirement) ---
  var wanted = this._formWanted && this._formWanted[alias] === true;
  if (wanted || (g.error && g.error.kind === 'needs-credentials')) {
    container.appendChild(this.renderCredentialForm(alias, g));
  }

  if (g.error && g.error.kind !== 'needs-credentials') {
    var errBox = el('div', 'ra-group-error');
    errBox.appendChild(el('span', 'ra-error-kind', g.error.kind));
    errBox.appendChild(el('span', 'ra-error-msg', g.error.message));
    container.appendChild(errBox);
  }
  if (g.error && g.error.kind === 'needs-credentials') {
    container.appendChild(el('div', 'ra-hint', 'Credential expired or rejected — paste a new URL above.'));
  }

  var sessions = g.sessions || [];
  if (g.phase === 'loading') {
    container.appendChild(el('div', 'ra-hint', 'Probing ' + alias + '…'));
  }

  if (!sessions.length) {
    if (g.phase === 'ready') {
      var empty = el('div', 'ra-hint', 'No sessions reported.');
      if (g.loadedAt) empty.title = 'Loaded ' + new Date(g.loadedAt).toLocaleTimeString();
      container.appendChild(empty);
    } else if (g.phase !== 'loading' && !(g.error && g.error.kind === 'needs-credentials')) {
      // Never leave an expanded group blank: an empty body is indistinguishable
      // from a broken panel, so state the situation and offer a retry.
      container.appendChild(el('div', 'ra-hint', g.phase === 'error'
        ? 'The last load failed — retry:'
        : 'Not loaded yet — load this host:'));
      var retry = el('button', 'ra-btn ra-btn-mini', 'load');
      retry.type = 'button';
      retry.title = 'Probe ' + alias + ' and fetch its sessions';
      retry.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        self.loadHost(alias, true);
      });
      container.appendChild(retry);
    }
    return;
  }

  var workspaces = groupByCwd(sessions);
  for (var i = 0; i < workspaces.length; i++) {
    container.appendChild(this.renderWorkspace(alias, workspaces[i]));
  }
};

Panel.prototype.renderWorkspace = function (hostAlias, workspace) {
  var wrap = el('div', 'ra-ws');
  wrap.setAttribute('data-ra-cwd', workspace.cwd);

  var head = el('div', 'ra-ws-head');
  head.title = workspace.cwd;
  head.appendChild(el('span', 'ra-ws-name', workspace.name || workspace.cwd));
  var running = countSessions(workspace.sessions);
  var meta = workspace.sessions.length + ' session' + (workspace.sessions.length === 1 ? '' : 's');
  if (running > 0) meta += ' · ' + running + ' running';
  head.appendChild(el('span', 'ra-ws-meta', meta));
  wrap.appendChild(head);

  var list = el('div', 'ra-sessions');
  for (var i = 0; i < workspace.sessions.length; i++) {
    list.appendChild(this.renderSession(hostAlias, workspace.sessions[i]));
  }
  wrap.appendChild(list);
  return wrap;
};

Panel.prototype.renderSession = function (hostAlias, session) {
  var row = el('div', 'ra-session');
  row.setAttribute('data-ra-session', String(session.sessionId));
  row.setAttribute('data-ra-host', hostAlias);
  if (session.running === true) row.classList.add('ra-running');

  var dot = el('span', 'ra-dot');
  dot.setAttribute('aria-hidden', 'true');
  if (session.running === true) dot.classList.add('ra-dot-on');
  dot.title = session.running === true ? 'running' : 'idle';
  row.appendChild(dot);

  var main = el('div', 'ra-session-main');
  var title = typeof session.title === 'string' && session.title
    ? session.title
    : shortSessionId(session.sessionId);
  var titleNode = el('span', 'ra-session-title', title);
  titleNode.title = String(session.sessionId || '');
  main.appendChild(titleNode);

  var sub = el('div', 'ra-session-sub');
  sub.appendChild(el('span', 'ra-sid', shortSessionId(session.sessionId)));
  var when = relativeTime(session.updatedAt);
  if (when) sub.appendChild(el('span', 'ra-when', when));
  if (session.running === true) sub.appendChild(el('span', 'ra-running-tag', 'running'));
  main.appendChild(sub);

  row.appendChild(main);
  return row;
};

Panel.prototype.renderCredentialForm = function (alias, g) {
  var self = this;
  var form = el('form', 'ra-cred');
  form.setAttribute('data-ra-cred-form', alias);

  var label = el('label', 'ra-cred-label', 'Credential URL for ' + alias);
  form.appendChild(label);

  var input = el('input', 'ra-input');
  input.type = 'password';           // never render a token in clear text
  input.name = 'credential';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'http://127.0.0.1:3080/?token=…';
  input.setAttribute('aria-label', 'Credential URL for ' + alias);

  // A background refresh may re-render mid-typing; carry the draft over so a
  // paste is never silently lost, and never echo it anywhere else.
  var draft = this.drafts && this.drafts[alias];
  if (typeof draft === 'string' && draft) input.value = draft;

  form.appendChild(input);

  if (g && g.error && g.error.kind === 'needs-credentials') {
    form.appendChild(el('div', 'ra-cred-note', g.error.message));
  }

  var row = el('div', 'ra-cred-actions');
  var save = el('button', 'ra-btn ra-btn-primary', 'Save');
  save.type = 'submit';
  row.appendChild(save);
  var cancel = el('button', 'ra-btn', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', function () {
    self.closeCredentialForm(alias);
  });
  row.appendChild(cancel);
  form.appendChild(row);

  var status = el('div', 'ra-cred-status');
  form.appendChild(status);

  input.addEventListener('input', function () {
    self.drafts = self.drafts || {};
    self.drafts[alias] = input.value;
  });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var value = typeof input.value === 'string' ? input.value.trim() : '';
    if (!value) {
      status.textContent = 'Paste the full URL including ?token=…';
      status.dataset.tone = 'bad';
      return;
    }
    save.disabled = true;
    cancel.disabled = true;
    status.textContent = 'Saving…';
    delete status.dataset.tone;

    api.addHost(alias, value).then(function () {
      input.value = '';
      if (self.drafts) delete self.drafts[alias];
      self._formWanted = self._formWanted || {};
      self._formWanted[alias] = false;
      self.forms[alias] = false;
      // A host the user explicitly removed may be re-added from here.
      if (state.hidden) delete state.hidden[alias];
      // Token expiry path (CONTRACT §3.2): a fresh credential means the cached
      // cookie was dropped host-side, so re-probe now instead of showing stale
      // needs-credentials state.
      setGroup(alias, { phase: 'idle', error: null, sessions: [], loadedAt: 0 });
      return api.probe(alias);
    }).then(function (payload) {
      if (payload && Array.isArray(payload.hosts)) mergeHosts(payload.hosts);
      state.globalError = null;
      state.globalNote = 'Credential saved for ' + alias + '.';
      notify();
      return self.loadHost(alias, true);
    }).catch(function (err) {
      save.disabled = false;
      cancel.disabled = false;
      status.textContent = describeError(err);
      status.dataset.tone = 'bad';
    });
  });

  this.forms[alias] = form;

  // Focus the field the user came here to fill in.
  if (typeof setTimeout === 'function') {
    setTimeout(function () {
      if (form.isConnected) {
        try { input.focus(); } catch (err) { /* focus is best effort */ }
      }
    }, 0);
  }
  return form;
};

Panel.prototype.openCredentialForm = function (alias) {
  this._formWanted = this._formWanted || {};
  this._formWanted[alias] = true;
  state.collapsed[alias] = false;
  setGroup(alias, { phase: groupState(alias).phase });
  notify();
};

Panel.prototype.closeCredentialForm = function (alias) {
  this._formWanted = this._formWanted || {};
  this._formWanted[alias] = false;
  this.forms[alias] = false;
  notify();
};

/** Belt-and-braces: remove forms whose host no longer needs them. */
Panel.prototype.applyFormVisibility = function () {
  if (!this.shell) return;
  var forms = this.shell.querySelectorAll('form[data-ra-cred-form]');
  for (var i = 0; i < forms.length; i++) {
    var alias = forms[i].getAttribute('data-ra-cred-form');
    var wanted = this._formWanted && this._formWanted[alias] === true;
    var g = groupState(alias);
    var needed = wanted || (g.error && g.error.kind === 'needs-credentials');
    if (!needed) {
      if (forms[i].parentNode) forms[i].parentNode.removeChild(forms[i]);
      this.forms[alias] = false;
    }
  }
};

Panel.prototype.renderManage = function (container) {
  var self = this;

  container.appendChild(el('div', 'ra-manage-title', 'SSH config hosts'));

  var cfg = el('div', 'ra-manage-sub');
  var discovered = this.hostOptions;
  if (this.hostOptionsError) {
    cfg.textContent = 'Could not list hosts: ' + describeError(this.hostOptionsError);
    cfg.dataset.tone = 'bad';
  } else if (discovered) {
    cfg.textContent = discovered.length + ' host' + (discovered.length === 1 ? '' : 's')
      + (state.sshConfigPath ? ' in ' + state.sshConfigPath : '');
  } else {
    cfg.textContent = 'Loading…';
  }
  container.appendChild(cfg);

  var select = el('select', 'ra-select');
  select.setAttribute('aria-label', 'SSH host to configure');
  var known = {};
  if (discovered) {
    for (var i = 0; i < discovered.length; i++) {
      var alias = discovered[i].alias;
      known[alias] = true;
      var option = el('option', null, discovered[i].hasCredential
        ? alias + ' (credential saved' + (discovered[i].tokenMasked ? ' ' + discovered[i].tokenMasked : '') + ')'
        : alias);
      option.value = alias;
      select.appendChild(option);
    }
  }
  var hosts = visibleHosts();
  for (var j = 0; j < hosts.length; j++) {
    if (known[hosts[j].alias]) continue;
    known[hosts[j].alias] = true;
    var extra = el('option', null, hosts[j].alias + ' (configured)');
    extra.value = hosts[j].alias;
    select.appendChild(extra);
  }
  if (!select.firstChild) {
    var placeholder = el('option', null, 'No hosts available');
    placeholder.value = '';
    select.appendChild(placeholder);
  }
  container.appendChild(select);

  // A background refresh rebuilds this section; keep the picked host and any
  // half-pasted URL instead of resetting the form under the user.
  if (this.manageSelect) select.value = this.manageSelect;
  select.addEventListener('change', function () {
    self.manageSelect = select.value;
  });

  var input = el('input', 'ra-input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'http://127.0.0.1:3080/?token=…';
  input.setAttribute('aria-label', 'Credential URL');
  if (typeof this.manageDraft === 'string' && this.manageDraft) input.value = this.manageDraft;
  input.addEventListener('input', function () {
    self.manageDraft = input.value;
  });
  container.appendChild(input);

  var row = el('div', 'ra-cred-actions');
  var save = el('button', 'ra-btn ra-btn-primary', 'Save credential');
  save.type = 'button';
  var status = el('div', 'ra-cred-status');
  save.addEventListener('click', function () {
    var alias = select.value;
    var credential = typeof input.value === 'string' ? input.value.trim() : '';
    if (!alias) {
      status.textContent = 'Pick a host first.';
      status.dataset.tone = 'bad';
      return;
    }
    if (!credential) {
      status.textContent = 'Paste the full URL including ?token=…';
      status.dataset.tone = 'bad';
      return;
    }
    save.disabled = true;
    status.textContent = 'Saving ' + alias + '…';
    delete status.dataset.tone;
    api.addHost(alias, credential).then(function () {
      input.value = '';
      self.manageDraft = '';
      save.disabled = false;
      if (state.hidden) delete state.hidden[alias];
      state.globalError = null;
      state.globalNote = 'Credential saved for ' + alias + '.';
      self.hostOptions = null;
      return self.refreshList().then(function () {
        return api.probe(alias);
      }).then(function (payload) {
        if (payload && Array.isArray(payload.hosts)) mergeHosts(payload.hosts);
        status.textContent = 'Saved.';
        delete status.dataset.tone;
        notify();
      });
    }).catch(function (err) {
      save.disabled = false;
      status.textContent = describeError(err);
      status.dataset.tone = 'bad';
    });
  });
  row.appendChild(save);

  var reload = el('button', 'ra-btn', 'Reload list');
  reload.type = 'button';
  reload.addEventListener('click', function () {
    self.hostOptions = null;
    self.hostOptionsError = null;
    self.render();
    self.loadHostOptions();
  });
  row.appendChild(reload);
  container.appendChild(row);

  container.appendChild(status);

  if (hosts.length) {
    container.appendChild(el('div', 'ra-manage-title', 'Configured here'));
    var chips = el('div', 'ra-manage-chips');
    for (var k = 0; k < hosts.length; k++) {
      var chip = el('span', 'ra-chip ra-chip-manage');
      chip.appendChild(el('span', null, hosts[k].alias));
      var tok = el('span', 'ra-chip-mask', tokenText(hosts[k]));
      tok.title = 'masked credential id';
      chip.appendChild(tok);
      var drop = el('button', 'ra-btn ra-btn-icon ra-danger', '×');
      drop.type = 'button';
      drop.title = 'Remove ' + hosts[k].alias;
      drop.setAttribute('aria-label', 'Remove ' + hosts[k].alias);
      (function (alias) {
        drop.addEventListener('click', function () { self.removeHost(alias); });
      })(hosts[k].alias);
      chip.appendChild(drop);
      chips.appendChild(chip);
    }
    container.appendChild(chips);
  }

  container.appendChild(el('div', 'ra-manage-note',
    'Credential URLs stay on the host half. This panel only ever sees a masked id.'));
};

/* ------------------------------------------------------------------ *
 * Panel actions
 * ------------------------------------------------------------------ */

Panel.prototype.refreshList = function () {
  var self = this;
  state.listLoading = true;
  state.listError = null;
  notify();
  return api.listHosts().then(function (payload) {
    state.listLoaded = true;
    state.listLoading = false;
    state.sshConfigPath = typeof payload.sshConfigPath === 'string' ? payload.sshConfigPath : '';
    // Drop tombstones before merging a fresh authoritative list.
    var kept = {};
    for (var alias in state.byAlias) {
      if (Object.prototype.hasOwnProperty.call(state.byAlias, alias)) {
        kept[alias] = state.byAlias[alias];
      }
    }
    mergeHosts(payload.hosts || []);
    state.globalError = null;
    notify();
    return payload;
  }).catch(function (err) {
    state.listLoading = false;
    state.listError = describeError(err);
    if (!state.listLoaded) state.globalError = state.listError;
    notify();
    throw err;
  });
};

Panel.prototype.loadHostOptions = function () {
  var self = this;
  api.listHosts().then(function (payload) {
    self.hostOptions = Array.isArray(payload.hosts) ? payload.hosts : [];
    self.hostOptionsError = null;
    if (!state.sshConfigPath && typeof payload.sshConfigPath === 'string') {
      state.sshConfigPath = payload.sshConfigPath;
    }
    notify();
  }).catch(function (err) {
    self.hostOptions = null;
    self.hostOptionsError = err;
    notify();
  });
};

Panel.prototype.toggleGroup = function (alias) {
  var self = this;
  var now = Date.now();
  // Ignore duplicate events (click + keyboard on the same activation).
  if (this.lastToggleAt[alias] && now - this.lastToggleAt[alias] < 120) return;
  this.lastToggleAt[alias] = now;

  // Default is collapsed, so only an explicitly expanded group toggles closed.
  var collapsing = state.collapsed[alias] === false;
  state.collapsed[alias] = collapsing;
  if (!collapsing) {
    // Lazy: probing only ever happens on expand (CONTRACT §3.1).
    setGroup(alias, { phase: groupState(alias).phase });
  }
  notify();
  if (!collapsing) this.loadHost(alias, false);
};

/**
 * Open one host's own DSH Web UI in the local app.
 *
 * One POST is the whole contract: the host half ensures its SSH tunnel (the
 * same lazily created tunnel `/remote/sessions` already uses — no second `ssh`
 * process) and answers with the loopback URL to load. This half never inspects
 * or rewrites that URL, which is what keeps the remote UI working unmodified
 * and lets the host half swap in a cookie-injecting proxy later.
 *
 * @param {string} alias
 * @returns {Promise<string|null>} how it was revealed, or null on failure
 */
Panel.prototype.openRemoteWeb = function (alias) {
  var self = this;
  this.opening = this.opening || {};
  if (this.opening[alias] === true) return Promise.resolve(null);
  this.opening[alias] = true;
  // Immediate feedback: opening can involve an SSH handshake, and a click that
  // shows nothing for tens of seconds is indistinguishable from a dead button.
  state.globalError = null;
  state.globalNote = 'Opening ' + alias + '…';
  notify();

  return api.openHost(alias).then(function (payload) {
    var url = payload && typeof payload.url === 'string' ? payload.url : '';
    if (!url) throw ApiError('internal', 'host half returned no browser URL for ' + alias);
    var via = revealRemoteWeb(url, alias);
    state.globalError = null;
    state.globalNote = 'Opened ' + alias + ' in the Browser tab.';
    return via;
  }).catch(function (err) {
    state.globalNote = null;
    state.globalError = describeError(err);
    return null;
  }).then(function (via) {
    delete self.opening[alias];
    notify();
    return via;
  });
};

Panel.prototype.loadHost = function (alias, force) {
  var self = this;
  var g = groupState(alias);
  if (g.loading) return Promise.resolve(null);
  if (!force && g.phase === 'ready' && g.sessions.length) return Promise.resolve(null);
  if (!force && g.phase === 'needs-credentials') return Promise.resolve(null);

  setGroup(alias, { loading: true, phase: g.phase === 'idle' ? 'loading' : g.phase });
  notify();

  var view = hostView(alias);
  var needProbe = force || !view || view.state !== 'ready' || view.sessionCount === undefined;

  var probeStep = needProbe
    ? api.probe(alias).then(function (payload) {
      if (payload && Array.isArray(payload.hosts)) mergeHosts(payload.hosts);
      return null;
    })
    : Promise.resolve(null);

  return probeStep.then(function () {
    return api.remoteSessions(alias);
  }).then(function (payload) {
    var sessions = payload && Array.isArray(payload.sessions) ? payload.sessions : [];
    var groupError = payload && payload.error && typeof payload.error === 'object'
      ? { kind: String(payload.error.kind || 'internal'), message: String(payload.error.message || '') }
      : null;
    var view2 = hostView(alias);
    if (groupError && groupError.kind === 'needs-credentials') {
      setGroup(alias, {
        loading: false, phase: 'needs-credentials', error: groupError, sessions: [], loadedAt: Date.now()
      });
      self.openCredentialForm(alias);
      return null;
    }
    setGroup(alias, {
      loading: false,
      phase: groupError ? 'error' : 'ready',
      error: groupError,
      sessions: sessions,
      loadedAt: Date.now()
    });
    if (view2) {
      view2.sessionCount = sessions.length;
      if (!groupError) view2.state = 'ready';
    }
    state.globalError = null;
    notify();
    return sessions;
  }).catch(function (err) {
    var kind = err && err.kind ? String(err.kind) : 'internal';
    var message = describeError(err);
    setGroup(alias, {
      loading: false,
      phase: kind === 'needs-credentials' ? 'needs-credentials' : 'error',
      error: { kind: kind, message: message },
      sessions: []
    });
    var view3 = hostView(alias);
    if (view3) {
      view3.state = kind === 'needs-credentials' ? 'needs-credentials'
        : (kind === 'unreachable' ? 'unreachable' : view3.state);
      view3.error = message;
    }
    if (kind === 'needs-credentials') self.openCredentialForm(alias);
    notify();
    return null;
  });
};

Panel.prototype.removeHost = function (alias) {
  var self = this;
  api.removeHost(alias).then(function (payload) {
    // Tombstone: /hosts/list still lists every ssh-config host, so without this
    // the entry would reappear on the next refresh.
    state.hidden[alias] = true;
    var tombstone = state.byAlias[alias];
    if (tombstone) tombstone.enabled = false;
    state.hosts = visibleHosts();
    delete state.group[alias];
    delete state.collapsed[alias];
    if (self._formWanted) delete self._formWanted[alias];
    state.globalError = null;
    state.globalNote = payload && payload.removed === false
      ? alias + ' had no saved credential.'
      : alias + ' removed.';
    notify();
    return self.refreshList();
  }).catch(function (err) {
    state.globalError = describeError(err);
    notify();
  });
};

/* ------------------------------------------------------------------ *
 * Grouping (requirement: workspaces grouped by cwd)
 * ------------------------------------------------------------------ */

function groupByCwd(sessions) {
  var order = [];
  var map = {};
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i] || {};
    var cwd = typeof session.cwd === 'string' && session.cwd ? session.cwd : '(unknown cwd)';
    if (!map[cwd]) {
      map[cwd] = { cwd: cwd, name: baseName(cwd), sessions: [] };
      order.push(cwd);
    }
    map[cwd].sessions.push(session);
  }
  order.sort();
  var out = [];
  for (var j = 0; j < order.length; j++) {
    map[order[j]].sessions.sort(function (a, b) {
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    });
    out.push(map[order[j]]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Errors & presentation helpers
 * ------------------------------------------------------------------ */

function describeError(err) {
  if (!err) return 'unknown error';
  var kind = err.kind ? String(err.kind) : '';
  var message = typeof err.message === 'string' && err.message ? err.message : '';
  if (kind && message) return kind + ': ' + message;
  if (message) return message;
  if (kind) return kind;
  return String(err);
}

function badge(kind, text) {
  var node = el('span', 'ra-badge', text);
  node.dataset.kind = kind || 'idle';
  return node;
}

function renderBanner(slot) {
  clear(slot);
  var err = state.globalError;
  var note = state.globalNote;
  if (err) {
    var box = el('div', 'ra-banner');
    box.dataset.tone = 'bad';
    box.appendChild(el('span', null, err));
    var dismiss = el('button', 'ra-btn ra-btn-icon', '×');
    dismiss.type = 'button';
    dismiss.title = 'Dismiss';
    dismiss.addEventListener('click', function () {
      state.globalError = null;
      notify();
    });
    box.appendChild(dismiss);
    slot.appendChild(box);
    return;
  }
  if (note) {
    var ok = el('div', 'ra-banner');
    ok.dataset.tone = 'ok';
    ok.appendChild(el('span', null, note));
    var clearBtn = el('button', 'ra-btn ra-btn-icon', '×');
    clearBtn.type = 'button';
    clearBtn.title = 'Dismiss';
    clearBtn.addEventListener('click', function () {
      state.globalNote = null;
      notify();
    });
    ok.appendChild(clearBtn);
    slot.appendChild(ok);
  }
}

/* ------------------------------------------------------------------ *
 * Styles — unlayered (never wrapped in @layer) so no reset can win.
 * A "ra-" prefix keeps specificity collisions away from official CSS.
 * ------------------------------------------------------------------ */

var STYLE_ID = 'dsh-remote-hosts-style';
var STYLE_TEXT = [
  // Placement-independent theme tokens, read by both placements and inherited
  // by everything inside the root. These are the REAL DSH alias tokens (checked
  // against the live Theme catalog) — the earlier `--dsh-color-*` guesses never
  // resolved, so every colour fell back to a pale grey.
  '#dsh-remote-hosts-panel{--ra-fg:var(--dsw-alias-label-primary,#e6e6e6);',
  '--ra-fg-dim:var(--dsw-alias-label-secondary,#9aa0a6);',
  '--ra-bg:var(--dsw-alias-bg-layer-1,rgba(22,23,26,.97));',
  '--ra-bg-soft:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));',
  '--ra-border:var(--dsw-alias-border-l2,rgba(127,127,127,.40));',
  '--ra-accent:var(--dsw-alias-brand-primary,#4c8dff);',
  '--ra-bad:var(--dsw-alias-state-error-primary,#ff6b6b);',
  '--ra-warn:var(--dsw-alias-state-warn-primary,#e2b13c);',
  '--ra-ok:var(--dsw-alias-state-success-primary,#3fb950);}',
  // Fallback placement (no shell sidebar found): a non-blocking card over the
  // left rail so the official UI keeps its clicks.
  '#dsh-remote-hosts-panel[data-ra-placement="overlay"]{position:fixed;left:10px;top:76px;',
  'width:290px;max-height:min(62vh,540px);z-index:40;overflow:auto;border-radius:10px;',
  'border:1px solid var(--ra-border);background:var(--ra-bg);box-shadow:0 8px 28px rgba(0,0,0,.34);}',
  // Primary placement: the last flex child of the shell's sidebar region
  // (`[data-slot="sidebar.workspaces"]`'s parent), so the official
  // workspace/session list keeps its `flex:1` on top and remote hosts sit
  // directly below it at the same level. `flex:0 0 auto` plus a bounded
  // max-height are load-bearing — `flex:1`/`height:100%` would steal the
  // official list's height.
  '#dsh-remote-hosts-panel[data-ra-placement="sidebar"]{position:relative;left:auto;top:auto;z-index:auto;',
  'flex:0 0 auto;display:flex;flex-direction:column;min-height:0;max-height:min(45%,420px);',
  'width:auto;overflow:hidden;box-shadow:none;border:0;border-radius:0;background:transparent;',
  'margin-top:6px;padding-top:6px;border-top:.5px solid var(--ra-border);',
  'padding-right:var(--dsh-sidebar-inline-padding,12px);}',
  // Only the host list scrolls; the section itself never grows.
  '#dsh-remote-hosts-panel[data-ra-placement="sidebar"] .ra-shell{flex:1 1 auto;min-height:0;}',
  '#dsh-remote-hosts-panel[data-ra-placement="sidebar"] .ra-body{flex:1 1 auto;min-height:0;}',
  '#dsh-remote-hosts-panel[data-ra-placement="sidebar"] .ra-list{flex:1 1 auto;min-height:0;display:flex;',
  'flex-direction:column;}',
  '#dsh-remote-hosts-panel[data-ra-placement="sidebar"] .ra-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;',
  'padding-bottom:8px;}',
  // The framed shell hides its sidebar regions in the 56px rail; match that.
  '[data-sidebar-collapsed] #dsh-remote-hosts-panel[data-ra-placement="sidebar"]{display:none;}',
  '.ra-shell{box-sizing:border-box;color:var(--ra-fg);',
  'font:12px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
  'display:flex;flex-direction:column;gap:2px;min-height:0;}',
  '.ra-shell *,.ra-shell *::before,.ra-shell *::after{box-sizing:border-box;}',
  '.ra-header{display:flex;align-items:center;gap:4px;padding:6px 8px 4px;}',
  '.ra-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
  'font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ra-fg-dim);}',
  '.ra-body{display:flex;flex-direction:column;min-height:0;overflow:hidden;}',
  '.ra-scroll{display:flex;flex-direction:column;gap:2px;overflow-y:auto;min-height:0;}',
  '.ra-btn{appearance:none;border:1px solid var(--ra-border);background:transparent;color:var(--ra-fg);',
  'font:inherit;border-radius:6px;padding:3px 7px;cursor:pointer;line-height:1.2;}',
  '.ra-btn:hover{background:var(--ra-bg-soft);}',
  '.ra-btn:focus-visible{outline:2px solid var(--ra-accent);outline-offset:1px;}',
  '.ra-btn:disabled{opacity:.5;cursor:default;}',
  '.ra-btn-icon{padding:2px 6px;font-size:12px;}',
  '.ra-btn-mini{font-size:10px;padding:2px 5px;}',
  '.ra-btn-primary{border-color:var(--ra-accent);color:var(--ra-accent);}',
  '.ra-btn-active{border-color:var(--ra-accent);}',
  '.ra-danger:hover{color:var(--ra-bad);border-color:var(--ra-bad);}',
  '.ra-group{display:flex;flex-direction:column;border-radius:6px;}',
  '.ra-group-head{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:6px;cursor:pointer;}',
  '.ra-group-head:hover{background:var(--ra-bg-soft);}',
  '.ra-group-head:focus-visible{outline:2px solid var(--ra-accent);outline-offset:-2px;}',
  '.ra-caret{width:10px;flex:0 0 auto;color:var(--ra-fg-dim);}',
  '.ra-host-alias{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}',
  '.ra-badges{display:flex;align-items:center;gap:4px;flex:0 1 auto;min-width:0;overflow:hidden;}',
  '.ra-group-actions{display:flex;align-items:center;gap:2px;margin-left:auto;flex:0 0 auto;}',
  '.ra-chip{font-size:10px;padding:0 5px;border:1px solid var(--ra-border);border-radius:999px;',
  'color:var(--ra-fg-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:9em;}',
  '.ra-chip-busy{border-style:dashed;}',
  '.ra-chip-manage{display:inline-flex;align-items:center;gap:4px;max-width:none;padding:2px 4px 2px 7px;}',
  '.ra-chip-mask{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;opacity:.8;}',
  '.ra-badge{font-size:10px;padding:0 5px;border-radius:999px;border:1px solid var(--ra-border);',
  'color:var(--ra-fg-dim);white-space:nowrap;}',
  '.ra-badge[data-kind="ready"]{color:var(--ra-ok);border-color:var(--ra-ok);}',
  '.ra-badge[data-kind="needs-credentials"]{color:var(--ra-warn);border-color:var(--ra-warn);}',
  '.ra-badge[data-kind="unreachable"]{color:var(--ra-bad);border-color:var(--ra-bad);}',
  '.ra-badge[data-kind="connecting"]{color:var(--ra-accent);border-color:var(--ra-accent);}',
  '.ra-group-body{display:flex;flex-direction:column;gap:3px;padding:2px 4px 6px 18px;}',
  '.ra-group-meta{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:0 0 2px;}',
  '.ra-ws{display:flex;flex-direction:column;gap:1px;}',
  '.ra-ws-head{display:flex;align-items:baseline;gap:6px;padding:2px 4px;border-radius:4px;}',
  '.ra-ws-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}',
  '.ra-ws-meta{margin-left:auto;flex:0 0 auto;font-size:10px;color:var(--ra-fg-dim);}',
  '.ra-sessions{display:flex;flex-direction:column;gap:1px;padding-left:6px;',
  'border-left:1px solid var(--ra-border);margin-left:4px;}',
  '.ra-session{display:flex;align-items:flex-start;gap:6px;padding:3px 5px;border-radius:5px;}',
  '.ra-session:hover{background:var(--ra-bg-soft);}',
  '.ra-dot{width:6px;height:6px;border-radius:50%;margin-top:4px;flex:0 0 auto;',
  'background:var(--ra-border);}',
  '.ra-dot-on{background:var(--ra-ok);box-shadow:0 0 0 2px rgba(63,185,80,.18);}',
  '.ra-session-main{min-width:0;flex:1 1 auto;}',
  '.ra-session-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.ra-session-sub{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--ra-fg-dim);}',
  '.ra-sid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
  '.ra-running-tag{color:var(--ra-ok);}',
  '.ra-hint{padding:4px 8px;font-size:11px;color:var(--ra-fg-dim);}',
  '.ra-group-error{display:flex;flex-direction:column;gap:1px;padding:4px 6px;border-radius:5px;',
  'border:1px solid var(--ra-bad);background:rgba(255,107,107,.08);}',
  '.ra-error-kind{font-size:10px;color:var(--ra-bad);text-transform:uppercase;letter-spacing:.04em;}',
  '.ra-error-msg{font-size:11px;word-break:break-word;}',
  '.ra-cred{display:flex;flex-direction:column;gap:4px;padding:6px;margin:2px 0;border-radius:6px;',
  'border:1px solid var(--ra-warn);background:rgba(226,177,60,.08);}',
  '.ra-cred-label{font-size:10px;color:var(--ra-fg-dim);}',
  '.ra-cred-note{font-size:10px;color:var(--ra-warn);word-break:break-word;}',
  '.ra-cred-actions{display:flex;gap:4px;}',
  '.ra-cred-status{font-size:10px;color:var(--ra-fg-dim);word-break:break-word;}',
  '.ra-cred-status[data-tone="bad"]{color:var(--ra-bad);}',
  '.ra-input{width:100%;font:inherit;color:var(--ra-fg);background:rgba(0,0,0,.22);',
  'border:1px solid var(--ra-border);border-radius:5px;padding:3px 6px;}',
  '.ra-input:focus-visible{outline:2px solid var(--ra-accent);outline-offset:-1px;}',
  '.ra-select{width:100%;font:inherit;color:var(--ra-fg);background:rgba(0,0,0,.22);',
  'border:1px solid var(--ra-border);border-radius:5px;padding:3px 6px;}',
  '.ra-manage{display:flex;flex-direction:column;gap:5px;padding:6px;margin:0 4px 4px;',
  'border:1px solid var(--ra-border);border-radius:6px;background:var(--ra-bg);}',
  '.ra-manage-title{font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;',
  'color:var(--ra-fg-dim);}',
  '.ra-manage-sub,.ra-manage-note{font-size:10px;color:var(--ra-fg-dim);word-break:break-word;}',
  '.ra-manage-sub[data-tone="bad"]{color:var(--ra-bad);}',
  '.ra-manage-chips{display:flex;flex-wrap:wrap;gap:4px;}',
  '.ra-banner{display:flex;align-items:flex-start;gap:6px;margin:0 4px 4px;padding:5px 6px;',
  'border-radius:6px;border:1px solid var(--ra-border);background:var(--ra-bg-soft);font-size:11px;',
  'word-break:break-word;}',
  '.ra-banner[data-tone="bad"]{border-color:var(--ra-bad);color:var(--ra-bad);}',
  '.ra-banner[data-tone="ok"]{border-color:var(--ra-ok);}',
  '.ra-banner .ra-btn-icon{margin-left:auto;}',
  '.ra-footer{display:flex;flex-direction:column;gap:1px;padding:4px 8px 6px;margin-top:auto;}',
  '.ra-foot-note{font-size:10px;color:var(--ra-fg-dim);overflow:hidden;text-overflow:ellipsis;',
  'white-space:nowrap;}',
  '@media (prefers-reduced-motion:no-preference){.ra-group-body{transition:opacity .12s ease;}}'
].join('');

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  var style = document.createElement('style');
  style.id = STYLE_ID;
  style.setAttribute('data-ra-style', 'dsh-remote-hosts');
  style.textContent = STYLE_TEXT;
  (document.head || document.documentElement).appendChild(style);
}

/* ------------------------------------------------------------------ *
 * Mounting
 * ------------------------------------------------------------------ */

function makeRoot() {
  var root = document.createElement('div');
  root.id = PANEL_DOM_ID;
  root.className = 'ra-panel';
  root.setAttribute('data-ra-root', 'dsh-remote-hosts');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Remote hosts');
  // Placement happens in mount(), after the node is connected: placePanel()
  // MOVES an existing node, so it must run once the root has a parent.
  return root;
}

/**
 * Ask the DSH client widget runtime for the sidebar list slot. Every symbol is
 * touched defensively: `ctx` may be undefined (direct page execution) or a
 * Cordis context whose services differ between DSH versions.
 */
function trySlotMount(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  var candidates = [ctx.client, ctx.widgets, ctx.ui, ctx.web];
  for (var i = 0; i < candidates.length; i++) {
    var svc = candidates[i];
    if (!svc || typeof svc !== 'object') continue;
    try {
      if (typeof svc.registerSlot === 'function') {
        svc.registerSlot('sidebar.panellist', { render: renderInto });
        return 'registerSlot';
      }
      if (typeof svc.define === 'function') {
        var def = svc.define('sidebar.panellist');
        if (def && typeof def.register === 'function') {
          def.register({ render: renderInto });
          return 'define';
        }
        if (def && typeof def.render === 'function') {
          def.render(renderInto);
          return 'define-render';
        }
      }
      if (typeof svc.slot === 'function') {
        svc.slot('sidebar.panellist', { render: renderInto });
        return 'slot';
      }
    } catch (err) {
      /* try the next candidate service */
    }
  }
  return null;
}

function renderInto(target) {
  if (!target || typeof target.appendChild !== 'function') return null;
  ensureStyle();
  if (target.querySelector && target.querySelector('#' + PANEL_DOM_ID)) {
    return target.querySelector('#' + PANEL_DOM_ID);
  }
  var root = makeRoot();
  target.appendChild(root);
  mountPanel(root);
  return root;
}

function mountPanel(root) {
  var panel = new Panel(root);
  var retryTimer = null;

  function refresh() {
    try {
      // Order matters: render() rebuilds every node, so the banner must be
      // written into the slot that render() just attached to the DOM.
      panel.render();
      renderBanner(panel.sections.banner || el('div'));
    } catch (err) {
      state.globalError = describeError(err);
    }
  }

  panel._unsubscribe = subscribe(refresh);

  // Keep the panel in the left column while the shell re-renders it. One
  // observer on the current parent (plus a bounded retry for the window where
  // the shell has not painted its sidebar yet) — never a subtree watch.
  placePanel(root);
  watchPlacement(root);
  if (root.dataset && root.dataset.raPlacement !== 'sidebar') {
    var attempts = 0;
    retryTimer = setInterval(function () {
      attempts++;
      if (attempts > MOUNT_RETRY_MAX || !root.isConnected) {
        clearInterval(retryTimer);
        retryTimer = null;
        return;
      }
      // The shell may paint the sidebar late; re-place and start observing it.
      if (placePanel(root) === 'sidebar') {
        watchPlacement(root);
        clearInterval(retryTimer);
        retryTimer = null;
      }
    }, MOUNT_RETRY_DELAY_MS);
  }

  panel.render();

  root.__panel = panel;
  var handle = {
    root: root,
    panel: panel,
    refresh: function () { return panel.refreshList(); },
    dispose: function () {
      if (placementObserver) {
        placementObserver.disconnect();
        placementObserver = null;
        placementParent = null;
      }
      if (retryTimer) clearInterval(retryTimer);
      if (idleRefreshTimer) {
        clearInterval(idleRefreshTimer);
        idleRefreshTimer = null;
      }
      if (panel._unsubscribe) panel._unsubscribe();
      subscribers = [];
      clear(root);
      if (root.parentNode) root.parentNode.removeChild(root);
      if (window[MOUNT_GUARD_KEY] === handle) delete window[MOUNT_GUARD_KEY];
    }
  };
  return handle;
}

/**
 * Idempotent mount. Returns the existing handle when already mounted, so a
 * re-render of the SPA (or a second module evaluation) cannot double-mount.
 */
function mount() {
  if (typeof document === 'undefined') return null; // host-side / node --check safety

  var guard = window[MOUNT_GUARD_KEY];
  var existing = document.getElementById(PANEL_DOM_ID);

  if (existing && guard && guard.root === existing) return guard;

  if (existing) {
    // Node present but no handle (e.g. the SPA re-rendered and we lost state):
    // rebuild the handle on top of the surviving node.
    var reused = mountPanel(existing);
    if (existing.dataset) existing.dataset.raMount = 'reused';
    window[MOUNT_GUARD_KEY] = reused;
    return reused;
  }

  ensureStyle();
  var root = makeRoot();
  // Connect first: placePanel() MOVES an existing node, and the fallback keeps
  // the panel reachable even before the shell has painted its sidebar.
  try {
    document.body.appendChild(root);
  } catch (err) {
    return null;
  }
  placePanel(root);
  var handle2 = mountPanel(root);
  window[MOUNT_GUARD_KEY] = handle2;
  return handle2;
}

function startIdleRefresh() {
  if (idleRefreshTimer || typeof setInterval !== 'function') return;
  idleRefreshTimer = setInterval(function () {
    if (typeof document !== 'undefined' && document.hidden) return;
    var handle = typeof window !== 'undefined' ? window[MOUNT_GUARD_KEY] : null;
    if (!handle || typeof handle.refresh !== 'function') return;
    handle.refresh().catch(function () { /* reflected in state */ });
  }, IDLE_REFRESH_MS);
}

function currentPanel() {
  var root = typeof document !== 'undefined' ? document.getElementById(PANEL_DOM_ID) : null;
  if (root && root.__panel) return root.__panel;
  return null;
}

/* ------------------------------------------------------------------ *
 * Browser tab reveal
 * ------------------------------------------------------------------ */

/**
 * The Cordis client context the loader handed to `apply`, kept module-level so
 * a group's click handler can reach client services.
 */
var panelContext = null;

/**
 * Hand a remote-Web URL to the official Browser tab type
 * (`@deepseek-ai/dsh-client-ui-sidebar-browser`) through the `sidebarRight`
 * service — the same call the shipped chat plugin uses
 * (`ctx.sidebarRight.openTab('browser', { params: { url } })`).
 *
 * Resolution is deliberately opportunistic: `ctx.get()` yields undefined
 * instead of gating activation, so this plugin still boots in a profile without
 * the sidebar-right/browser plugins. Declaring them as a hard `inject` would
 * turn a missing service into a failed boot-audit entry — the exact failure
 * class this plugin was fixed for. `ctx.sidebarRightTabs.get('browser')` is
 * checked first because `openTab` throws for an unregistered kind.
 *
 * @param {string} url   - loopback URL owned by the host half (never parsed here)
 * @param {string} alias - host alias, for diagnostics only
 * @returns {string} how the URL was revealed
 * @throws {Error} when no Browser tab is reachable, or no session is on screen
 */
function revealRemoteWeb(url, alias) {
  var right = null;
  var tabs = null;
  try {
    if (panelContext && typeof panelContext.get === 'function') {
      right = panelContext.get('sidebarRight');
      tabs = panelContext.get('sidebarRightTabs');
    }
  } catch (err) {
    right = null;
    tabs = null;
  }
  if (!right || typeof right.openTab !== 'function') {
    throw ApiError('internal',
      'this profile has no right-hand panel, so ' + alias + ' cannot be shown here');
  }
  if (tabs && typeof tabs.get === 'function' && tabs.get('browser') === undefined) {
    throw ApiError('internal',
      'the official Browser tab is not installed in this profile, so ' + alias + ' cannot be shown here');
  }
  try {
    // `openTab` also expands the right panel, so one call covers both steps.
    right.openTab('browser', { params: { url: url } });
  } catch (err) {
    throw ApiError('internal',
      'cannot open a Browser tab yet (' + describeError(err) + ') — open a Session first');
  }
  ensureFullscreen(right);
  return 'browser-tab';
}

/**
 * Let the freshly opened Browser tab take the whole content area instead of
 * sharing it with the Conversation, through the same action as the panel's own
 * fullscreen button (`sidebarRight.toggleFullscreen`).
 *
 * That action is a plain toggle with two traps, so both are handled here:
 * it silently does nothing unless the panel is expanded and the target is a
 * docked pane, and on a narrow window the seat's `autoFullscreen` turns the
 * very same toggle into a collapse. Fullscreen is a nicety, never a
 * requirement: every failure path leaves the tab open.
 *
 * @param {object} right - the `sidebarRight` client service
 * @returns {boolean} whether fullscreen was requested
 */
function ensureFullscreen(right) {
  try {
    if (typeof right.toggleFullscreen !== 'function' || typeof right.mountedSurface !== 'function') return false;
    var surface = right.mountedSurface();
    if (!surface || !surface.layout) return false;
    if (surface.layout.mode === 'fullscreen') return true;
    if (typeof right.isExpanded === 'function' && right.isExpanded() !== true) return false;
    // The narrow-window seat auto-fullscreens by itself; leaving it alone is the
    // only way to avoid the collapse branch.
    if (typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth < 768) return false;
    var target = typeof right.commandTarget === 'function' ? right.commandTarget() : undefined;
    if (target === undefined || target.host !== 'dock') return false;
    right.toggleFullscreen(target);
    // Restore the panel if the toggle took the collapse branch after all.
    if (typeof right.isExpanded === 'function' && right.isExpanded() !== true
      && typeof right.toggleExpanded === 'function') {
      right.toggleExpanded();
    }
    return true;
  } catch (err) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

/**
 * One-call runtime state for the page console:
 * `JSON.stringify(window.__dshRemoteHosts.diagnose(), null, 1)`.
 *
 * This plugin cannot be inspected any other way (there is no DOM Inspect
 * provider), and "nothing appeared" is indistinguishable from "the panel is not
 * where you think it is", so every fact needed to tell those apart is reported
 * here. It never reads or returns a token: only aliases, phases and counts.
 *
 * @returns {object} a JSON-serializable snapshot
 */
function diagnose() {
  var root = typeof document !== 'undefined' ? document.getElementById(PANEL_DOM_ID) : null;
  var aliases = [];
  try { aliases = (visibleHosts() || []).map(function (view) { return view.alias; }); } catch (err) { aliases = []; }

  var groups = {};
  for (var i = 0; i < aliases.length; i++) {
    try {
      var g = groupState(aliases[i]);
      groups[aliases[i]] = {
        phase: g.phase,
        loading: g.loading === true,
        sessions: (g.sessions || []).length,
        error: g.error ? String(g.error.kind) + ': ' + String(g.error.message) : null
      };
    } catch (err) {
      groups[aliases[i]] = { phase: 'unknown' };
    }
  }

  var right = null;
  var tabs = null;
  try {
    if (panelContext && typeof panelContext.get === 'function') {
      right = panelContext.get('sidebarRight');
      tabs = panelContext.get('sidebarRightTabs');
    }
  } catch (err) { right = null; tabs = null; }

  var expanded = null;
  if (right && typeof right.isExpanded === 'function') {
    try { expanded = right.isExpanded() === true; } catch (err) { expanded = null; }
  }
  var mode = null;
  if (right && typeof right.mountedSurface === 'function') {
    try {
      var surface = right.mountedSurface();
      mode = surface && surface.layout ? surface.layout.mode : null;
    } catch (err) { mode = null; }
  }

  // Geometry + a hit test: a section that is painted but covered by an
  // official scroll container looks perfect in a screenshot yet swallows every
  // click, so report both the box and what actually sits under the pointer.
  var rect = null;
  var hitTop = null;
  var bodyHeight = null;
  if (root && typeof root.getBoundingClientRect === 'function') {
    try {
      var box = root.getBoundingClientRect();
      rect = {
        w: Math.round(box.width),
        h: Math.round(box.height),
        top: Math.round(box.top),
        left: Math.round(box.left)
      };
      var bodyEl = root.querySelector('.ra-body');
      if (bodyEl && typeof bodyEl.getBoundingClientRect === 'function') {
        bodyHeight = Math.round(bodyEl.getBoundingClientRect().height);
      }
      if (typeof document.elementFromPoint === 'function' && box.width > 0 && box.height > 0) {
        var probe = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(24, box.height / 2));
        if (probe) {
          var cls = typeof probe.className === 'string' ? probe.className.split(/\s+/).slice(0, 2).join('.') : '';
          hitTop = String(probe.nodeName) + (cls ? '.' + cls : '')
            + (root.contains(probe) ? ' (inside panel)' : ' (COVERS the panel)');
        } else {
          hitTop = 'nothing';
        }
      }
    } catch (err) { /* geometry is best effort */ }
  }

  return {
    mounted: !!root,
    placement: root && root.dataset ? root.dataset.raPlacement : 'none',
    parentTag: root && root.parentNode ? String(root.parentNode.nodeName) : null,
    parentClass: root && root.parentNode ? String(root.parentNode.className || '') : null,
    anchorFound: !!queryFirst(SIDEBAR_ANCHOR_SELECTOR),
    injectedStyle: !!(typeof document !== 'undefined' && document.getElementById(STYLE_ID)),
    rect: rect,
    bodyHeight: bodyHeight,
    hitTop: hitTop,
    hosts: aliases,
    groups: groups,
    listLoaded: state.listLoaded === true,
    listError: state.listError ? String(state.listError) : null,
    sidebarRight: !!(right && typeof right.openTab === 'function'),
    browserTabType: !!(tabs && typeof tabs.get === 'function' && tabs.get('browser') !== undefined),
    rightExpanded: expanded,
    rightMode: mode,
    note: state.globalNote ? String(state.globalNote) : null,
    error: state.globalError ? String(state.globalError) : null
  };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Cordis-style entry. The DSH client loader materializes this bundle and
 * calls `apply(ctx)`; `ctx` is optional so a manual
 * `window.__dshRemoteHosts` console boot also works.
 */
function apply(ctx) {
  if (typeof document === 'undefined') {
    return { mounted: false, reason: 'no-document' };
  }

  if (ctx && typeof ctx === 'object') panelContext = ctx;

  var slot = null;
  try {
    slot = trySlotMount(ctx);
  } catch (err) {
    slot = null;
  }

  // A second `apply` on the same page (a re-import or a manual console boot)
  // reuses the live panel — and must not re-issue the load-time /hosts/list.
  var existingPanel = currentPanel();
  var handle = mount();
  startIdleRefresh();

  var panel = currentPanel();
  if (panel && !existingPanel) panel.refreshList().catch(function () { /* reflected in state.listError */ });

  var result = {
    mounted: !!handle,
    slot: slot,
    refresh: function () { return handle ? handle.refresh() : Promise.resolve(null); },
    dispose: function () { if (handle) handle.dispose(); },
    state: state,
    api: api,
    diagnose: diagnose
  };

  // Debug / manual-recovery handle for the page console.
  try {
    window.__dshRemoteHosts = result;
  } catch (err) { /* frozen window — non-fatal */ }

  if (ctx && typeof ctx === 'object' && typeof ctx.effect === 'function' && handle) {
    try {
      ctx.effect(function () { return function () { handle.dispose(); }; },
        'remote-hosts: sidebar panel');
    } catch (err) { /* ctx.effect is opportunistic */ }
  }
  return result;
}

		exports.apply = apply;
		exports.default = apply;
		return module.exports;
	}
});
