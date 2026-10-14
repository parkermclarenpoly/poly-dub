const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const sourceUrl = 'https://polymarket.com/event/example?tid=7&via=old#selected';
const confirmResponse = { status: 409, ok: false, json: async () => ({ error: 'No verified US mapping is available.', requiresDefiConfirmation: true }) };
const successResponse = { status: 200, ok: true, json: async () => ({ shortLink: 'https://poly.market/verified', routingMode: 'regional' }) };
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function backgroundHarness({ url = sourceUrl, responses = [successResponse], fetchImpl, state = {}, tabId = 17 } = {}) {
  const listeners = {};
  const requests = [];
  const messages = [];
  const badges = [];
  const intervals = new Map();
  let intervalStarts = 0;
  let platformCalls = 0;
  const tab = state.tab ||= { id: tabId, url };
  const settings = state.settings ||= { defaultTag: '@Creator', dubTags: ['@Creator', '@Other'], sessionToken: 'session-a', sessionExpiresAt: Date.now() + 60_000 };
  const session = state.session ||= {};
  const sessionStorage = {
    get: async (keys) => keys == null ? JSON.parse(JSON.stringify(session)) : Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter((key) => key in session).map((key) => [key, JSON.parse(JSON.stringify(session[key]))])),
    set: async (values) => Object.assign(session, JSON.parse(JSON.stringify(values))),
    remove: async (keys) => (typeof keys === 'string' ? [keys] : keys).forEach((key) => delete session[key]),
  };
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const chrome = {
    action: { onClicked: event('action'), setBadgeBackgroundColor: async () => {}, setBadgeText: async ({ text }) => badges.push(text), setPopup: async () => {} },
    contextMenus: { onClicked: event('menu'), removeAll: async () => {}, create() {} },
    runtime: { getPlatformInfo: async () => { platformCalls += 1; return { os: 'mac' }; }, id: 'extension-id', onInstalled: event('install'), onStartup: event('startup'), onMessage: event('message'), openOptionsPage: async () => {} },
    scripting: { executeScript: async () => {} },
    storage: { session: sessionStorage, local: { get: async () => ({ ...settings }), set: async (values) => Object.assign(settings, values), remove: async (keys) => keys.forEach((key) => delete settings[key]) }, onChanged: event('storage') },
    tabs: {
      get: async (id) => { if (id !== tab.id) throw new Error('Unknown tab'); return { ...tab }; },
      onUpdated: event('updated'), onRemoved: event('removed'),
      sendMessage: async (_id, message) => { messages.push(message); return message.type === 'POLY_DUB_GET_PAGE' ? { ok: true, url: tab.url, title: 'Original title', description: 'Original description' } : { ok: true }; },
    },
  };
  vm.runInNewContext(read('background.js'), { chrome, crypto: { randomUUID }, URL, console: { error() {} }, setTimeout: () => 1, setInterval: (fn, ms) => { const id = ++intervalStarts; intervals.set(id, { fn, ms }); return id; }, clearInterval: (id) => intervals.delete(id), fetch: async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return fetchImpl ? fetchImpl(url, options) : responses.shift();
  } });
  const send = (message, sender = {}) => new Promise((resolve, reject) => {
    try { if (listeners.message(message, sender, resolve) !== true) resolve(undefined); } catch (error) { reject(error); }
  });
  return {
    state, tab, settings, requests, messages, badges, listeners, intervals,
    intervalStarts: () => intervalStarts,
    platformCalls: () => platformCalls,
    create: (tagName = '@Creator') => send({ type: 'POLY_DUB_CREATE_WITH_TAG', tabId: tab.id, tagName }),
    confirm: (requestId, sender = { id: 'extension-id', frameId: 0, tab: { id: tab.id, url: tab.url }, url: tab.url }) => send({ type: 'POLY_DUB_CONFIRM_DEFI_ONLY', requestId }, sender),
    pending: () => messages.findLast((message) => message.type === 'POLY_DUB_CONFIRM_DEFI_ONLY_REQUIRED'),
  };
}

