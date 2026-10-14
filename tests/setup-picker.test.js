const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FIRST = 'f45bce28-cc93-4a13-ab73-faf97f598501';
const SECOND = 'f45bce28-cc93-4a13-ab73-faf97f598502';
const accounts = [
  { id: FIRST, username: '@Polymarket', platform: 'X', category: { id: 'sports', name: 'Sports' } },
  { id: SECOND, username: '@Polymarket', platform: 'Instagram', category: null },
];
const accountResponse = (data = accounts, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ data }) });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const clone = (value) => JSON.parse(JSON.stringify(value));

// Execute the shipped scripts; only browser DOM/storage/network boundaries are simulated.
function harness(script, { settings = {}, fetchImpl, response = { ok: true }, sendImpl, tabs = [{ id: 17 }], storageAccessError = false } = {}) {
  const nodes = [];
  const byId = new Map();
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.handlers = {}; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.textContent = ''; this.className = ''; this.attributes = {}; this.classList = { toggle() {} }; nodes.push(this); }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.children = children; }
    addEventListener(event, callback) { this.handlers[event] = callback; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    focus() { this.focused = true; }
    querySelectorAll(selector) { return this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]).filter((node) => selector === '*' || selector === node.tagName || selector === `input[type="${node.type}"]`); }
    querySelector(selector) { return selector === 'button[type="submit"]' ? document.getElementById('saveSettings') : this.querySelectorAll(selector)[0] || null; }
    async trigger(event) { return this.handlers[event]?.({ preventDefault() {}, isTrusted: true }); }
    async click() { if (!this.disabled) return this.trigger('click'); }
  }
  const document = {
    createElement: (tag) => new Element(tag),
    getElementById(id) { if (!byId.has(id)) { const element = new Element(); element.id = id; byId.set(id, element); } return byId.get(id); },
    querySelector: () => new Element('label'),
  };
  const store = clone(settings);
  const writes = [];
  const removals = [];
  const requests = [];
  const messages = [];
  const timers = new Map();
  let timerId = 0;
  let closed = false;
  const chrome = {
    storage: { local: {
      setAccessLevel: async () => { if (storageAccessError) throw new Error('Restriction unavailable'); },
      get: async (defaults) => ({ ...defaults, ...store }),
      set: async (values) => { writes.push(clone(values)); Object.assign(store, clone(values)); },
      remove: async (keys) => { removals.push(...keys); keys.forEach((key) => delete store[key]); },
    } },
    tabs: { query: async () => tabs },
    runtime: { openOptionsPage: async () => {}, sendMessage: async (message) => { messages.push(clone(message)); return sendImpl ? sendImpl(message) : response; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', script), 'utf8'), {
    document, chrome, URL, AbortController,
    window: { close() { closed = true; } },
    setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options) => { requests.push({ url, ...options }); return fetchImpl ? fetchImpl(url, options) : accountResponse(); },
  });
  return {
    document, nodes, store, writes, removals, requests, messages, timers,
    closed: () => closed,
    element: (id) => document.getElementById(id),
    input: async (value) => { const input = document.getElementById('apiKey'); input.value = value; await input.trigger('input'); },
    connect: () => document.getElementById('loadAccounts').click(),
    save: () => document.getElementById('settingsForm').trigger('submit'),
    choose: async (id) => { const input = nodes.findLast((node) => node.tagName === 'input' && node.value === id); assert.ok(input, 'account is offered for selection'); input.checked = true; await input.trigger('change'); },
    popupButtons: () => document.getElementById('accountButtons').children,
  };
}

const readySettings = { polyLinksApiKey: 'plk_saved_secret', polyLinksAccounts: accounts, defaultAccountId: FIRST, accountSelectionMode: 'default' };

