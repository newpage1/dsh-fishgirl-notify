// dsh-finish-notify 宿主入口：
//  - 监听 session/event（turn/end）→ 通知管线（手机推送 + 页内动效 SSE）
//  - 暴露 /api/finish-notify/* HTTP 面（state/stream/subscribe/test/assets/sw.js/…）
// 一切失败只记录，绝不阻塞会话。
import { normalizeConfig } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { createStore } from './lib/store.js';
import { createNotifier } from './lib/notifier.js';
import { createRouter } from './lib/router.js';

export const inject = ['webServer'];

export function apply(ctx, rawConfig = {}) {
  const logger = createLogger(ctx.logger);
  let store;
  try {
    store = createStore();
  } catch (error) {
    logger.error('data dir unavailable, plugin inactive', { error: error?.message });
    return () => {};
  }

  // 配置三层合并：装载层 config ← ${dataDir}/config.json 覆盖 ← 默认值兜底。
  let overrides = {};
  try {
    overrides = store.configOverrides.read() ?? {};
  } catch { /* 损坏则忽略 */ }
  const { value: config, issues } = normalizeConfig({ ...(rawConfig ?? {}), ...overrides });
  if (issues.length > 0) {
    logger.warn('config normalized with fallbacks', { issues: issues.map((i) => i.key).join(',') });
  }

  let webApp;
  try {
    webApp = ctx.get('webApp', false);
  } catch { webApp = undefined; }
  const getAdvertisedUrl = () => {
    try { return typeof webApp?.getAdvertisedUrl === 'function' ? webApp.getAdvertisedUrl() : undefined; } catch { return undefined; }
  };

  const notifier = createNotifier({ ctx, config, store, logger, getAdvertisedUrl });
  const router = createRouter({ notifier, config, store, ctx, logger });

  const disposers = [];

  // 1) HTTP 路由（重复注册会抛错：例如热重载后旧路由未释放——只记录一次）。
  try {
    const route = ctx.webServer.register({
      kind: 'prefix',
      path: '/api/finish-notify',
      handler: (req, res) => {
        return router.handle(req, res, req.url ?? '/').catch((error) => {
          logger.warn('router error', { error: error?.message ?? String(error) });
          try {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'internal' }));
          } catch { /* 已断开 */ }
        });
      },
    });
    disposers.push(() => { try { route?.dispose?.(); } catch { /* 已释放 */ } });
  } catch (error) {
    logger.error('webServer register failed', { error: error?.message ?? String(error) });
  }

  // 2) 完成事件。
  try {
    const off = ctx.on('session/event', (session, event) => notifier.handleEvent(session, event));
    disposers.push(() => { try { off?.(); } catch { /* 已释放 */ } });
  } catch (error) {
    logger.error('session/event subscribe failed', { error: error?.message ?? String(error) });
  }

  // 3) index 注入：PWA manifest + iOS 图标 + 标题（不改变 display 行为）。
  try {
    const off = ctx.on('webserver/index-inject', (rows) => {
      if (!Array.isArray(rows)) return;
      rows.push({ kind: 'html', placement: 'head', html: '<link rel="manifest" href="/api/finish-notify/manifest.webmanifest">' });
      rows.push({ kind: 'html', placement: 'head', html: `<link rel="apple-touch-icon" href="/api/finish-notify/assets/apple-touch-icon-180.png?t=${router.ASSET_TOKEN}">` });
      rows.push({ kind: 'html', placement: 'head', html: '<meta name="apple-mobile-web-app-title" content="DSH 提醒">' });
    });
    disposers.push(() => { try { off?.(); } catch { /* 已释放 */ } });
  } catch (error) {
    logger.debug('index-inject unavailable', { error: error?.message });
  }

  logger.info('plugin ready', { dataDir: store.dir, channels: Array.isArray(config.channelOrder) ? config.channelOrder.join(',') : '' });

  const cleanup = () => {
    for (const dispose of disposers) dispose();
    try { notifier.dispose(); } catch { /* 防御 */ }
  };
  try {
    ctx.effect(cleanup);
  } catch { /* 非 cordis 宿主（测试 mock）时仅返回清理 */ }
  return cleanup;
}