for (const url of ['https://polymarket.us/event/us-market?market=7', 'https://www.polymarket.us/event/us-market', 'https://www.polymarket.com/event/global-market']) {
  test(`one click creates and copies a regional link from ${new URL(url).host}`, async () => {
    const h = backgroundHarness({ url });
    const response = await h.create();
    assert.equal(response?.ok, true);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].body.url, url);
    assert.equal(h.requests[0].body.allowDefiOnly, undefined);
    assert.equal(h.messages.at(-1).routingMode, 'regional');
  });
}

for (const url of ['https://fake.polymarket.com/event/x', 'https://polymarket.us.evil.test/event/x', 'https://user@polymarket.com/event/x', 'https://polymarket.com:8443/event/x', 'http://polymarket.com/event/x']) {
  test(`unsupported source cannot create a link: ${url}`, async () => {
    const h = backgroundHarness({ url });
    const result = await h.create();
    assert.equal(h.requests.length, 0);
    assert.equal(result?.ok, false);
  });
}

test('a mapping hold stays pending and never claims a link was copied', async () => {
  const h = backgroundHarness({ responses: [confirmResponse] });
  const result = await h.create('@Other');
  assert.equal(result?.ok, true);
  assert.equal(result.pending, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.messages.some((message) => message.type === 'POLY_DUB_COPY_LINK'), false);
  assert.equal(typeof h.pending()?.requestId, 'string');
  assert.ok(h.pending().requestId.length >= 32);
  assert.equal(h.pending().sourceUrl, sourceUrl);
  assert.equal(h.pending().tagName, '@Other');
});

test('explicit consent resubmits unchanged original source, tag and metadata once', async () => {
  const h = backgroundHarness({ responses: [confirmResponse, successResponse] });
  await h.create('@Other');
  const nonce = h.pending()?.requestId;
  assert.ok(nonce, 'a confirmation request is presented');
  const result = await h.confirm(nonce);
  assert.equal(result?.ok, true);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].body, { description: 'Original description', tagName: '@Other', title: 'Original title', url: sourceUrl, streamResponse: true, allowDefiOnly: true });
  assert.equal(h.requests[1].headers.authorization, 'Bearer session-a');
  assert.equal((await h.confirm(nonce))?.ok, false);
  assert.equal(h.requests.length, 2, 'consent cannot be replayed');
});

for (const invalidation of ['wrong nonce', 'wrong tab', 'subframe', 'navigation', 'session changed', 'tag removed', 'session expired']) {
  test(`consent fails closed after ${invalidation}`, async () => {
    const h = backgroundHarness({ responses: [confirmResponse, successResponse] });
    await h.create();
    let nonce = h.pending()?.requestId;
    assert.ok(nonce, 'a confirmation request is presented');
    let sender;
    if (invalidation === 'wrong nonce') nonce = randomUUID();
    if (invalidation === 'wrong tab') sender = { id: 'extension-id', frameId: 0, tab: { id: 99, url: sourceUrl }, url: sourceUrl };
    if (invalidation === 'subframe') sender = { id: 'extension-id', frameId: 1, tab: { id: 17, url: sourceUrl }, url: sourceUrl };
    if (invalidation === 'navigation') h.tab.url = 'https://polymarket.com/event/another';
    if (invalidation === 'session changed') h.settings.sessionToken = 'session-b';
    if (invalidation === 'tag removed') h.settings.dubTags = ['@Other'];
    if (invalidation === 'session expired') h.settings.sessionExpiresAt = 1;
    assert.equal((await h.confirm(nonce, sender))?.ok, false);
    assert.equal(h.requests.length, 1);
  });
}

test('navigation away and back invalidates pending consent', async () => {
  const h = backgroundHarness({ responses: [confirmResponse, successResponse] });
  await h.create();
  const nonce = h.pending()?.requestId;
  assert.ok(nonce);
  h.listeners.updated(17, { url: 'https://polymarket.com/event/other' });
  h.listeners.updated(17, { url: sourceUrl });
  assert.equal((await h.confirm(nonce))?.ok, false);
  assert.equal(h.requests.length, 1);
});

test('fresh toolbar or picker action discards previous consent and does not send allowDefiOnly', async () => {
  const h = backgroundHarness({ responses: [confirmResponse, confirmResponse] });
  await h.create();
  const firstNonce = h.pending()?.requestId;
  assert.ok(firstNonce);
  await h.create('@Other');
  assert.equal(h.requests[1].body.allowDefiOnly, undefined);
  assert.notEqual(h.pending().requestId, firstNonce);
  assert.equal((await h.confirm(firstNonce))?.ok, false);
  assert.equal(h.requests.length, 2);
});