test('saving validates the personal key and persists an authorized account, then removes legacy credentials', async () => {
  const h = harness('options.js', { settings: { sessionToken: 'legacy', sessionExpiresAt: 99999, accessToken: 'old', dubApiKey: 'dub_secret', dubTags: ['@Any'] } });
  await flush();
  await h.input('plk_new_secret');
  await h.connect();
  await h.choose(SECOND);
  h.element('askEachTime').checked = true;
  await h.save();
  assert.equal(h.store.polyLinksApiKey, 'plk_new_secret');
  assert.equal(h.store.defaultAccountId, SECOND);
  assert.equal(h.store.accountSelectionMode, 'ask');
  assert.equal(h.store.polyLinksAccounts.length, 2);
  assert.equal(h.requests.length, 2, 'save rechecks current grants after discovery');
  assert.ok(h.requests.every((request) => request.url === 'https://dub-links-nine.vercel.app/api/v1/accounts' && request.headers.authorization === 'Bearer plk_new_secret'));
  for (const key of ['sessionToken', 'sessionExpiresAt', 'accessToken', 'dubApiKey', 'dubTags']) assert.equal(h.store[key], undefined);
  assert.equal(h.element('apiKey').value, '');
  assert.match(h.element('formStatus').textContent, /ready|saved/i);
});

test('loading saved settings never places a stored personal key in the page and blank save revalidates it', async () => {
  const h = harness('options.js', { settings: readySettings });
  await flush();
  assert.equal(h.element('apiKey').value, '');
  assert.equal(h.nodes.some((node) => node.textContent.includes('plk_saved_secret')), false);
  await h.save();
  assert.equal(h.requests[0]?.headers.authorization, 'Bearer plk_saved_secret');
  assert.equal(h.store.defaultAccountId, FIRST);
  assert.equal(h.writes.length, 1);
});

for (const code of [401, 403]) {
  test(`a ${code} key validation failure preserves the prior setup and explains access recovery`, async () => {
    const h = harness('options.js', { settings: { ...readySettings, sessionToken: 'legacy' }, fetchImpl: async () => accountResponse([], code) });
    await flush();
    await h.input('plk_rejected');
    await h.save();
    assert.equal(h.writes.length, 0);
    assert.equal(h.removals.length, 0);
    assert.equal(h.store.polyLinksApiKey, 'plk_saved_secret');
    assert.match(h.element('formStatus').textContent, code === 401 ? /invalid|revoked|expired/i : /access|permission/i);
  });
}

test('an empty directory cannot replace a working setup with no authorized account', async () => {
  const h = harness('options.js', { settings: readySettings, fetchImpl: async () => accountResponse([]) });
  await flush();
  await h.save();
  assert.equal(h.writes.length, 0);
  assert.match(h.element('formStatus').textContent, /no.*accounts|accounts.*assigned/i);
});

test('a removed default account requires a new deliberate choice before saving', async () => {
  const h = harness('options.js', { settings: readySettings, fetchImpl: async () => accountResponse([accounts[1]]) });
  await flush();
  await h.save();
  assert.equal(h.writes.length, 0);
  assert.match(h.element('formStatus').textContent, /no longer|choose/i);
  await h.choose(SECOND);
  await h.save();
  assert.equal(h.store.defaultAccountId, SECOND);
});

test('replacing the key while discovery is pending cannot mix the previous directory into new settings', async () => {
  let release;
  const h = harness('options.js', { fetchImpl: () => new Promise((resolve) => { release = resolve; }) });
  await flush();
  await h.input('plk_first');
  const discovery = h.connect();
  await flush();
  await h.input('plk_second');
  assert.equal(typeof release, 'function', 'account discovery started');
  release(accountResponse());
  await discovery;
  assert.equal(h.element('accountList').children.some((row) => row.querySelectorAll('input').length), false);
  assert.equal(h.writes.length, 0);
  assert.equal(h.element('apiKey').value, 'plk_second');
});

test('editing the key during save discards the old validation result and retains legacy credentials', async () => {
  let release;
  const h = harness('options.js', { settings: { ...readySettings, sessionToken: 'legacy' }, fetchImpl: () => new Promise((resolve) => { release = resolve; }) });
  await flush();
  const saving = h.save();
  await flush();
  await h.input('plk_replacement');
  assert.equal(typeof release, 'function', 'account discovery started');
  release(accountResponse());
  await saving;
  assert.equal(h.writes.length, 0);
  assert.equal(h.store.sessionToken, 'legacy');
  assert.equal(h.element('apiKey').value, 'plk_replacement');
});

