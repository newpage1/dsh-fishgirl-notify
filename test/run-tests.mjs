// dsh-finish-notify 自测：零外网依赖（全部走 127.0.0.1 假接收端 + 假时钟）。
// 运行：node test/run-tests.mjs
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import * as crypto from 'node:crypto';
const { createECDH, createDecipheriv, hkdfSync, createVerify, createPublicKey } = crypto;

const ROOT = new URL('..', import.meta.url).pathname;

const { DEFAULT_CONFIG, inQuietHours, normalizeConfig } = await import(`${ROOT}lib/config.js`);
const { buildClickUrl, buildNotice, formatDuration, kindFromReason, renderTemplate, validateChannelPayload, validateNotice } = await import(`${ROOT}lib/notice.js`);
const { createNotifier } = await import(`${ROOT}lib/notifier.js`);
const { createStore, saveChannelSecrets, secretsView, validateFeishuWebhook } = await import(`${ROOT}lib/store.js`);
const { createRouter } = await import(`${ROOT}lib/router.js`);
const { feishuChannel } = await import(`${ROOT}lib/channels/feishu.js`);
const { feishuAppChannel } = await import(`${ROOT}lib/channels/feishu-app.js`);
const { resolveChannelOrder } = await import(`${ROOT}lib/channels/registry.js`);
const { ntfyChannel } = await import(`${ROOT}lib/channels/ntfy.js`);
const { webpushChannel } = await import(`${ROOT}lib/channels/webpush.js`);
const { encryptPayload, generateVapidKeys, loadVapidKey, buildVapidAuthorization, fromB64Url } = await import(`${ROOT}lib/webpush/crypto.js`);