test('simultaneous actions in one tab do not produce duplicate writes', async () => {
  let release;
  let calls = 0;
  const h = backgroundHarness({ fetchImpl: () => ++calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(successResponse) });
  const first = h.create();
  await flush();
  const second = await h.create();
  assert.equal(h.requests.length, 1);
  assert.equal(second?.pending, true);
  release(successResponse);
  assert.equal((await first)?.ok, true);
  assert.equal(h.requests.length, 1);
});

test('an ambiguous server write failure is never retried automatically', async () => {
  const h = backgroundHarness({ fetchImpl: async () => { throw new Error('Connection dropped'); } });
  assert.equal((await h.create())?.ok, false);
  assert.equal(h.requests.length, 1);
});

// Minimal DOM boundary: all message and click behavior runs in the actual content/popup scripts.
function documentHarness() {
  const nodes = [];
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.handlers = {}; this.disabled = false; this.textContent = ''; nodes.push(this); }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); return child; }
    remove() { this.removed = true; }
    addEventListener(event, fn) { this.handlers[event] = fn; }
    attachShadow() { this.shadow = new Element('shadow'); return this.shadow; }
    querySelectorAll(tag) { return this.children.filter((child) => child.tagName === tag); }
    async click(trusted = true) { return this.handlers.click?.({ isTrusted: trusted, preventDefault() {}, stopPropagation() {} }); }
  }
  const document = { createElement: (tag) => new Element(tag), getElementById: (id) => nodes.find((node) => node.id === id && !node.removed), querySelector: () => null, title: 'Example', execCommand: () => true };
  document.documentElement = new Element('html');
  document.body = new Element('body');
  return { document, nodes, Element };
}

function contentHarness() {
  const dom = documentHarness();
  const sent = [];
  const copied = [];
  let handler;
  const location = { href: sourceUrl };
  const chrome = { runtime: { onMessage: { addListener(fn) { handler = fn; } }, sendMessage: async (message) => { sent.push(message); return { ok: true }; } } };
  vm.runInNewContext(read('content-script.js'), { ...dom, chrome, location, window: {}, URL, navigator: { clipboard: { writeText: async (text) => copied.push(text) } }, setTimeout: () => 1 });
  const send = (message) => new Promise((resolve) => { if (handler(message, {}, resolve) !== true) resolve(undefined); });
  return { ...dom, sent, copied, location, send, confirmationButton: () => dom.nodes.findLast((node) => node.tagName === 'button' && /DeFi-only/.test(node.textContent)) };
}

test('content captures the complete current URL without dropping selectors or referral identity', async () => {
  const h = contentHarness();
  assert.equal((await h.send({ type: 'POLY_DUB_GET_PAGE' })).url, sourceUrl);
});

test('only a trusted explicit confirmation button click sends background consent', async () => {
  const h = contentHarness();
  await h.send({ type: 'POLY_DUB_CONFIRM_DEFI_ONLY_REQUIRED', requestId: 'opaque-nonce', sourceUrl, tagName: '@Creator', message: 'No verified US mapping.' });
  const button = h.confirmationButton();
  assert.ok(button, 'an explicit DeFi-only button is shown');
  await button.click(false);
  assert.equal(h.sent.length, 0);
  await button.click(true);
  await button.click(true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, 'POLY_DUB_CONFIRM_DEFI_ONLY');
  assert.equal(h.sent[0].requestId, 'opaque-nonce');
});

test('content rejects a trusted confirmation click after client-side navigation', async () => {
  const h = contentHarness();
  await h.send({ type: 'POLY_DUB_CONFIRM_DEFI_ONLY_REQUIRED', requestId: 'opaque-nonce', sourceUrl, tagName: '@Creator' });
  const button = h.confirmationButton();
  assert.ok(button);
  h.location.href = 'https://polymarket.com/event/new';
  await button.click(true);
  assert.equal(h.sent.length, 0);
});