for (const badAccounts of [[{ ...accounts[0], id: 'arbitrary-tag' }], [accounts[0], accounts[0]], [{ ...accounts[0], username: null }], { accounts }]) {
  test('malformed account identity cannot enter saved settings', async () => {
    const h = harness('options.js', { settings: readySettings, fetchImpl: async () => accountResponse(badAccounts) });
    await flush();
    await h.save();
    assert.equal(h.writes.length, 0);
    assert.match(h.element('formStatus').textContent, /account|response/i);
  });
}

test('server account labels render as literal text and distinguish the same username across platforms', async () => {
  const unsafe = { ...accounts[0], username: '<img src=x onerror=alert(1)>', category: { id: 'test', name: '<script>bad</script>' } };
  const h = harness('options.js', { fetchImpl: async () => accountResponse([unsafe, accounts[1]]) });
  await flush();
  await h.input('plk_key');
  await h.connect();
  assert.ok(h.nodes.some((node) => node.textContent.includes(unsafe.username)));
  assert.ok(h.nodes.some((node) => node.textContent.includes('Instagram')));
  assert.equal(h.nodes.some((node) => Object.hasOwn(node, 'innerHTML')), false);
});

test('the account picker sends only a selected account ID and tab ID to the worker', async () => {
  const h = harness('popup.js', { settings: readySettings });
  await flush();
  assert.equal(h.popupButtons().length, 2);
  await h.popupButtons()[1].click();
  assert.deepEqual(h.messages, [{ type: 'POLY_DUB_CREATE_WITH_ACCOUNT', accountId: SECOND, tabId: 17 }]);
  assert.equal(h.nodes.some((node) => node.textContent.includes('plk_saved_secret')), false);
  assert.match(h.element('status').textContent, /copied/i);
});

for (const [response, expected] of [[{ ok: true, pending: true }, /confirm|DeFi-only/i], [{ ok: true, pending: true, inProgress: true }, /already|creating/i]]) {
  test('a pending account action stays open and never announces a copied link', async () => {
    const h = harness('popup.js', { settings: readySettings, response });
    await flush();
    assert.ok(h.popupButtons()[0], 'an account choice is shown');
    await h.popupButtons()[0].click();
    assert.match(h.element('status').textContent, expected);
    for (const timer of h.timers.values()) timer();
    assert.equal(h.closed(), false);
    assert.equal(h.popupButtons()[0].disabled, false);
  });
}

test('a disconnected worker re-enables the picker and reports a recoverable error', async () => {
  const h = harness('popup.js', { settings: readySettings, sendImpl: async () => { throw new Error('Extension context invalidated'); } });
  await flush();
  assert.ok(h.popupButtons()[0], 'an account choice is shown');
  await h.popupButtons()[0].click();
  assert.equal(h.popupButtons()[0].disabled, false);
  assert.match(h.element('status').textContent, /try|again|connect|unavailable|could not/i);
  assert.equal(h.closed(), false);
});

test('no account setup gives a clear setup action instead of a legacy tag picker', async () => {
  const h = harness('popup.js', { settings: { dubTags: ['@Old'] } });
  await flush();
  assert.equal(h.popupButtons().length, 0);
  assert.match(h.element('status').textContent, /settings|account|connect/i);
  assert.equal(h.messages.length, 0);
});

test('duplicate picker clicks cannot send overlapping create requests', async () => {
  let release;
  const h = harness('popup.js', { settings: readySettings, sendImpl: () => new Promise((resolve) => { release = resolve; }) });
  await flush();
  assert.equal(h.popupButtons().length, 2, 'both account choices are shown');
  const first = h.popupButtons()[0].click();
  const second = h.popupButtons()[1].click();
  await flush();
  assert.equal(h.messages.length, 1);
  release({ ok: true });
  await Promise.all([first, second]);
});


test('a failed storage access restriction never saves or transmits the personal key', async () => {
  const h = harness('options.js', { settings: readySettings, storageAccessError: true });
  await flush();
  await h.input('plk_new_secret');
  await h.save();
  assert.equal(h.requests.length, 0);
  assert.equal(h.writes.length, 0);
  assert.match(h.element('formStatus').textContent, /storage|protect|Chrome/i);
});