// ---------- 测试基建 ----------
let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  ✗ ${name}\n    ${error?.stack ?? error}`);
  }
}

class FakeClock {
  constructor(start = 1_700_000_000_000) {
    this.nowMs = start;
    this.tasks = new Map();
    this.nextId = 1;
  }
  now() { return this.nowMs; }
  set(fn, ms) {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { at: this.nowMs + Math.max(0, ms), fn });
    return id;
  }
  clear(id) { this.tasks.delete(id); }
  async advance(ms) {
    const target = this.nowMs + ms;
    for (;;) {
      let dueKey = null;
      let due = null;
      for (const [id, task] of this.tasks) {
        if (task.at <= target && (due === null || task.at < due.at)) { due = task; dueKey = id; }
      }
      if (due === null) break;
      this.nowMs = due.at;
      this.tasks.delete(dueKey);
      await due.fn();
    }
    this.nowMs = target;
  }
}

/** 本地假接收端：记录请求，按 path 返回配置的响应。 */
function createMockUpstream() {
  const requests = [];
  const routes = new Map(); // path → {status, body, headers} | fn
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { parsed = body.toString('utf8'); }
      const record = { method: req.method, url: req.url, headers: { ...req.headers }, body: parsed, rawBody: body };
      requests.push(record);
      const handler = routes.get(req.url.split('?')[0]);
      const response = typeof handler === 'function' ? handler(record, res) : handler;
      if (response === HANDLED) return;
      const { status = 200, body: respBody = {}, headers } = response ?? {};
      res.writeHead(status, { 'content-type': 'application/json', ...(headers ?? {}) });
      res.end(typeof respBody === 'string' ? respBody : JSON.stringify(respBody));
    });
  });
  const HANDLED = Symbol('handled');
  return {
    requests,
    routes,
    HANDLED,
    url: '',
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      this.url = `http://127.0.0.1:${server.address().port}`;
      return this.url;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function makeStore(dirName) {
  const dir = mkdtempSync(join(tmpdir(), `fn-${dirName}-`));
  return { store: createStore(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mockCtx() {
  const handlers = {};
  return {
    handlers,
    on(name, fn) { handlers[name] = fn; return () => delete handlers[name]; },
    effect() {},
    get() { return undefined; },
    webServer: { getOrigin: () => 'https://dsh.example-tunnel.dev' },
    logger: undefined,
  };
}

/** 模拟 index.js 的事件接线，并返回触发函数。 */
function attach(ctx, notifier) {
  ctx.on('session/event', (session, event) => notifier.handleEvent(session, event));
  return (session, type, data) => ctx.handlers['session/event'](session, { type, data });
}

const config = () => ({ ...DEFAULT_CONFIG, channelOrder: ['feishu', 'ntfy', 'webpush'] });

function makeEnv({ store, cfg, clock, fetchImpl, publicOrigin = 'https://dsh.example-tunnel.dev' }) {
  return {
    store,
    config: cfg,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetchImpl,
    now: () => clock.now(),
    healthCache: {},
    lastResults: {},
    publicOrigin,
  };
}

// ---------- 用例 ----------
console.log('\n[1] 配置归一化与回退');
await test('非法值回退默认并给出 issue', () => {
  const { value, issues } = normalizeConfig({ debounceMs: 99999, quietStart: '99:99', pushUrgency: 'loud', channelOrder: ['feishu', 'bark', 42] });
  strictEqual(value.debounceMs, DEFAULT_CONFIG.debounceMs);
  strictEqual(value.quietStart, DEFAULT_CONFIG.quietStart);
  strictEqual(value.pushUrgency, DEFAULT_CONFIG.pushUrgency);
  deepStrictEqual(value.channelOrder, ['feishu']);
  ok(issues.length >= 3);
});
await test('未知键被忽略', () => {
  const { value, issues } = normalizeConfig({ nope: 1 });
  ok(!('nope' in value));
  ok(issues.some((i) => i.key === 'nope'));
});
await test('静默时段：跨零点与全天', () => {
  const cfg = { quietEnabled: true, quietStart: '23:00', quietEnd: '08:00' };
  ok(inQuietHours(cfg, new Date('2026-01-01T23:30:00')));
  ok(inQuietHours(cfg, new Date('2026-01-01T06:00:00')));
  ok(!inQuietHours(cfg, new Date('2026-01-01T12:00:00')));
  const allDay = { quietEnabled: true, quietStart: '09:00', quietEnd: '09:00' };
  ok(inQuietHours(allDay, new Date('2026-01-01T15:00:00')));
});

console.log('\n[2] 文案与通知组装');
await test('kind 映射：aborted/blocked/forked 不提醒', () => {
  strictEqual(kindFromReason('completed'), 'completed');
  strictEqual(kindFromReason('error'), 'error');
  strictEqual(kindFromReason('aborted'), undefined);
  strictEqual(kindFromReason('blocked'), undefined);
  strictEqual(kindFromReason('forked'), undefined);
});
await test('模板渲染：未知变量原样保留', () => {
  const { text, unknown } = renderTemplate('{sessionTitle} 完成 {nope}', { sessionTitle: '写文档' });
  strictEqual(text, '写文档 完成 {nope}');
  deepStrictEqual(unknown, ['nope']);
});
await test('时长与合并 ×N', () => {
  strictEqual(formatDuration(48000), '48 秒');
  strictEqual(formatDuration(133000), '2 分 13 秒');
  const notice = buildNotice({
    kind: 'completed', sessionId: 's1', sessionTitle: '写文档', turn: 3, durationMs: 133000,
    count: 3, ids: ['s1:1', 's1:2', 's1:3'], config: config(),
  });
  strictEqual(notice.title, '做好啦～×3');
  strictEqual(notice.body, '一下子完成 3 轮啦');
  deepStrictEqual(notice.batch.count, 3);
  ok(validateNotice(notice).length === 0, validateNotice(notice).join(';'));
});
await test('clickUrl：相对 base 拒绝公网 http、finish 参数替换', () => {
  ok(buildClickUrl('n1', { reportedHref: 'http://192.168.1.5:3080/x' }) === undefined);
  ok(buildClickUrl('n1', { reportedHref: 'http://127.0.0.1:3080/x?finish=old&keep=1' }).includes('finish=n1'));
  ok(buildClickUrl('n1', { advertisedUrl: 'https://t.example.dev/' }).startsWith('https://t.example.dev/?finish=n1'));
});
await test('payload schema 校验拦住坏载荷', () => {
  ok(validateChannelPayload({ title: 'a', body: 'b' }).length === 0);
  ok(validateChannelPayload({ title: '', body: 'b' }).length > 0);
  ok(validateChannelPayload({ title: 'a', body: 'b', clickUrl: 5 }).some((e) => e.includes('clickUrl')));
});

console.log('\n[3] Web Push 加密与 VAPID（纯 node:crypto）');
await test('aes128gcm roundtrip：按 RFC 8291 步骤可解密', () => {
  // 用 node 原生能力模拟浏览器端解密。
  const as = createECDH('prime256v1');
  as.generateKeys();
  const serverKey = { ecdh: as, publicKeyRaw: Buffer.from(as.getPublicKey(null, 'uncompressed')) };
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const uaPublicB64 = Buffer.from(ua.getPublicKey(null, 'uncompressed')).toString('base64url');
  const authSecret = Buffer.from('0123456789abcdef');
  const plaintext = JSON.stringify({ title: '做好啦～', body: 'x'.repeat(200) });
  const body = encryptPayload({ keys: { p256dh: uaPublicB64, auth: authSecret.toString('base64url') } }, plaintext, serverKey);
  // 解密侧。
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  strictEqual(rs, 4096);
  strictEqual(idlen, 65);
  const ikm = ua.computeSecret(asPublic);
  const prk = Buffer.from(hkdfSync('sha256', ikm, authSecret, Buffer.alloc(0), 32));
  const info = (label) => Buffer.concat([Buffer.from(`${label}\0`), Buffer.from(ua.getPublicKey(null, 'uncompressed')), asPublic]);
  const cek = Buffer.from(hkdfSync('sha256', prk, Buffer.alloc(0), info('Content-Encoding: aes128gcm'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', prk, Buffer.alloc(0), info('Content-Encoding: nonce'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  const tail = ciphertext.subarray(0, ciphertext.length - 16);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(tail), decipher.final()]);
  strictEqual(padded[padded.length - 1], 0x02);
  strictEqual(padded.subarray(0, padded.length - 1).toString('utf8'), plaintext);
});
await test('VAPID：ES256 签名可被验证，材料可持久化加载', async () => {
  const vapid = generateVapidKeys('mailto:test@example.dev');
  ok(vapid.privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----'));
  ok(typeof vapid.publicKeyB64url === 'string' && fromB64Url(vapid.publicKeyB64url).length === 65);
  const loaded = loadVapidKey(vapid);
  ok(loaded);
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
  const auth = buildVapidAuthorization(endpoint, loaded, 'mailto:test@example.dev');
  ok(auth.startsWith('vapid t='));
  const jwt = /t=([^,]+),/.exec(auth)[1];
  const [h64, p64, s64] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h64, 'base64url').toString());
  deepStrictEqual({ typ: header.typ, alg: header.alg }, { typ: 'JWT', alg: 'ES256' });
  const payload = JSON.parse(Buffer.from(p64, 'base64url').toString());
  strictEqual(payload.aud, 'https://fcm.googleapis.com');
  const spki = Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), fromB64Url(vapid.publicKeyB64url)]);
  const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const verifier = createVerify('sha256');
  verifier.update(`${h64}.${p64}`);
  ok(verifier.verify({ key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s64, 'base64url')));
});

console.log('\n[4] 事件过滤 / 去抖 / 静默 / 异常吞噬');
await test('子代理与内部会话不触发', async () => {
  const { store, cleanup } = makeStore('ev1');
  const clock = new FakeClock();
  const sseEvents = [];
  const ctx = mockCtx();
  const notifier = createNotifier({ ctx, config: config(), store, logger: consoleSilent(), timers: clock });
  const emit = attach(ctx, notifier);
  notifier.sseClients.add({ write: (e, d) => sseEvents.push({ e, d }) });
  emit({ id: 'sub', header: { parentSession: 'root' } }, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  emit({ id: 'sub2', header: { origin: 'subagent' } }, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  emit({ id: 'sub3', header: { delegationDepth: 2 } }, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await clock.advance(3000);
  strictEqual(sseEvents.filter((x) => x.e === 'finish').length, 0);
  notifier.dispose();
  cleanup();
});
await test('顶层 completed 触发一次 + 去抖去重', async () => {
  const { store, cleanup } = makeStore('ev2');
  const clock = new FakeClock();
  const sseEvents = [];
  const ctx = mockCtx();
  const notifier = createNotifier({ ctx, config: { ...config(), channelOrder: [] }, store, logger: consoleSilent(), timers: clock });
  const emit = attach(ctx, notifier);
  notifier.sseClients.add({ write: (e, d) => sseEvents.push({ e, d }) });
  const session = { id: 'root1', header: {} };
  emit(session, 'turn/start', { turn: 1 });
  await clock.advance(60000);
  emit(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  // 同一 turn 重复事件 → LRU 去重。
  emit(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await clock.advance(2000);
  const finishes = sseEvents.filter((x) => x.e === 'finish');
  strictEqual(finishes.length, 1);
  strictEqual(finishes[0].d.title, '做好啦～');
  ok(finishes[0].d.clickUrl.startsWith('https://dsh.example-tunnel.dev/?finish=root1%3A1') || finishes[0].d.clickUrl.startsWith('https://dsh.example-tunnel.dev/?finish=root1:1'), finishes[0].d.clickUrl);
  // aborted 不提醒。
  emit(session, 'turn/end', { turn: 2, reason: { kind: 'aborted' } });
  await clock.advance(2000);
  strictEqual(sseEvents.filter((x) => x.e === 'finish').length, 1);
  notifier.dispose();
  cleanup();
});
await test('静默时段压手机通道但保留页内', async () => {
  const { store, cleanup } = makeStore('ev3');
  const clock = new FakeClock(new Date('2026-01-01T02:00:00').getTime());
  const sseEvents = [];
  const mock = createMockUpstream();
  await mock.start();
  await saveChannelSecrets(store, { feishu: { webhook: `${mock.url}/hook` } });
  const ctx = mockCtx();
  const cfg = { ...config(), quietEnabled: true, quietStart: '23:00', quietEnd: '08:00', quietSuppressPush: true };
  const notifier = createNotifier({ ctx, config: cfg, store, logger: consoleSilent(), timers: clock });
  const emit = attach(ctx, notifier);
  notifier.sseClients.add({ write: (e, d) => sseEvents.push({ e, d }) });
  emit({ id: 'r', header: {} }, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await clock.advance(2000);
  strictEqual(sseEvents.filter((x) => x.e === 'finish').length, 1);
  strictEqual(mock.requests.length, 0, '静默时段不应有外发请求');
  notifier.dispose();
  await mock.stop();
  cleanup();
});
await test('事件处理异常不外抛', async () => {
  const { store, cleanup } = makeStore('ev4');
  const clock = new FakeClock();
  const ctx = mockCtx();
  const notifier = createNotifier({ ctx, config: { ...config(), enabled: false }, store, logger: consoleSilent(), timers: clock });
  const emit = attach(ctx, notifier);
  // enabled=false 时事件被忽略；再注入一个坏事件对象验证不抛。
  emit(undefined, 'turn/end', null);
  emit({ id: 'x' }, 'turn/end', null);
  notifier.dispose();
  cleanup();
});

console.log('\n[5] 通道：feishu / ntfy / webpush（本地假接收端）');
await test('feishu：卡片成功路径 + 无 clickUrl 省略按钮', async () => {
  const { store, cleanup } = makeStore('ch1');
  const mock = createMockUpstream();
  mock.routes.set('/hook', { status: 200, body: { code: 0 } });
  await mock.start();
  await saveChannelSecrets(store, { feishu: { webhook: `${mock.url}/hook` } });
  const clock = new FakeClock();
  const env = makeEnv({ store, cfg: config(), clock, fetchImpl: fetch });
  const notice = buildNotice({ kind: 'completed', sessionId: 's', sessionTitle: '写文档', turn: 2, durationMs: 61000, config: config(), clickUrl: 'https://t.example.dev/?finish=s%3A2' });
  const payload = feishuChannel.render(notice, env);
  const result = await feishuChannel.send(payload, env);
  ok(result.ok, JSON.stringify(result));
  strictEqual(mock.requests.length, 1);
  const card = mock.requests[0].body.card;
  strictEqual(card.header.template, 'green');
  ok(card.elements.some((el) => el.tag === 'action'), '应有按钮');
  validateNoSecretLeak(mock, store);
  // 无 clickUrl：省略按钮。
  mock.requests.length = 0;
  const payload2 = feishuChannel.render({ ...notice, clickUrl: undefined }, env);
  await feishuChannel.send(payload2, env);
  const card2 = mock.requests[0].body.card;
  ok(!card2.elements.some((el) => el.tag === 'action'), '无 clickUrl 不应有按钮');
  await mock.stop();
  cleanup();
});
await test('feishu：卡片被拒 → 自动降级 text', async () => {
  const { store, cleanup } = makeStore('ch2');
  const mock = createMockUpstream();
  let calls = 0;
  mock.routes.set('/hook', { status: 200, body: { code: 19021, msg: 'card not supported' } });
  await mock.start();
  await saveChannelSecrets(store, { feishu: { webhook: `${mock.url}/hook` } });
  const clock = new FakeClock();
  const env = makeEnv({ store, cfg: config(), clock, fetchImpl: fetch });
  const notice = buildNotice({ kind: 'error', sessionId: 's', turn: 1, config: config(), error: { message: 'ETIMEDOUT' } });
  const result = await feishuChannel.send(feishuChannel.render(notice, env), env);
  strictEqual(mock.requests.length, 2, '应发两次（卡片+文本）');
  strictEqual(mock.requests[1].body.msg_type, 'text');
  ok(mock.requests[1].body.content.text.includes('呜…出错了') || mock.requests[1].body.content.text.includes('超时'));
  await mock.stop();
  cleanup();
});
await test('feishu：未配置 → not-configured 且无网络请求', async () => {
  const { store, cleanup } = makeStore('ch3');
  const clock = new FakeClock();
  const env = makeEnv({ store, cfg: config(), clock, fetchImpl: fetch });
  const result = await feishuChannel.send({ title: 't', body: 'b' }, env);
  strictEqual(result.ok, false);
  strictEqual(result.code, 'not-configured');
  strictEqual(feishuChannel.isConfigured(env), false);
  ok(validateFeishuWebhook('https://evil.example.com/hook') === false);
  ok(validateFeishuWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/x') === true);
  cleanup();
});
await test('ntfy：载荷形状（title/message/tags/click）与鉴权头', async () => {
  const { store, cleanup } = makeStore('ch4');
  const mock = createMockUpstream();
  mock.routes.set('/', { status: 200, body: {} });
  await mock.start();
  await saveChannelSecrets(store, { ntfy: { topic: 'dsh-abc123', token: 'tk_token' } });
  const clock = new FakeClock();
  const env = makeEnv({ store, cfg: { ...config(), ntfyServer: mock.url }, clock, fetchImpl: fetch });
  const notice = buildNotice({ kind: 'completed', sessionId: 's', sessionTitle: '写文档', turn: 4, durationMs: 13000, config: config(), clickUrl: 'https://t.example.dev/?finish=x' });
  const payload = ntfyChannel.render(notice, env);
  const result = await ntfyChannel.send(payload, env);
  ok(result.ok, JSON.stringify(result));
  strictEqual(mock.requests.length, 1);
  const body = mock.requests[0].body;
  strictEqual(body.topic, 'dsh-abc123');
  strictEqual(body.title, '做好啦～');
  ok(body.message.includes('写文档'));
  ok(body.message.includes('这一轮完成啦'));
  ok(body.tags.includes('fish') && body.tags.includes('tada'));
  strictEqual(body.click, 'https://t.example.dev/?finish=x');
  strictEqual(mock.requests[0].headers.authorization, 'Bearer tk_token');
  strictEqual(body.icon, 'https://dsh.example-tunnel.dev/api/finish-notify/assets/icon-192.png');
  await mock.stop();
  cleanup();
});
await test('webpush：410 清理失效订阅 + 201 成功刷新', async () => {
  const { store, cleanup } = makeStore('ch5');
  const mock = createMockUpstream();
  mock.routes.set('/push/a', { status: 201, body: '{}' });
  mock.routes.set('/push/b', { status: 410, body: '{}' });
  await mock.start();
  const { readSubscriptions } = await import(`${ROOT}lib/store.js`);
  await store.subscriptions.replace([
    { endpoint: `${mock.url}/push/a`, keys: await makeKeys(), origin: mock.url },
    { endpoint: `${mock.url}/push/b`, keys: await makeKeys(), origin: mock.url },
  ]);
  const clock = new FakeClock();
  const env = makeEnv({ store, cfg: config(), clock, fetchImpl: fetch });
  const notice = buildNotice({ kind: 'completed', sessionId: 's', turn: 1, config: config(), clickUrl: 'https://t.example.dev/?finish=x' });
  const results = await webpushChannel.send(webpushChannel.render(notice, env), env);
  strictEqual(results.length, 2);
  strictEqual(results.filter((r) => r.ok).length, 1);
  ok(results.some((r) => r.code === 'gone'));
  const remaining = readSubscriptions(store);
  strictEqual(remaining.length, 1);
  strictEqual(remaining[0].endpoint, `${mock.url}/push/a`);
  ok(remaining[0].lastOkAt !== undefined);
  // 请求头断言。
  const req = mock.requests[0];
  strictEqual(req.headers['content-encoding'], 'aes128gcm');
  ok(req.headers.authorization.startsWith('vapid t='));
  ok(Number(req.headers.ttl) > 0);
  ok(Buffer.isBuffer(req.rawBody) === false || req.rawBody.length > 0);
  // 日志/请求不泄漏订阅 keys。
  await mock.stop();
  cleanup();
});
await test('webpush：413 裁剪重发一次', async () => {
  const { store, cleanup } = makeStore('ch6');
  const mock = createMockUpstream();
  let calls = 0;
  mock.routes.set('/push/c', () => {
    calls += 1;
    if (calls === 1) return { status: 413, body: '{}' };
    return { status: 201, body: '{}' };
  });
  await mock.start();
  await store.subscriptions.replace([{ endpoint: `${mock.url}/push/c`, keys: await makeKeys(), origin: mock.url }]);
  const clock = new FakeClock();
  const env = makeEnv({ store, cfg: config(), clock, fetchImpl: fetch });
  const bigSummary = 'x'.repeat(900);
  const notice = buildNotice({ kind: 'completed', sessionId: 's', turn: 1, config: { ...config(), includeSummary: true }, summary: bigSummary });
  const results = await webpushChannel.send(webpushChannel.render(notice, env), env);
  strictEqual(calls, 2, '413 后应裁剪重发');
  ok(results.some((r) => r.ok));
  await mock.stop();
  cleanup();
});
await test('无凭证/无订阅：整链路静默降级 no-channel', async () => {
  const { store, cleanup } = makeStore('ch7');
  const clock = new FakeClock();
  const sseEvents = [];
  const ctx = mockCtx();
  const notifier = createNotifier({ ctx, config: config(), store, logger: consoleSilent(), timers: clock });
  const emit = attach(ctx, notifier);
  notifier.sseClients.add({ write: (e, d) => sseEvents.push({ e, d }) });
  emit({ id: 'r', header: {} }, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await clock.advance(2000);
  strictEqual(sseEvents.filter((x) => x.e === 'finish').length, 1, '页内仍应广播');
  const degraded = sseEvents.find((x) => x.e === 'degraded');
  ok(degraded, '应发 degraded(no-channel)');
  strictEqual(degraded.d.reason, 'no-channel');
  notifier.dispose();
  cleanup();
});
await test('通道失败按序降级：feishu 挂 → ntfy 顶上', async () => {
  const { store, cleanup } = makeStore('ch8');
  const mock = createMockUpstream();
  mock.routes.set('/bad', { status: 500, body: '{}' });
  mock.routes.set('/good', { status: 200, body: {} });
  await mock.start();
  await saveChannelSecrets(store, {
    feishu: { webhook: `${mock.url}/bad` },
    ntfy: { topic: 'dsh-zzz' },
  });
  const clock = new FakeClock();
  const cfg = { ...config(), ntfyServer: mock.url, requestTimeoutMs: 1500, retries: 0 };
  const sseEvents = [];
  const ctx = mockCtx();
  const notifier = createNotifier({ ctx, config: cfg, store, logger: consoleSilent(), timers: clock, fetchImpl: fetch });
  const emit = attach(ctx, notifier);
  notifier.sseClients.add({ write: (e, d) => sseEvents.push({ e, d }) });
  emit({ id: 'r', header: {} }, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await clock.advance(1500);
  // 等真实 fetch 完成（feishu 5xx 重试 0 次 + ntfy 一次）。
  await new Promise((r) => setTimeout(r, 300));
  const ntfyHits = mock.requests.filter((r) => r.url === '/good' || r.url === '/');
  ok(ntfyHits.length >= 1, 'ntfy 应发出');
  const deliveries = notifier.getRecentDeliveries();
  ok(deliveries.some((d) => d.channel === 'feishu' && !d.ok));
  ok(deliveries.some((d) => d.channel === 'ntfy' && d.ok));
  notifier.dispose();
  await mock.stop();
  cleanup();
});

console.log('\n[5.5] 通道 feishu-app：飞书应用机器人（URL 重写 mock，零外网）');
{
  const FA_BASE = 'https://open.feishu.cn';
  const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';
  const MSG_PATH = '/open-apis/im/v1/messages';
  const APP_ID = 'cli_a9z0TestExample';
  const APP_SECRET = 'sec_TestSecretDoNotLeak0001';
  const RECEIVE_ID = 'oc_testChatId0001';
  /** 产品代码硬编码官方域名；测试层把请求重写到本地假接收端。 */
  const rewriteFetch = (mock) => (input, init) => fetch(String(input).replace(FA_BASE, mock.url), init);
  const appConfig = () => ({ ...config(), channelOrder: ['feishu-app'], feishuAppEnabled: true, feishuAppReceiveId: RECEIVE_ID });
  const spyLogger = () => {
    const lines = [];
    const put = (level) => (...args) => { lines.push(`${level} ${args.join(' ')} ${JSON.stringify(args.slice(1))}`); };
    return { lines, debug: put('debug'), info: put('info'), warn: put('warn'), error: put('error') };
  };
  const setUp = async (dirName) => {
    const made = makeStore(dirName);
    await saveChannelSecrets(made.store, { feishuApp: { appId: APP_ID, appSecret: APP_SECRET } });
    return made;
  };
  const tokenRoute = (mock) => mock.routes.set(TOKEN_PATH, { status: 200, body: { code: 0, expire: 7200, tenant_access_token: 't-tenant-1' } });
  const msgRoute = (mock, fn) => mock.routes.set(MSG_PATH, fn);

  await test('feishu-app：interactive 卡片结构 + receive_id/鉴权头', async () => {
    const { store, cleanup } = await setUp('fa1');
    const mock = createMockUpstream();
    tokenRoute(mock);
    msgRoute(mock, { status: 200, body: { code: 0, data: { message_id: 'om_1' } } });
    await mock.start();
    const clock = new FakeClock();
    const logger = spyLogger();
    const env = makeEnv({ store, cfg: appConfig(), clock, fetchImpl: rewriteFetch(mock) });
    env.logger = logger;
    const notice = buildNotice({ kind: 'completed', sessionId: 's', sessionTitle: '写文档', turn: 3, durationMs: 73000, config: appConfig(), clickUrl: 'https://t.example.dev/?finish=s%3A3' });
    const result = await feishuAppChannel.send(feishuAppChannel.render(notice, env), env);
    ok(result.ok, JSON.stringify(result));
    strictEqual(mock.requests.length, 2, 'token + 消息各一次');
    const tokenReq = mock.requests[0];
    strictEqual(tokenReq.body.app_id, APP_ID);
    const msgReq = mock.requests[1];
    strictEqual(msgReq.url.split('?')[0], MSG_PATH);
    ok(msgReq.url.includes('receive_id_type=chat_id'), 'query 应带 receive_id_type');
    strictEqual(msgReq.body.receive_id, RECEIVE_ID);
    strictEqual(msgReq.body.msg_type, 'interactive');
    ok((msgReq.headers.authorization ?? '').startsWith('Bearer t-tenant-1'), '应带 Bearer token');
    const card = JSON.parse(msgReq.body.content);
    strictEqual(card.header.template, 'green');
    ok(card.elements.some((el) => el.tag === 'action' && el.actions[0].url === 'https://t.example.dev/?finish=s%3A3'), '应有 https 按钮');
    ok(card.elements.some((el) => el.tag === 'note' && el.elements[0].content.includes('写文档')), '应有元信息行');
    // 日志脱敏：appSecret / receiveId 原文不得出现。
    const logs = logger.lines.join('\n');
    ok(!logs.includes(APP_SECRET) && !logs.includes(RECEIVE_ID), '日志不得泄露 appSecret/receiveId');
    await mock.stop();
    cleanup();
  });

  await test('feishu-app：token 内存缓存命中（两次发送只取一次 token）', async () => {
    const { store, cleanup } = await setUp('fa2');
    const mock = createMockUpstream();
    tokenRoute(mock);
    msgRoute(mock, { status: 200, body: { code: 0, data: {} } });
    await mock.start();
    const clock = new FakeClock();
    const env = makeEnv({ store, cfg: appConfig(), clock, fetchImpl: rewriteFetch(mock) });
    const notice = buildNotice({ kind: 'completed', sessionId: 's', turn: 1, config: appConfig() });
    ok((await feishuAppChannel.send(feishuAppChannel.render(notice, env), env)).ok);
    await clock.advance(3600_000); // 1 小时 < expire 7200s − 300s 提前刷新窗
    ok((await feishuAppChannel.send(feishuAppChannel.render(notice, env), env)).ok);
    strictEqual(mock.requests.filter((r) => r.url === TOKEN_PATH).length, 1, '缓存命中不应重复取 token');
    // 缓存随 env 生命周期；过期（> expire-300s）后重新获取。
    await clock.advance(3800_000);
    ok((await feishuAppChannel.send(feishuAppChannel.render(notice, env), env)).ok);
    strictEqual(mock.requests.filter((r) => r.url === TOKEN_PATH).length, 2, '到期前 300s 应刷新 token');
    await mock.stop();
    cleanup();
  });

  await test('feishu-app：99991663 失效 → 清缓存重取并重试一次', async () => {
    const { store, cleanup } = await setUp('fa3');
    const mock = createMockUpstream();
    tokenRoute(mock);
    let msgCalls = 0;
    msgRoute(mock, (record, res) => {
      msgCalls += 1;
      const body = msgCalls === 1 ? { code: 99991663, msg: 'token invalid' } : { code: 0, data: { message_id: 'om_2' } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return mock.HANDLED;
    });
    await mock.start();
    const clock = new FakeClock();
    const env = makeEnv({ store, cfg: appConfig(), clock, fetchImpl: rewriteFetch(mock) });
    const notice = buildNotice({ kind: test, sessionId: 's', turn: 0, config: appConfig(), clickUrl: 'https://t.example.dev/?finish=test' });
    const result = await feishuAppChannel.send(feishuAppChannel.render(notice, env), env);
    ok(result.ok, JSON.stringify(result));
    strictEqual(mock.requests.filter((r) => r.url === TOKEN_PATH).length, 2, '失效后应重新取 token');
    strictEqual(mock.requests.filter((r) => r.url.split('?')[0] === MSG_PATH).length, 2, '消息应重试一次');
    const card = JSON.parse(mock.requests[3].body.content);
    strictEqual(card.header.template, 'blue', 'test kind 头部为 blue');
    await mock.stop();
    cleanup();
  });

  await test('feishu-app：卡片被拒 → 自动降级 text', async () => {
    const { store, cleanup } = await setUp('fa4');
    const mock = createMockUpstream();
    tokenRoute(mock);
    msgRoute(mock, (record, res) => {
      const rejected = record.body.msg_type === 'interactive';
      const body = rejected ? { code: 230001, msg: 'card size invalid' } : { code: 0, data: { message_id: 'om_3' } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return mock.HANDLED;
    });
    await mock.start();
    const clock = new FakeClock();
    const env = makeEnv({ store, cfg: appConfig(), clock, fetchImpl: rewriteFetch(mock) });
    const notice = buildNotice({ kind: 'error', sessionId: 's', turn: 2, config: appConfig(), error: { message: 'boom' } });
    const result = await feishuAppChannel.send(feishuAppChannel.render(notice, env), env);
    ok(result.ok, JSON.stringify(result));
    strictEqual(result.note, 'card rejected, fell back to text');
    const msgs = mock.requests.filter((r) => r.url.split('?')[0] === MSG_PATH);
    strictEqual(msgs.length, 2);
    strictEqual(msgs[1].body.msg_type, 'text');
    ok(JSON.parse(msgs[1].body.content).text.includes('呜…出错了'));
    await mock.stop();
    cleanup();
  });

  await test('feishu-app：未配置 → isConfigured false / 跳过 / 零请求', async () => {
    const { store, cleanup } = makeStore('fa5'); // 不写 feishuApp 凭据
    const mock = createMockUpstream();
    await mock.start();
    const clock = new FakeClock();
    const env = makeEnv({ store, cfg: appConfig(), clock, fetchImpl: rewriteFetch(mock) });
    strictEqual(feishuAppChannel.isConfigured(env), false);
    deepStrictEqual(resolveChannelOrder(env).map((c) => c.id), [], '未配置不应进入 channelOrder');
    const result = await feishuAppChannel.send({ title: 't', body: 'b' }, env);
    strictEqual(result.ok, false);
    strictEqual(result.code, 'not-configured');
    strictEqual(mock.requests.length, 0, '不应发出任何请求');
    // 只给凭据、没给 receiveId 一样跳过。
    await saveChannelSecrets(store, { feishuApp: { appId: APP_ID, appSecret: APP_SECRET } });
    const envNoReceiveId = makeEnv({ store, cfg: { ...appConfig(), feishuAppReceiveId: '' }, clock, fetchImpl: rewriteFetch(mock) });
    strictEqual(feishuAppChannel.isConfigured(envNoReceiveId), false, '缺 receiveId 不算已配置');
    deepStrictEqual(resolveChannelOrder(envNoReceiveId).map((c) => c.id), [], '缺 receiveId 不进 channelOrder');
    await mock.stop();
    cleanup();
  });

  await test('feishu-app：clickUrl 仅 https 公网才进按钮', async () => {
    const { store, cleanup } = await setUp('fa6');
    const mock = createMockUpstream();
    tokenRoute(mock);
    msgRoute(mock, { status: 200, body: { code: 0, data: {} } });
    await mock.start();
    const clock = new FakeClock();
    const env = makeEnv({ store, cfg: appConfig(), clock, fetchImpl: rewriteFetch(mock) });
    const notice = buildNotice({ kind: 'completed', sessionId: 's', turn: 5, config: appConfig(), clickUrl: 'http://127.0.0.1:3080/?finish=s%3A5' });
    ok((await feishuAppChannel.send(feishuAppChannel.render(notice, env), env)).ok);
    const card = JSON.parse(mock.requests.at(-1).body.content);
    ok(!card.elements.some((el) => el.tag === 'action'), 'loopback clickUrl 不应有按钮');
    await mock.stop();
    cleanup();
  });

  await test('feishu-app：secretsView 掩码（末 4 位）且 channelOrder 可解析', async () => {
    const { store, cleanup } = await setUp('fa7');
    const cfg = appConfig();
    const view = secretsView(store, cfg);
    strictEqual(view.feishuApp.configured, true);
    strictEqual(view.feishuApp.appIdMasked, '…mple'); // cli_a9z0TestExample → 末 4 位
    strictEqual(view.feishuApp.receiveIdMasked, '…0001');
    const raw = JSON.stringify(view);
    ok(!raw.includes(APP_ID) && !raw.includes(APP_SECRET) && !raw.includes(RECEIVE_ID), '视图不得含原文');
    const mock = createMockUpstream();
    tokenRoute(mock);
    msgRoute(mock, { status: 200, body: { code: 0, data: {} } });
    await mock.start();
    const clock = new FakeClock();
    const env = makeEnv({ store, cfg, clock, fetchImpl: rewriteFetch(mock) });
    deepStrictEqual(resolveChannelOrder(env).map((c) => c.id), ['feishu-app']);
    // 开关关掉后不再解析。
    const envOff = makeEnv({ store, cfg: { ...cfg, feishuAppEnabled: false }, clock, fetchImpl: rewriteFetch(mock) });
    deepStrictEqual(resolveChannelOrder(envOff).map((c) => c.id), []);
    await mock.stop();
    cleanup();
  });
}

console.log('\n[6] HTTP 路由（真 http 上环回测）');
await test('/state 需要 same-origin；loopback 放行；资产无 token 可读', async () => {
  const { store, cleanup } = makeStore('rt1');
  const clock = new FakeClock();
  const ctx = mockCtx();
  const notifier = createNotifier({ ctx, config: config(), store, logger: consoleSilent(), timers: clock });
  const router = createRouter({ notifier, config: config(), store, ctx, logger: consoleSilent() });
  const server = createServer((req, res) => { router.handle(req, res, req.url).catch(() => res.destroy()); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // 无浏览器头 + loopback → 放行。
  let response = await fetch(`${base}/api/finish-notify/state`);
  strictEqual(response.status, 200);
  const state = await response.json();
  ok(state.assetToken);
  ok(state.channels.feishu.capabilities.transport === 'feishu-webhook');
  // v2.3：feishu-app 出现在 /state（默认未启用未配置）。
  strictEqual(state.channels['feishu-app'].capabilities.transport, 'feishu-app');
  strictEqual(state.channels['feishu-app'].configured, false);
  strictEqual(state.secrets.feishuApp.configured, false);
  // 跨源 Origin + same-site sec-fetch → 拒绝。
  response = await fetch(`${base}/api/finish-notify/state`, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' } });
  strictEqual(response.status, 403);
  // 资产：存在、MIME 正确。
  response = await fetch(`${base}/api/finish-notify/assets/icon-192.png`);
  strictEqual(response.status, 200);
  strictEqual(response.headers.get('content-type'), 'image/png');
  // 穿越防护。
  response = await fetch(`${base}/api/finish-notify/assets/../package.json`);
  ok([403, 404].includes(response.status));
  // sw.js 与 manifest。
  response = await fetch(`${base}/api/finish-notify/sw.js`);
  strictEqual(response.headers.get('content-type').includes('javascript'), true);
  const swText = await response.text();
  ok(swText.includes("addEventListener('push'"));
  response = await fetch(`${base}/api/finish-notify/manifest.webmanifest`);
  const manifest = await response.json();
  strictEqual(manifest.icons.length, 3);
  // 错误 token 拒绝。
  response = await fetch(`${base}/api/finish-notify/assets/icon-192.png?t=bad`);
  strictEqual(response.status, 404);
  await new Promise((r) => server.close(r));
  notifier.dispose();
  cleanup();
});
await test('/secrets 保存校验 + /test 鉴权 + PATCH /config 持久化', async () => {
  const { store, cleanup } = makeStore('rt2');
  const clock = new FakeClock();
  const ctx = mockCtx();
  const notifier = createNotifier({ ctx, config: config(), store, logger: consoleSilent(), timers: clock });
  const router = createRouter({ notifier, config: config(), store, ctx, logger: consoleSilent() });
  const server = createServer((req, res) => { router.handle(req, res, req.url).catch(() => res.destroy()); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // 非飞书 webhook 被拒。
  let response = await fetch(`${base}/api/finish-notify/secrets`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feishu: { webhook: 'https://evil.example/hook' } }),
  });
  strictEqual(response.status, 400);
  // 合法 webhook 保存成功且返回不含原文。
  response = await fetch(`${base}/api/finish-notify/secrets`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feishu: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/zzz' } }),
  });
  strictEqual(response.status, 200);
  const saved = await response.json();
  ok(saved.secrets.feishu.configured);
  ok(!JSON.stringify(saved).includes('hook/zzz'), '响应不得回显 webhook 原文');
  strictEqual(store.secrets.read().feishu.webhook, 'https://open.feishu.cn/open-apis/bot/v2/hook/zzz');
  // feishuApp：保存成功、视图掩码、不回显原文；空字段不改动；clear 整体清除。
  response = await fetch(`${base}/api/finish-notify/secrets`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feishuApp: { appId: 'cli_routerTestExample', appSecret: 'sec_routerTestSecret01' } }),
  });
  strictEqual(response.status, 200);
  const savedApp = await response.json();
  strictEqual(savedApp.secrets.feishuApp.hasCredentials, true);
  ok(!JSON.stringify(savedApp).includes('sec_routerTestSecret01'), '响应不得回显 appSecret 原文');
  ok(!JSON.stringify(savedApp).includes('cli_routerTestExample'), '响应不得回显 appId 原文');
  // 只改 appSecret 不动 appId。
  await fetch(`${base}/api/finish-notify/secrets`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feishuApp: { appSecret: 'sec_routerTestSecret02' } }),
  });
  strictEqual(store.secrets.read().feishuApp.appId, 'cli_routerTestExample');
  // 格式非法拒绝。
  response = await fetch(`${base}/api/finish-notify/secrets`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feishuApp: { appId: 'bad id with spaces!' } }),
  });
  strictEqual(response.status, 400);
  // clear 清除全部。
  await fetch(`${base}/api/finish-notify/secrets`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feishuApp: { clear: true } }),
  });
  strictEqual(store.secrets.read().feishuApp, undefined);
  // PATCH /config：非法值回退 + 持久化覆盖。
  response = await fetch(`${base}/api/finish-notify/config`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ debounceMs: 250, ntfyPriority: 99 }),
  });
  const patched = await response.json();
  strictEqual(patched.config.debounceMs, 250);
  strictEqual(patched.config.ntfyPriority, DEFAULT_CONFIG.ntfyPriority, '越界回默认');
  ok(patched.issues.some((i) => i.key === 'ntfyPriority'));
  deepStrictEqual(store.configOverrides.read(), { debounceMs: 250, ntfyPriority: 99 });
  // 测试发送（未配置任何可用通道时 ok=false 且带错误码，不抛）。
  response = await fetch(`${base}/api/finish-notify/test`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'feishu' }),
  });
  strictEqual(response.status, 200);
  const testResult = await response.json();
  strictEqual(testResult.ok, false);
  // 未知通道。
  response = await fetch(`${base}/api/finish-notify/test`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'bark' }),
  });
  strictEqual((await response.json()).code, 'unknown-channel');
  // /pending：未来时间戳 → 空（之前的 /test 通知不回放）。
  response = await fetch(`${base}/api/finish-notify/pending?since=99999999999999`);
  deepStrictEqual((await response.json()).notices, []);
  await new Promise((r) => server.close(r));
  notifier.dispose();
  cleanup();
});
await test('SSE：hello → finish → degraded，心跳可关', async () => {
  const { store, cleanup } = makeStore('rt3');
  const clock = new FakeClock();
  const ctx = mockCtx();
  const notifier = createNotifier({ ctx, config: config(), store, logger: consoleSilent(), timers: clock });
  const emit = attach(ctx, notifier);
  const router = createRouter({ notifier, config: config(), store, ctx, logger: consoleSilent() });
  const server = createServer((req, res) => { router.handle(req, res, req.url).catch(() => res.destroy()); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const response = await fetch(`${base}/api/finish-notify/stream`, { signal: controller.signal });
  strictEqual(response.status, 200);
  ok(response.headers.get('content-type').includes('text/event-stream'));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const readFor = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r('timeout'), Math.max(50, deadline - Date.now())))]);
      if (chunk === 'timeout') break;
      if (chunk.done) break;
      seen += decoder.decode(chunk.value, { stream: true });
      if (seen.includes('event: hello')) return true;
    }
    return false;
  };
  const gotHello = await readFor(2000);
  ok(gotHello, `应收到 hello，实际：${seen.slice(0, 200)}`);
  // 触发一次完成事件 → SSE finish。
  emit({ id: 'r', header: {} }, 'turn/end', { turn: 9, reason: { kind: 'completed' } });
  await clock.advance(2000);
  const gotFinish = await (async () => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r('timeout'), Math.max(50, deadline - Date.now())))]);
      if (chunk === 'timeout') break;
      if (chunk.done) break;
      seen += decoder.decode(chunk.value, { stream: true });
      if (seen.includes('event: finish')) return true;
    }
    return false;
  })();
  ok(gotFinish, '应收到 finish');
  controller.abort();
  await new Promise((r) => server.close(r));
  notifier.dispose();
  cleanup();
});

