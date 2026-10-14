const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto, randomUUID } = require('node:crypto');
const path = require('node:path');

const sourceUrl = 'https://polymarket.com/event/example?tid=7&via=old#selected';
const accountId = '11111111-1111-4111-8111-111111111111';
const otherAccountId = '22222222-2222-4222-8222-222222222222';
const apiKey = 'plk_test_personal_secret';
const requestId = '33333333-3333-4333-8333-333333333333';
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); } assert.ok(predicate(), 'expected asynchronous operation to begin'); }
const response = (status, body, streamed = true) => ({ status: streamed ? 200 : status, json: async () => ({ ...(streamed ? { status } : {}), ...body }) });
const success = (body, overrides = {}) => response(201, { request_id: requestId, data: { account_id: body.account_id, destination: new URL(body.destination).href, short_link: 'https://polymarket.com/r/verified', routing_mode: body.allow_defi_only ? 'defi_only' : 'regional', ...overrides } });
const confirmation = () => response(422, { error: { code: 'defi_confirmation_required', message: 'No verified US mapping is available.', request_id: requestId } });

function backgroundHarness({ url = sourceUrl, responses = [], fetchImpl, state = {}, tabId = 17, storageFailure = false, copyFailure = false, accessFailure = false } = {}) {
  const listeners = {}, requests = [], messages = [], badges = [], menus = [], popups = [], intervals = new Map();
  let intervalStarts = 0, platformCalls = 0, optionsOpened = 0, trustedStorage = false;
  const tabs = state.tabs ||= { [tabId]: { id: tabId, url } };
  const tab = tabs[tabId];
  const settings = state.settings ||= { polyLinksApiKey: apiKey, polyLinksAccounts: [{ id: accountId, username: '@Creator', platform: 'x' }, { id: otherAccountId, username: '@Other', platform: 'instagram' }], defaultAccountId: accountId, accountSelectionMode: 'default' };
  const session = state.session ||= {};
  const makeStorage = (store, local = false) => ({
    get: async (keys) => keys == null ? clone(store) : typeof keys === 'object' && !Array.isArray(keys) ? clone({ ...keys, ...store }) : Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(key => key in store).map(key => [key, clone(store[key])])),
    set: async (values) => { if (local && storageFailure && Object.keys(values).some(k => k.startsWith('poly-dub-request:'))) throw new Error('Storage unavailable'); Object.assign(store, clone(values)); },
    remove: async (keys) => (typeof keys === 'string' ? [keys] : keys).forEach(key => delete store[key]),
    setAccessLevel: async ({ accessLevel }) => { if (accessFailure) throw new Error('Access protection failed'); trustedStorage = accessLevel === 'TRUSTED_CONTEXTS'; },
  });
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const chrome = {
    action: { onClicked: event('action'), setBadgeBackgroundColor: async () => {}, setBadgeText: async ({ text }) => badges.push(text), setPopup: async ({ popup }) => popups.push(popup) },
    contextMenus: { onClicked: event('menu'), removeAll: async () => { menus.length = 0; }, create: item => menus.push(item) },
    runtime: { getURL: file => `chrome-extension://extension-id/${file}`, getPlatformInfo: async () => { platformCalls++; }, id: 'extension-id', onInstalled: event('install'), onStartup: event('startup'), onMessage: event('message'), openOptionsPage: async () => { optionsOpened++; } },
    scripting: { executeScript: async () => {} },
    storage: { session: makeStorage(session), local: makeStorage(settings, true), onChanged: event('storage') },
    tabs: {
      get: async (id) => { if (!tabs[id]) throw new Error('Unknown tab'); return { ...tabs[id] }; },
      onUpdated: event('updated'), onRemoved: event('removed'),
      sendMessage: async (id, message) => { messages.push({ ...message, tabId: id }); if (message.type === 'POLY_DUB_GET_PAGE') return { ok: true, url: tabs[id].url, title: 'Title', description: 'Description' }; if (message.type === 'POLY_DUB_COPY_LINK' && copyFailure) return { ok: false, error: 'Clipboard denied' }; return { ok: true }; },
    },
  };
  const context = { chrome, crypto: { randomUUID, subtle: webcrypto.subtle }, TextEncoder, URL, console: { error() {} }, setTimeout: () => 1, setInterval: (fn, ms) => { const id = ++intervalStarts; intervals.set(id, { fn, ms }); return id; }, clearInterval: id => intervals.delete(id), fetch: async (url, options) => {
    const request = { url, headers: options.headers, body: JSON.parse(options.body), redirect: options.redirect, credentials: options.credentials, cache: options.cache, referrerPolicy: options.referrerPolicy, storedBeforeFetch: clone(settings) }; requests.push(request);
    return fetchImpl ? fetchImpl(request, options) : responses.length ? responses.shift() : success(request.body);
  } };
  vm.runInNewContext(read('background.js'), context);
  const send = (message, sender = { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' }) => new Promise((resolve, reject) => { try { if (listeners.message(message, sender, resolve) !== true) resolve(undefined); } catch (error) { reject(error); } });
  return { state, tab, tabs, settings, requests, messages, badges, listeners, intervals, menus, popups, context, send,
    intervalStarts: () => intervalStarts, platformCalls: () => platformCalls, optionsOpened: () => optionsOpened, trustedStorage: () => trustedStorage,
    create: (id = accountId, target = tab.id) => send({ type: 'POLY_DUB_CREATE_WITH_ACCOUNT', tabId: target, accountId: id }),
    confirm: (nonce, sender = { id: 'extension-id', frameId: 0, tab: { id: tab.id, url: tab.url }, url: tab.url }) => send({ type: 'POLY_DUB_CONFIRM_DEFI_ONLY', requestId: nonce }, sender),
    pending: () => messages.findLast(message => message.type === 'POLY_DUB_CONFIRM_DEFI_ONLY_REQUIRED'),
    records: () => Object.entries(settings).filter(([key]) => key.startsWith('poly-dub-request:')).map(([, value]) => value),
  };
}

for (const url of [sourceUrl, 'https://polymarket.us/event/us-market?market=7', 'https://www.polymarket.us/event/us-market', 'https://www.polymarket.com/event/global-market']) {
  test(`one click requests mandatory regional routing for the selected account from ${new URL(url).host}`, async () => {
    const h = backgroundHarness({ url });
    assert.equal((await h.create(otherAccountId))?.ok, true);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, 'https://dub-links-nine.vercel.app/api/v1/links');
    assert.deepEqual(h.requests[0].body, { account_id: otherAccountId, destination: url, require_routing: true });
    assert.equal(h.requests[0].headers.authorization, `Bearer ${apiKey}`);
    assert.equal(h.requests[0].headers['X-PolyLinks-Stream'], '1');
    assert.equal(h.messages.at(-1).routingMode, 'regional');
    assert.equal(h.messages.at(-1).accountLabel, '@Other (instagram)');
    assert.equal(h.messages.at(-1).sourceUrl, url);
    assert.equal(JSON.stringify(h.messages).includes(apiKey), false);
  });
}
for (const url of ['https://fake.polymarket.com/event/x', 'https://polymarket.us.evil.test/event/x', 'https://user@polymarket.com/event/x', 'https://polymarket.com:8443/event/x', 'http://polymarket.com/event/x']) {
  test(`unsupported source cannot create: ${url}`, async () => { const h = backgroundHarness({ url }); assert.equal((await h.create())?.ok, false); assert.equal(h.requests.length, 0); });
}
test('popup create requests must originate from the extension popup', async () => {
  const h = backgroundHarness();
  await h.send({ type: 'POLY_DUB_CREATE_WITH_ACCOUNT', tabId: 17, accountId }, { id: 'extension-id', tab: h.tab, url: sourceUrl });
  assert.equal(h.requests.length, 0);
});
test('a request identity is durably saved before fetch without storing the API key in its record', async () => {
  const h = backgroundHarness(); await h.create();
  const request = h.requests[0];
  const saved = Object.values(request.storedBeforeFetch).find(value => value?.idempotencyKey);
  assert.ok(saved, 'the request exists before any network write');
  assert.equal(saved.idempotencyKey, request.headers['Idempotency-Key']);
  assert.deepEqual(saved.body, request.body);
  assert.match(saved.credentialDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(saved).includes(apiKey), false);
});
test('personal-key requests refuse redirects and omit browser cookies and referrers', async () => {
  const h = backgroundHarness(); await h.create(); const request = h.requests[0];
  assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'omit'); assert.equal(request.cache, 'no-store'); assert.equal(request.referrerPolicy, 'no-referrer');
});
test('failed durable storage prevents network submission', async () => { const h = backgroundHarness({ storageFailure: true }); assert.equal((await h.create())?.ok, false); assert.equal(h.requests.length, 0); });
test('unconfigured updates open account setup and restrict API keys to trusted extension contexts', async () => {
  const h = backgroundHarness({ state: { settings: { sessionToken: 'old', defaultTag: '@Old' } } });
  await h.listeners.install({ reason: 'update' });
  assert.equal(h.optionsOpened(), 1); assert.equal(h.trustedStorage(), true);
  assert.equal(h.settings.sessionToken, 'old', 'a failed or unfinished setup does not erase legacy settings');
  assert.equal((await h.create())?.ok, false); assert.equal(h.requests.length, 0);
});
test('UI settings reads also fail closed when trusted storage protection fails', async () => {
  const h = backgroundHarness({ accessFailure: true });
  await assert.rejects(h.context.syncExtensionUi(), /protect.*API key/i);
  assert.equal((await h.create())?.ok, false); assert.equal(h.requests.length, 0);
});
test('ask mode sets the account popup while default mode offers alternate account menus', async () => {
  const h = backgroundHarness(); await h.context.syncExtensionUi();
  assert.equal(h.popups.at(-1), ''); assert.equal(h.menus.length, 1); assert.match(h.menus[0].title, /@Other/);
  h.settings.accountSelectionMode = 'ask'; await h.context.syncExtensionUi();
  assert.equal(h.popups.at(-1), 'popup.html'); assert.equal(h.menus.length, 0);
});