for (const [routingMode, expected] of [['regional', /regional/i], ['defi_only', /DeFi.only/i]]) {
  test(`copy success explains ${routingMode} routing`, async () => {
    const h = contentHarness();
    await h.send({ type: 'POLY_DUB_COPY_LINK', shortLink: 'https://poly.market/x', tagName: '@Creator', routingMode });
    assert.deepEqual(h.copied, ['https://poly.market/x']);
    assert.match(h.document.getElementById('poly-dub-toast').textContent, expected);
  });
}

test('the tag picker reports pending confirmation without claiming copied or closing', async () => {
  const dom = documentHarness();
  for (const id of ['tagButtons', 'status', 'openSettings']) { const node = dom.document.createElement('div'); node.id = id; }
  let closed = false;
  const timers = [];
  const chrome = { storage: { local: { get: async () => ({ defaultTag: '@Creator', dubTags: ['@Creator'] }) } }, tabs: { query: async () => [{ id: 17 }] }, runtime: { openOptionsPage() {}, sendMessage: async () => ({ ok: true, pending: true }) } };
  vm.runInNewContext(read('popup.js'), { ...dom, chrome, window: { close() { closed = true; } }, setTimeout: (fn) => timers.push(fn) });
  await flush();
  await dom.document.getElementById('tagButtons').children[0].click();
  assert.match(dom.document.getElementById('status').textContent, /confirm|DeFi-only/i);
  for (const timer of timers) timer();
  assert.equal(closed, false);
});


test('creation requests opt into immediate streaming response headers', async () => {
  const h = backgroundHarness();
  assert.equal((await h.create())?.ok, true);
  assert.equal(h.requests[0].body.streamResponse, true);
});

test('a streamed HTTP 200 carries a logical 409 confirmation outcome', async () => {
  const h = backgroundHarness({ responses: [{ ok: true, status: 200, json: async () => ({ status: 409, requiresDefiConfirmation: true, error: 'Awaiting a verified US mapping.' }) }] });
  const result = await h.create();
  assert.equal(result?.ok, true);
  assert.equal(result.pending, true);
  assert.ok(h.pending()?.requestId);
  assert.equal(h.messages.some((message) => message.type === 'POLY_DUB_COPY_LINK'), false);
});

test('a streamed logical success copies using the final regional routing result', async () => {
  const h = backgroundHarness({ responses: [{ ok: true, status: 200, json: async () => ({ status: 200, shortLink: 'https://poly.market/streamed', routingMode: 'regional' }) }] });
  assert.equal((await h.create())?.ok, true);
  assert.equal(h.messages.at(-1).shortLink, 'https://poly.market/streamed');
});

test('a streamed HTTP 200 cannot turn a logical upstream failure into copied success', async () => {
  const h = backgroundHarness({ responses: [{ ok: true, status: 200, json: async () => ({ status: 503, error: 'Routing unavailable.', shortLink: 'https://poly.market/invalid' }) }] });
  const result = await h.create();
  assert.equal(result?.ok, false);
  assert.match(result.error, /Routing unavailable/);
  assert.equal(h.messages.some((message) => message.type === 'POLY_DUB_COPY_LINK'), false);
});

for (const [name, response] of [['success', successResponse], ['pending confirmation', confirmResponse], ['logical failure', { ok: true, status: 200, json: async () => ({ status: 503, error: 'Unavailable' }) }], ['invalid JSON', { ok: true, status: 200, json: async () => { throw new Error('Malformed body'); } }]]) {
  test(`worker keepalive runs while reading response JSON and is cleaned after ${name}`, async () => {
    let releaseJson;
    const h = backgroundHarness({ responses: [{ ...response, json: () => new Promise((resolve, reject) => { releaseJson = async () => { try { resolve(await response.json()); } catch (error) { reject(error); } }; }) }] });
    const action = h.create();
    await flush();
    assert.equal(h.intervals.size, 1, 'keepalive remains active while the body streams');
    const interval = [...h.intervals.values()][0];
    assert.equal(interval.ms, 20_000);
    await interval.fn();
    assert.equal(h.platformCalls(), 1, 'a Chrome API call keeps the worker active');
    await releaseJson();
    await action;
    assert.equal(h.intervals.size, 0, 'finished reads never leak keepalive timers');
    assert.equal(h.intervalStarts(), 1);
  });
}

