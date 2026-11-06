// Web Push 通道（参考实现）：VAPID ES256 + RFC 8291 aes128gcm，纯 node:crypto。
// Android Chrome / 桌面可用；HarmonyOS NEXT 浏览器不支持时由客户端在 UI 明示。
import { logFields, requestWithRetry } from './util.js';
import { readSubscriptions, writeSubscriptions } from '../store.js';
import {
  buildVapidAuthorization, encryptPayload, generateVapidKeys, loadVapidKey,
} from '../webpush/crypto.js';

const MAX_CIPHERTEXT_BYTES = 3072;
const DEFAULT_VAPID_SUBJECT = 'mailto:finish-notify@dsh.local';

export const webpushChannel = {
  id: 'webpush',

  capabilities() {
    return {
      transport: 'webpush',
      fcmDependent: true,
      requiresClient: true,
      platforms: ['android', 'desktop'],
      image: false,
      icon: true,
      maxTitleChars: 64,
      maxBodyChars: 200,
      requiresPublicOrigin: true,
      recommended: false,
    };
  },

  /** vapid.json 存在且可加载，且至少有一条订阅。 */
  isConfigured(env) {
    return this.vapidKey(env) !== undefined && readSubscriptions(env.store).length > 0;
  },

  /** 取（或惰性生成并持久化）VAPID 密钥；send/health 都可能触发。 */
  vapidKey(env) {
    const loaded = loadVapidKey(env.store.vapid.read());
    if (loaded) return loaded;
    const fresh = generateVapidKeys(DEFAULT_VAPID_SUBJECT);
    env.store.vapid.replace(fresh).catch(() => { /* 下次再试 */ });
    return { key: loadVapidKey(fresh).key, publicKeyB64url: fresh.publicKeyB64url, subject: fresh.subject };
  },

  health(env, { force = false } = {}) {
    const now = env.now();
    const cached = env.healthCache.webpush;
    if (!force && cached && now - cached.checkedAt < env.config.healthCacheMs && cached.status !== 'pending') {
      return cached;
    }
    const subs = readSubscriptions(env.store);
    const key = this.vapidKey(env);
    let status;
    let note;
    if (subs.length === 0) {
      status = 'not-configured';
      note = '暂无订阅（手机页面打开后可授权订阅）';
    } else if (!key) {
      status = 'error';
      note = 'VAPID 密钥不可用';
    } else if (!env.publicOrigin || !/^https:/.test(env.publicOrigin)) {
      status = 'degraded';
      note = '需要 https 公网 origin（隧道未就绪或为本地 http）';
    } else {
      status = 'ok';
    }
    const entry = { status, checkedAt: now, note, subscriptions: subs.length };
    env.healthCache.webpush = entry;
    return entry;
  },

  render(notice, env) {
    const payload = {
      title: notice.title,
      body: notice.body,
      kind: notice.kind,
      noticeId: notice.id,
      tag: notice.tag,
    };
    if (notice.clickUrl) payload.url = notice.clickUrl;
    if (notice.summary) payload.summary = notice.summary;
    // icon/image 仅在可绝对化（https origin）时带上。
    const icon = toAbs(notice.media?.icon, env.publicOrigin);
    const image = toAbs(notice.media?.image, env.publicOrigin);
    if (icon) payload.icon = icon;
    if (image) payload.image = image;
    return payload;
  },

  /** 逐订阅发送；返回 ChannelResult 数组（调用方聚合）。 */
  async send(payload, env) {
    const vapid = this.vapidKey(env);
    const subscriptions = readSubscriptions(env.store);
    if (!vapid || subscriptions.length === 0) {
      return [{ channel: 'webpush', ok: false, code: 'not-configured', ms: 0 }];
    }
    const deadEndpoints = [];
    let body = JSON.stringify(payload);
    const results = [];
    const markOk = [];
    for (const subscription of subscriptions) {
      let attempt = 0;
      let trimmed = false;
      // 413 最多裁剪重发一次。
      for (;;) {
        let ciphertext;
        try {
          ciphertext = encryptPayload(subscription, body);
        } catch (error) {
          results.push({ channel: 'webpush', ok: false, code: 'error', ms: 0, note: `encrypt failed: ${error?.message ?? 'unknown'}` });
          break;
        }
        if (ciphertext.length > MAX_CIPHERTEXT_BYTES && !trimmed) {
          body = JSON.stringify(trimPayload(payload));
          trimmed = true;
          continue;
        }
        const authorization = buildVapidAuthorization(
          subscription.endpoint, vapid, env.config.vapidSubject || vapid.subject || DEFAULT_VAPID_SUBJECT, env.now(),
        );
        const result = await requestWithRetry({
          url: subscription.endpoint,
          init: {
            method: 'POST',
            headers: {
              'content-type': 'application/octet-stream',
              'content-encoding': 'aes128gcm',
              ttl: String(env.config.pushTtlSeconds),
              urgency: env.config.pushUrgency,
              authorization,
            },
            body: ciphertext,
          },
          timeoutMs: env.config.requestTimeoutMs,
          retries: 0, // push service 逐订阅不重试，避免放大
          fetchImpl: env.fetchImpl,
        });
        env.logger.debug('webpush push', logFields('webpush', subscription.endpoint, result));
        if (result.ok) {
          markOk.push(subscription.endpoint);
          results.push({ channel: 'webpush', ok: true, code: 'ok', status: result.status, ms: result.ms });
        } else if (result.status === 404 || result.status === 410) {
          deadEndpoints.push(subscription.endpoint);
          results.push({ channel: 'webpush', ok: false, code: 'gone', status: result.status, ms: result.ms, note: 'subscription expired, removed' });
        } else if (result.status === 413 && !trimmed) {
          body = JSON.stringify(trimPayload(payload));
          trimmed = true;
          continue;
        } else {
          results.push({ channel: 'webpush', ok: false, code: result.code, status: result.status, ms: result.ms });
        }
        break;
      }
      attempt += 1;
      if (attempt > 4) break; // 保险
    }
    // 持久化订阅状态变化：成功刷新 lastOkAt；410/404 剔除。
    if (markOk.length > 0 || deadEndpoints.length > 0) {
      const next = readSubscriptions(env.store)
        .filter((s) => !deadEndpoints.includes(s.endpoint))
        .map((s) => (markOk.includes(s.endpoint) ? { ...s, lastOkAt: env.now(), failCount: 0 } : s));
      await writeSubscriptions(env.store, next);
    }
    return results;
  },
};

/** 413 裁剪：摘要 → 图片 → 正文截断（返回新的纯 payload 对象）。 */
function trimPayload(payload) {
  const next = { ...payload };
  delete next.summary;
  delete next.image;
  if (next.body && next.body.length > 120) next.body = `${next.body.slice(0, 119)}…`;
  return next;
}

function toAbs(path, origin) {
  if (!path || !origin) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  try {
    const base = new URL(origin);
    if (base.protocol !== 'https:') return undefined;
    return new URL(path, base).toString();
  } catch {
    return undefined;
  }
}