for (const [name, override] of [ ['wrong account', { account_id: otherAccountId }], ['wrong destination', { destination: 'https://polymarket.com/event/other' }], ['missing routing', { routing_mode: undefined }], ['unconsented fallback', { routing_mode: 'defi_only' }], ['external short URL', { short_link: 'https://evil.example/r/x' }], ['credential short URL', { short_link: 'https://user@polymarket.com/r/x' }], ['port short URL', { short_link: 'https://polymarket.com:8443/r/x' }], ['fragment short URL', { short_link: 'https://polymarket.com/r/x#wrong' }], ['nonredirect short URL', { short_link: 'https://polymarket.com/event/x' }] ]) {
  test(`success validation rejects ${name} and preserves request identity`, async () => {
    const h = backgroundHarness({ fetchImpl: request => success(request.body, override) });
    assert.equal((await h.create())?.ok, false); assert.equal(h.messages.some(message => message.type === 'POLY_DUB_COPY_LINK'), false); assert.equal(h.records().length, 1);
  });
}
test('a streamed logical failure cannot become a copied link', async () => {
  const h = backgroundHarness({ responses: [response(503, { error: { code: 'request_pending', message: 'Pending.', request_id: requestId }, data: { short_link: 'https://polymarket.com/r/x' } })] });
  const result = await h.create(); assert.equal(result?.ok, false); assert.match(result.error, new RegExp(requestId)); assert.equal(h.messages.some(message => message.type === 'POLY_DUB_COPY_LINK'), false);
});
test('a short link containing parser-trimmed whitespace is never copied', async () => {
  const h = backgroundHarness({ fetchImpl: request => success(request.body, { short_link: ' https://polymarket.com/r/x ' }) });
  assert.equal((await h.create())?.ok, false); assert.equal(h.records().length, 1);
});
test('ordinary nonstreamed API success remains compatible', async () => {
  const h = backgroundHarness({ fetchImpl: request => { const result = success(request.body); result.status = 201; return result; } }); assert.equal((await h.create())?.ok, true);
});
test('mapping hold requests explicit consent without copying or keeping a write pending', async () => {
  const h = backgroundHarness({ responses: [confirmation()] }); const result = await h.create(otherAccountId);
  assert.equal(result?.ok, true); assert.equal(result.pending, true); assert.equal(h.requests.length, 1); assert.equal(h.records().length, 0);
  assert.equal(h.pending().sourceUrl, sourceUrl); assert.equal(h.pending().accountLabel, '@Other (instagram)'); assert.ok(h.pending().requestId.length >= 32);
  assert.equal(h.messages.some(message => message.type === 'POLY_DUB_COPY_LINK'), false);
});
test('explicit account-bound consent changes only allow_defi_only and uses a new key once', async () => {
  const h = backgroundHarness({ responses: [confirmation()] }); await h.create(otherAccountId); const nonce = h.pending().requestId;
  assert.equal((await h.confirm(nonce))?.ok, true);
  assert.deepEqual(h.requests[1].body, { account_id: otherAccountId, destination: sourceUrl, require_routing: true, allow_defi_only: true });
  assert.notEqual(h.requests[1].headers['Idempotency-Key'], h.requests[0].headers['Idempotency-Key']);
  assert.equal((await h.confirm(nonce))?.ok, false); assert.equal(h.requests.length, 2);
});
for (const invalidation of ['wrong nonce', 'subframe', 'navigation', 'key changed', 'account removed', 'settings changed and restored', 'tab removed']) {
  test(`saved consent fails closed after ${invalidation}`, async () => {
    const first = backgroundHarness({ responses: [confirmation()] }); await first.create(); const h = backgroundHarness({ state: first.state }); let nonce = first.pending().requestId, sender;
    if (invalidation === 'wrong nonce') nonce = randomUUID();
    if (invalidation === 'subframe') sender = { id: 'extension-id', frameId: 1, tab: h.tab, url: sourceUrl };
    if (invalidation === 'navigation') h.tab.url = 'https://polymarket.com/event/other';
    if (invalidation === 'key changed') h.settings.polyLinksApiKey = 'plk_changed';
    if (invalidation === 'account removed') h.settings.polyLinksAccounts = [];
    if (invalidation === 'settings changed and restored') { await h.listeners.storage({ defaultAccountId: {} }, 'local'); }
    if (invalidation === 'tab removed') await h.listeners.removed(17);
    assert.equal((await h.confirm(nonce, sender))?.ok, false); assert.equal(h.requests.length, 0);
  });
}
test('bound consent survives worker restart and concurrent confirmations consume it once', async () => {
  const first = backgroundHarness({ responses: [confirmation()] }); await first.create(); const resumed = backgroundHarness({ state: first.state });
  const results = await Promise.all([resumed.confirm(first.pending().requestId), resumed.confirm(first.pending().requestId)]);
  assert.equal(results.filter(result => result?.ok).length, 1); assert.equal(resumed.requests.length, 1);
});
test('manual retry after a lost response preserves exact key and body across browser restart', async () => {
  const first = backgroundHarness({ fetchImpl: async () => { throw new Error('Connection dropped'); } });
  assert.equal((await first.create())?.ok, false); assert.equal(first.requests.length, 1); assert.equal(first.records().length, 1);
  first.state.session = {}; const resumed = backgroundHarness({ state: first.state }); assert.equal((await resumed.create())?.ok, true);
  assert.equal(resumed.requests[0].headers['Idempotency-Key'], first.requests[0].headers['Idempotency-Key']); assert.deepEqual(resumed.requests[0].body, first.requests[0].body);
});
test('unknown consented requests retain exact consent on replay without requiring a second write identity', async () => {
  const first = backgroundHarness({ responses: [confirmation()], fetchImpl: async () => first.requests.length === 1 ? confirmation() : Promise.reject(new Error('Connection dropped')) });
  await first.create(); assert.equal((await first.confirm(first.pending().requestId))?.ok, false);
  const resumed = backgroundHarness({ state: first.state }); assert.equal((await resumed.create())?.ok, true);
  assert.equal(resumed.requests[0].body.allow_defi_only, true); assert.equal(resumed.requests[0].headers['Idempotency-Key'], first.requests[1].headers['Idempotency-Key']);
});
test('navigation and settings changes preserve unknown writes and key rotation cannot mint anew', async () => {
  const h = backgroundHarness({ fetchImpl: async () => { throw new Error('Connection dropped'); } }); await h.create(); const saved = clone(h.records()[0]);
  await h.listeners.updated(17, { url: 'https://polymarket.com/event/other' }); await h.listeners.removed(17);
  h.settings.polyLinksApiKey = 'plk_changed'; await h.listeners.storage({ polyLinksApiKey: {} }, 'local');
  assert.deepEqual(h.records()[0], saved); const result = await h.create(); assert.equal(result?.ok, false); assert.match(result.error, /previous|original|key|unconfirmed/i); assert.equal(h.requests.length, 1);
});
test('an authorization failure on replay cannot erase an earlier unknown outcome', async () => {
  const first = backgroundHarness({ fetchImpl: async () => { throw new Error('lost'); } }); await first.create();
  const resumed = backgroundHarness({ state: first.state, responses: [response(401, { error: { code: 'unauthorized', message: 'Revoked' } })] });
  assert.equal((await resumed.create())?.ok, false); assert.equal(resumed.records().length, 1); assert.ok(resumed.optionsOpened());
});
for (const [status, code, match] of [[401, 'unauthorized', /API key|settings/i], [403, 'forbidden_account', /refresh.*account|account.*settings/i], [429, 'quota_exceeded', /limit|quota/i]]) {
  test(`${status} gives an actionable error and frees only a known failed initial attempt`, async () => {
    const h = backgroundHarness({ responses: [response(status, { error: { code, message: 'API rejection' } })] });
    const result = await h.create(); assert.equal(result?.ok, false); assert.match(result.error, match); assert.equal(h.records().length, 0);
    if (status !== 429) assert.ok(h.optionsOpened());
  });
}
test('simultaneous same-tab and same-account/page actions cannot create duplicate writes', async () => {
  let release; const h = backgroundHarness({ fetchImpl: request => new Promise(resolve => { release = () => resolve(success(request.body)); }) });
  h.tabs[18] = { id: 18, url: sourceUrl }; const first = h.create(); await until(() => h.requests.length);
  assert.equal((await h.create())?.inProgress, true); assert.equal((await h.create(accountId, 18))?.inProgress, true); assert.equal(h.requests.length, 1); release(); assert.equal((await first)?.ok, true);
});
test('navigation during a successful write stores the result without copying onto another market', async () => {
  let release; const h = backgroundHarness({ fetchImpl: request => new Promise(resolve => { release = () => resolve(success(request.body)); }) }); const first = h.create(); await until(() => h.requests.length);
  h.tab.url = 'https://polymarket.com/event/new'; await h.listeners.updated(17, { url: h.tab.url }); release(); assert.equal((await first)?.ok, false);
  assert.equal(h.messages.some(message => message.type === 'POLY_DUB_COPY_LINK'), false); assert.equal(h.records().length, 1);
  h.tab.url = sourceUrl; const resumed = backgroundHarness({ state: h.state }); assert.equal((await resumed.create())?.ok, true); assert.equal(resumed.requests.length, 0);
});
test('clipboard failure retains a completed result so retry copies without another API write', async () => {
  const first = backgroundHarness({ copyFailure: true }); assert.equal((await first.create())?.ok, false); assert.equal(first.records().length, 1);
  const resumed = backgroundHarness({ state: first.state }); assert.equal((await resumed.create())?.ok, true); assert.equal(resumed.requests.length, 0); assert.equal(resumed.records().length, 0);
});
for (const outcome of ['success', 'confirmation', 'malformed JSON', 'network failure']) {
  test(`keepalive spans response reading and stops after ${outcome}`, async () => {
    let release; const h = backgroundHarness({ fetchImpl: request => outcome === 'network failure' ? new Promise((_resolve, reject) => { release = () => reject(new Error('lost')); }) : Promise.resolve({ status: 200, json: () => new Promise((resolve, reject) => { release = async () => outcome === 'malformed JSON' ? reject(new Error('bad JSON')) : resolve(await (outcome === 'confirmation' ? confirmation() : success(request.body)).json()); }) }) });
    const action = h.create(); await until(() => release); assert.equal(h.intervals.size, 1); const interval = [...h.intervals.values()][0]; assert.equal(interval.ms, 20000); await interval.fn(); assert.equal(h.platformCalls(), 1); await release(); await action; assert.equal(h.intervals.size, 0); assert.equal(h.requests.length, 1);
  });
}