console.log('\n[7] 依赖与结构');
await test('package.json 无运行时依赖 + files 覆盖入口', async () => {
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(`${ROOT}package.json`, 'utf8'));
  deepStrictEqual(pkg.dependencies ?? {}, {});
  for (const f of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) ok(pkg.files.includes(f), `files 缺 ${f}`);
  ok(pkg.dsh?.bundle?.patch === './cordis.patch.yml');
  ok(pkg.dsh?.client?.platform === 'web');
});
await test('webhook 校验防误填', () => {
  ok(!validateFeishuWebhook('javascript:alert(1)'));
  ok(!validateFeishuWebhook(''));
  ok(!validateFeishuWebhook('https://open.dingtalk.cn/webhook/x'));
});

// ---------- helpers ----------
function consoleSilent() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}
async function makeKeys() {
  const { createECDH } = await import('node:crypto');
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.from('aabbccddeeff0011');
  return {
    p256dh: Buffer.from(ua.getPublicKey(null, 'uncompressed')).toString('base64url'),
    auth: auth.toString('base64url'),
  };
}
function validateNoSecretLeak(mock, store) {
  const raw = JSON.stringify(mock.requests.map((r) => r.body));
  ok(!raw.includes('hook/'), 'webhook 片段不应出现在请求体外的记录');
}
console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) process.exit(1);
