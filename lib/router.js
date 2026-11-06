// HTTP 面：单条 prefix 路由 /api/finish-notify/*。
// 访问控制（非安全边界）：控制端点要求同源（Sec-Fetch-Site / Origin 校验），
// loopback 且 allowLoopbackControl 时放行无浏览器头的本地工具。
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from './config.js';
import { createLogger, endpointHost, redactUrl } from './logger.js';
import { allChannelDescriptors } from './channels/registry.js';
import {
  generateNtfyTopic, saveChannelSecrets, secretsView, validateFeishuWebhook, validateNtfyTopic,
} from './store.js';

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ASSETS_DIR = join(PLUGIN_ROOT, 'assets');
const ASSET_TOKEN = randomBytes(16).toString('hex');
const BODY_LIMIT = 64 * 1024;

const MIME = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

export function createRouter(opts) {
  const { notifier, config: initialConfig, store, ctx, logger = createLogger(null) } = opts;
  let config = initialConfig;
  const effectiveIssues = [];

  const setConfig = (next, issues = []) => {
    config = next;
    notifier.setConfig(next);
    effectiveIssues.length = 0;
    effectiveIssues.push(...issues);
  };
  setConfig(initialConfig);

  const readBody = (req) => new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        req.destroy();
        rejectBody(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });

  const parseJson = async (req) => {
    const text = await readBody(req);
    if (text === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('invalid json');
    }
  };

  const writeJson = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
  };

  const isLoopback = (req) => {
    const addr = req.socket?.remoteAddress ?? '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  };

  /** 同源栅栏：浏览器请求须 same-origin；非浏览器仅 loopback + allowLoopbackControl。 */
  const allowControl = (req) => {
    const site = req.headers['sec-fetch-site'];
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (site === 'same-origin' || site === 'same-site' || site === 'none') {
      if (!origin || !host || origin.replace(/^https?:\/\//, '').replace(/:\d+$/, '') === host.replace(/:\d+$/, '')) {
        return true;
      }
    }
    if (!site && !origin && isLoopback(req) && config.allowLoopbackControl !== false) return true;
    if (!site && origin && isLoopback(req) && config.allowLoopbackControl !== false) {
      try {
        if (new URL(origin).host === host) return true;
      } catch { /* fallthrough */ }
    }
    return false;
  };

  const serveAsset = (res, file) => {
    const safeRoot = resolve(ASSETS_DIR);
    const target = resolve(safeRoot, file);
    if (!target.startsWith(safeRoot)) return false;
    if (!existsSync(target) || !statSync(target).isFile()) return false;
    const type = MIME[extname(target).toLowerCase()];
    if (!type) return false;
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'private, max-age=604800',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(target).pipe(res);
    return true;
  };

  const publicOrigin = () => notifier.getState().publicOrigin;

  const handleAssets = (req, res, rest) => {
    const [, query] = (req.url ?? '').split('?');
    const params = new URLSearchParams(query ?? '');
    const token = params.get('t');
    if (token && token !== ASSET_TOKEN) {
      writeJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    const file = rest.replace(/^assets\//, '');
    if (!serveAsset(res, file)) writeJson(res, 404, { ok: false, error: 'not found' });
  };

  const handleSw = (res) => {
    const sw = `
// dsh-finish-notify Service Worker（scope = /api/finish-notify/）
self.addEventListener('install', (event) => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || '做好啦～';
  const options = {
    body: data.body || '',
    tag: data.tag || 'dsh-finish-notify',
    renotify: true,
    data: { url: data.url || '/' },
  };
  if (data.icon) options.icon = data.icon;
  if (data.image) options.image = data.image;
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) { client.postMessage({ type: 'finish-notify:click', url }); return client.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
`;
    res.writeHead(200, {
      'content-type': MIME['.js'],
      'cache-control': 'no-cache',
      'service-worker-allowed': '/api/finish-notify/',
    });
    res.end(sw);
  };

  const handleManifest = (res) => {
    const origin = publicOrigin();
    const icon = (name, sizes, purpose) => ({
      src: origin ? `${origin}/api/finish-notify/assets/${name}?t=${ASSET_TOKEN}` : `/api/finish-notify/assets/${name}?t=${ASSET_TOKEN}`,
      sizes,
      type: 'image/png',
      ...(purpose ? { purpose } : {}),
    });
    const manifest = {
      name: 'DSH 完成提醒（肥鱼娘）',
      short_name: 'DSH 提醒',
      start_url: '/',
      display: 'standalone',
      background_color: '#0F1115',
      theme_color: '#0F1115',
      icons: [
        icon('icon-192.png', '192x192'),
        icon('icon-512.png', '512x512'),
        icon('icon-maskable-512.png', '512x512', 'maskable'),
      ],
    };
    res.writeHead(200, { 'content-type': MIME['.webmanifest'], 'cache-control': 'no-store' });
    res.end(JSON.stringify(manifest));
  };

  const handleStream = (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const client = {
      write(event, data) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      close() {
        try { res.end(); } catch { /* 已断开 */ }
      },
    };
    client.write('hello', {
      assetToken: ASSET_TOKEN,
      publicOrigin: publicOrigin(),
      vapidPublicKey: notifier.getState().vapidPublicKey,
      pagePopupEnabled: config.pagePopupEnabled,
    });
    notifier.sseClients.add(client);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* 断开 */ }
    }, 15000);
    req.on('close', () => {
      clearInterval(ping);
      notifier.sseClients.delete(client);
    });
  };

  const handleState = (res) => {
    const state = notifier.getState();
    writeJson(res, 200, {
      ...state,
      assetToken: ASSET_TOKEN,
      config: publicConfigView(config),
      configIssues: effectiveIssues,
      channels: allChannelDescriptors(notifier.env),
      secrets: secretsView(store, config),
    });
  };

  const handleConfigPatch = async (req, res) => {
    let patch;
    try {
      patch = await parseJson(req);
    } catch (error) {
      writeJson(res, 400, { ok: false, error: error.message });
      return;
    }
    const merged = { ...config, ...patch };
    const { value, issues } = normalizeConfig(merged);
    setConfig(value, issues);
    await store.configOverrides.replace(patch);
    writeJson(res, 200, { ok: true, issues, config: publicConfigView(value) });
  };

  const handleSecretsPost = async (req, res) => {
    let body;
    try {
      body = await parseJson(req);
    } catch (error) {
      writeJson(res, 400, { ok: false, error: error.message });
      return;
    }
    const patch = {};
    const errors = [];
    if (body.feishu) {
      const webhook = String(body.feishu.webhook ?? '').trim();
      const secret = String(body.feishu.secret ?? '').trim();
      if (webhook === '') patch.feishu = { webhook: '', secret: '' };
      else if (validateFeishuWebhook(webhook)) patch.feishu = { webhook, secret };
      else errors.push('feishu webhook 必须是 https://open.feishu.cn/... 形式的飞书地址');
    }
    if (body.ntfy) {
      let topic = String(body.ntfy.topic ?? '').trim();
      const token = String(body.ntfy.token ?? '').trim();
      if (topic === 'auto' || body.ntfy.generateTopic === true) topic = generateNtfyTopic();
      if (topic === '') patch.ntfy = { topic: '', token: '' };
      else if (validateNtfyTopic(topic)) patch.ntfy = { topic, token };
      else errors.push('ntfy topic 只能含字母数字-_（≤64 字符）');
    }
    if (body.feishuApp) {
      if (body.feishuApp.clear === true) {
        patch.feishuApp = { appId: '', appSecret: '' };
      } else {
        const appId = String(body.feishuApp.appId ?? '').trim();
        const appSecret = String(body.feishuApp.appSecret ?? '').trim();
        // 空字符串 = 该字段不改动（避免只改一项时把另一项清掉）；clear 才整体清除。
        const appIdOk = appId === '' || /^[A-Za-z0-9_-]{1,64}$/.test(appId);
        const appSecretOk = appSecret === '' || appSecret.length <= 128;
        if (appIdOk && appSecretOk) {
          patch.feishuApp = {
            ...(appId === '' ? {} : { appId }),
            ...(appSecret === '' ? {} : { appSecret }),
          };
        } else {
          errors.push('feishuApp appId/appSecret 格式不正确');
        }
      }
    }
    if (errors.length > 0) {
      writeJson(res, 400, { ok: false, errors });
      return;
    }
    if (patch.feishuApp && Object.keys(patch.feishuApp).length === 0) delete patch.feishuApp;
    if (Object.keys(patch).length === 0) {
      writeJson(res, 400, { ok: false, errors: ['没有可保存的字段'] });
      return;
    }
    await saveChannelSecrets(store, patch);
    logger.info('secrets updated', { fields: Object.keys(patch) });
    writeJson(res, 200, { ok: true, secrets: secretsView(store, config) });
  };

  const handleDiagnostics = (res, force) => {
    const state = notifier.getState();
    const vapidFp = state.vapidPublicKey
      ? createHash('sha256').update(state.vapidPublicKey).digest('hex').slice(0, 8)
      : undefined;
    writeJson(res, 200, {
      ok: true,
      version: 2,
      plugin: 'dsh-fishgirl-notify',
      publicOrigin: state.publicOrigin ? redactUrl(state.publicOrigin) : undefined,
      swScope: '/api/finish-notify/',
      vapidFingerprint: vapidFp,
      subscriptions: state.subscriptions.length,
      configIssues: effectiveIssues,
      channels: allChannelDescriptors(notifier.env, { force }),
      recentDeliveries: notifier.getRecentDeliveries(),
      lastDegraded: state.lastDegraded,
      quietHours: config.quietEnabled ? `${config.quietStart}–${config.quietEnd}` : undefined,
      pageVisible: state.pageVisible,
      generatedAt: Date.now(),
    });
  };

  /** @returns {boolean} handled */
  const handle = async (req, res, path) => {
    const [pathname, query] = (req.url ?? '').split('?');
    const rest = pathname.replace(/^\/api\/finish-notify\/?/, '');
    const first = rest.split('/')[0] ?? '';
    const method = req.method ?? 'GET';

    // 只读面：不需要控制权限。
    if (first === 'sw.js' && method === 'GET') { handleSw(res); return true; }
    if (first === 'manifest.webmanifest' && method === 'GET') { handleManifest(res); return true; }
    if (first === 'assets') { handleAssets(req, res, rest); return true; }
    if (first === 'health' && method === 'GET') {
      const params = new URLSearchParams(query ?? '');
      writeJson(res, 200, { ok: true, channels: allChannelDescriptors(notifier.env) });
      return true;
    }
    if (first === 'diagnostics' && method === 'GET') {
      const params = new URLSearchParams(query ?? '');
      handleDiagnostics(res, params.get('force') === '1');
      return true;
    }

    // 控制面：同源栅栏。
    if (!allowControl(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden: same-origin only' });
      return true;
    }
    if (rest === '' || rest === 'state') {
      if (method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method not allowed' }); return true; }
      handleState(res);
      return true;
    }
    if (first === 'stream' && method === 'GET') { handleStream(req, res); return true; }
    if (first === 'pending' && method === 'GET') {
      const params = new URLSearchParams(query ?? '');
      const since = Number(params.get('since') ?? '0') || 0;
      writeJson(res, 200, { ok: true, notices: notifier.getPending(since) });
      return true;
    }
    if (first === 'presence' && method === 'POST') {
      const body = await parseJson(req).catch(() => ({}));
      notifier.setPresence({ visible: body.visible === true, href: typeof body.href === 'string' ? body.href : undefined });
      writeJson(res, 200, { ok: true });
      return true;
    }
    if (first === 'subscribe' && method === 'POST') {
      const body = await parseJson(req).catch(() => null);
      const sub = body?.subscription;
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)
        || !sub.keys?.p256dh || !sub.keys?.auth) {
        writeJson(res, 400, { ok: false, error: 'invalid subscription' });
        return true;
      }
      await notifier.addSubscription({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        origin: typeof body.origin === 'string' ? body.origin : endpointHost(sub.endpoint),
        returnUrl: typeof body.returnUrl === 'string' ? body.returnUrl : undefined,
      });
      writeJson(res, 200, { ok: true, vapidPublicKey: notifier.getState().vapidPublicKey });
      return true;
    }
    if (first === 'unsubscribe' && method === 'POST') {
      const body = await parseJson(req).catch(() => null);
      if (typeof body?.endpoint !== 'string') {
        writeJson(res, 400, { ok: false, error: 'endpoint required' });
        return true;
      }
      await notifier.removeSubscription(body.endpoint);
      writeJson(res, 200, { ok: true });
      return true;
    }
    if (first === 'test' && method === 'POST') {
      const body = await parseJson(req).catch(() => ({}));
      const channel = typeof body.channel === 'string' ? body.channel : 'all';
      const result = await notifier.sendTest(channel);
      writeJson(res, 200, { ok: result.ok, ...result });
      return true;
    }
    if ((first === 'config') && (method === 'PATCH' || method === 'POST')) {
      await handleConfigPatch(req, res);
      return true;
    }
    if (first === 'config' && method === 'GET') {
      writeJson(res, 200, { ok: true, config: publicConfigView(config), issues: effectiveIssues });
      return true;
    }
    if (first === 'secrets' && method === 'POST') {
      await handleSecretsPost(req, res);
      return true;
    }
    writeJson(res, 404, { ok: false, error: 'not found' });
    return true;
  };

  return { handle, ASSET_TOKEN };
}

/** 配置的非敏感视图（凭证永不出现在配置里）。 */
function publicConfigView(config) {
  return { ...config };
}