test('worker keepalive begins before response headers and is cleaned after a network failure without retry', async () => {
  let rejectFetch;
  const h = backgroundHarness({ fetchImpl: () => new Promise((_resolve, reject) => { rejectFetch = reject; }) });
  const action = h.create();
  await flush();
  assert.equal(h.intervals.size, 1);
  rejectFetch(new Error('Connection lost'));
  assert.equal((await action)?.ok, false);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.requests.length, 1);
});


test('the original page confirmation survives a worker restart and can be consumed only once', async () => {
  const firstWorker = backgroundHarness({ responses: [confirmResponse] });
  await firstWorker.create('@Other');
  const nonce = firstWorker.pending().requestId;
  const resumedWorker = backgroundHarness({ state: firstWorker.state });
  assert.equal((await resumedWorker.confirm(nonce))?.ok, true);
  assert.equal(resumedWorker.requests.length, 1);
  assert.deepEqual(resumedWorker.requests[0].body, { description: 'Original description', tagName: '@Other', title: 'Original title', url: sourceUrl, streamResponse: true, allowDefiOnly: true });
  const thirdWorker = backgroundHarness({ state: firstWorker.state });
  assert.equal((await thirdWorker.confirm(nonce))?.ok, false);
  assert.equal(thirdWorker.requests.length, 0);
});

test('concurrent confirmations after a worker restart consume a saved nonce atomically', async () => {
  const first = backgroundHarness({ responses: [confirmResponse] });
  await first.create();
  const second = backgroundHarness({ state: first.state });
  const results = await Promise.all([second.confirm(first.pending().requestId), second.confirm(first.pending().requestId)]);
  assert.equal(results.filter((result) => result?.ok).length, 1);
  assert.equal(results.filter((result) => !result?.ok).length, 1);
  assert.equal(second.requests.length, 1);
});

for (const invalidation of ['current page changed', 'session changed', 'tag removed', 'navigation away and back', 'settings changed and restored', 'tab removed']) {
  test(`saved confirmation cannot survive ${invalidation} across worker restarts`, async () => {
    const first = backgroundHarness({ responses: [confirmResponse] });
    await first.create();
    assert.equal(Object.keys(first.state.session).length, 1, 'the pending action is saved outside worker memory');
    const resumed = backgroundHarness({ state: first.state });
    if (invalidation === 'current page changed') resumed.tab.url = 'https://polymarket.com/event/other';
    if (invalidation === 'session changed') resumed.settings.sessionToken = 'session-b';
    if (invalidation === 'tag removed') resumed.settings.dubTags = ['@Other'];
    if (invalidation === 'navigation away and back') {
      await resumed.listeners.updated(17, { url: 'https://polymarket.com/event/other' });
      await resumed.listeners.updated(17, { url: sourceUrl });
    }
    if (invalidation === 'settings changed and restored') {
      await resumed.listeners.storage({ defaultTag: { oldValue: '@Creator', newValue: '@Other' } }, 'local');
      await resumed.listeners.storage({ defaultTag: { oldValue: '@Other', newValue: '@Creator' } }, 'local');
    }
    if (invalidation === 'tab removed') await resumed.listeners.removed(17);
    const finalWorker = backgroundHarness({ state: first.state });
    assert.equal((await finalWorker.confirm(first.pending().requestId))?.ok, false);
    assert.equal(finalWorker.requests.length, 0);
  });
}

test('pending actions for separate tabs are persisted independently', async () => {
  const sharedSession = {};
  const firstTab = backgroundHarness({ state: { session: sharedSession }, responses: [confirmResponse], tabId: 17 });
  const secondTab = backgroundHarness({ state: { session: sharedSession }, responses: [confirmResponse], tabId: 18 });
  await Promise.all([firstTab.create(), secondTab.create('@Other')]);
  assert.equal(Object.keys(sharedSession).length, 2);
  const resumedFirst = backgroundHarness({ state: firstTab.state });
  const resumedSecond = backgroundHarness({ state: secondTab.state });
  assert.equal((await resumedFirst.confirm(firstTab.pending().requestId))?.ok, true);
  assert.equal((await resumedSecond.confirm(secondTab.pending().requestId))?.ok, true);
  assert.equal(resumedFirst.requests[0].body.tagName, '@Creator');
  assert.equal(resumedSecond.requests[0].body.tagName, '@Other');
});