function documentHarness() {
  const nodes = [];
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.handlers = {}; this.disabled = false; this.textContent = ''; nodes.push(this); }
    append(...children) { this.children.push(...children); } appendChild(child) { this.append(child); return child; } remove() { this.removed = true; }
    addEventListener(event, fn) { this.handlers[event] = fn; } attachShadow() { this.shadow = new Element('shadow'); return this.shadow; }
    async click(trusted = true) { return this.handlers.click?.({ isTrusted: trusted, preventDefault() {}, stopPropagation() {} }); }
  }
  const document = { createElement: tag => new Element(tag), getElementById: id => nodes.find(node => node.id === id && !node.removed), querySelector: () => null, title: 'Example', execCommand: () => true };
  document.documentElement = new Element('html'); document.body = new Element('body'); return { document, nodes, Element };
}
function contentHarness() {
  const dom = documentHarness(), sent = [], copied = []; let handler; const location = { href: sourceUrl };
  const chrome = { runtime: { onMessage: { addListener(fn) { handler = fn; } }, sendMessage: async message => { sent.push(message); return { ok: true }; } } };
  vm.runInNewContext(read('content-script.js'), { ...dom, chrome, location, window: {}, URL, navigator: { clipboard: { writeText: async text => copied.push(text) } }, setTimeout: () => 1 });
  const send = message => new Promise(resolve => { if (handler(message, {}, resolve) !== true) resolve(undefined); });
  return { ...dom, sent, copied, location, send, confirmationButton: () => dom.nodes.findLast(node => node.tagName === 'button' && /DeFi-only/.test(node.textContent)) };
}
test('content captures the complete current URL without dropping selectors or referral identity', async () => { const h = contentHarness(); assert.equal((await h.send({ type: 'POLY_DUB_GET_PAGE' })).url, sourceUrl); });
test('only a trusted explicit confirmation button click sends background consent', async () => {
  const h = contentHarness(); await h.send({ type: 'POLY_DUB_CONFIRM_DEFI_ONLY_REQUIRED', requestId: 'opaque', sourceUrl, accountLabel: '@Creator (x)' }); const button = h.confirmationButton(); assert.ok(button); await button.click(false); assert.equal(h.sent.length, 0); await button.click(true); await button.click(true); assert.equal(h.sent.length, 1); assert.equal(h.sent[0].requestId, 'opaque');
});
test('content refuses to copy or confirm after client-side navigation', async () => {
  const h = contentHarness(); await h.send({ type: 'POLY_DUB_CONFIRM_DEFI_ONLY_REQUIRED', requestId: 'opaque', sourceUrl, accountLabel: '@Creator (x)' }); const button = h.confirmationButton(); h.location.href = 'https://polymarket.com/event/new'; await button.click(); assert.equal(h.sent.length, 0);
  assert.equal((await h.send({ type: 'POLY_DUB_COPY_LINK', sourceUrl, shortLink: 'https://polymarket.com/r/x' }))?.ok, false); assert.equal(h.copied.length, 0);
});
for (const [routingMode, expected] of [['regional', /regional/i], ['defi_only', /DeFi.only/i]]) {
  test(`copy success names its account and ${routingMode} routing`, async () => { const h = contentHarness(); await h.send({ type: 'POLY_DUB_COPY_LINK', sourceUrl, shortLink: 'https://polymarket.com/r/x', accountLabel: '@Creator (x)', routingMode }); assert.deepEqual(h.copied, ['https://polymarket.com/r/x']); assert.match(h.document.getElementById('poly-dub-toast').textContent, expected); assert.match(h.document.getElementById('poly-dub-toast').textContent, /@Creator/); });
}
