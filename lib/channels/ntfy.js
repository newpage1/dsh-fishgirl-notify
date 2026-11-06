// ntfy 通道：POST / JSON 发布（自建或 ntfy.sh 公共服务器）。
// 鸿蒙手机可经卓易通装安卓版 ntfy App 订阅 topic；topic 视为敏感串只存 secrets.json。
import { logFields, requestWithRetry } from './util.js';

/** kind → 附加 emoji tag。 */
const KIND_TAG = {
  completed: 'tada',
  error: 'warning',
  'max-tokens': 'hourglass',
  interrupted: 'zzz',
  test: 'loudspeaker',
};

const NTFY_TEST_BODY = '收到这条，就说明 ntfy 通啦';

export const ntfyChannel = {
  id: 'ntfy',

  capabilities() {
    return {
      transport: 'ntfy',
      fcmDependent: false,
      requiresClient: false,
      platforms: ['harmonyos', 'android', 'ios', 'desktop'],
      image: true,
      icon: true,
      maxTitleChars: 64,
      maxBodyChars: 512,
      requiresPublicOrigin: false,
      recommended: true,
    };
  },

  isConfigured(env) {
    const topic = env.store.secrets.read()?.ntfy?.topic;
    return typeof topic === 'string' && topic !== '' && typeof env.config.ntfyServer === 'string' && env.config.ntfyServer !== '';
  },

  health(env, { force = false } = {}) {
    const now = env.now();
    const cached = env.healthCache.ntfy;
    if (!force && cached && now - cached.checkedAt < env.config.healthCacheMs && cached.status !== 'pending') {
      return cached;
    }
    const entry = { status: 'not-configured', checkedAt: now, note: undefined };
    if (!this.isConfigured(env)) {
      env.healthCache.ntfy = entry;
      return entry;
    }
    entry.status = 'pending';
    env.healthCache.ntfy = entry;
    (async () => {
      const result = await requestWithRetry({
        url: `${env.config.ntfyServer}/v1/health`,
        init: { method: 'GET' },
        timeoutMs: Math.min(env.config.requestTimeoutMs, 3000),
        retries: 0,
        fetchImpl: env.fetchImpl,
      });
      let healthy = false;
      if (result.ok) {
        try { healthy = JSON.parse(result.bodyText || '{}').healthy === true; } catch { healthy = false; }
      }
      env.healthCache.ntfy = {
        status: healthy ? 'ok' : (result.ok ? 'error' : (result.code === 'timeout' || result.code === 'network' ? 'unreachable' : 'error')),
        checkedAt: env.now(),
        note: healthy ? undefined : `health ${result.code}${result.status ? ` (${result.status})` : ''}`,
      };
    })().catch(() => {
      env.healthCache.ntfy = { status: 'error', checkedAt: env.now(), note: 'health check failed' };
    });
    return entry;
  },

  render(notice, env) {
    const lines = [];
    if (notice.sessionTitle || notice.durationMs !== undefined) {
      const parts = [];
      if (notice.sessionTitle) parts.push(notice.sessionTitle);
      if (notice.durationMs !== undefined) parts.push(`用时 ${formatDur(notice.durationMs)}`);
      lines.push(parts.join(' · '));
    }
    lines.push(notice.kind === 'test' ? NTFY_TEST_BODY : notice.body);
    if (notice.summary) lines.push(`刚刚说：${notice.summary}`);
    const payload = {
      title: notice.title,
      body: lines.join('\n'),
      kind: notice.kind,
      tags: [...(env.config.ntfyTags ?? []), KIND_TAG[notice.kind]].filter(Boolean),
    };
    if (notice.clickUrl) payload.clickUrl = notice.clickUrl;
    if (notice.summary) payload.summary = notice.summary;
    if (notice.media?.icon) payload.iconUrl = notice.media.icon;
    if (notice.media?.image) payload.imageUrl = notice.media.image;
    return payload;
  },

  async send(payload, env) {
    const secrets = env.store.secrets.read()?.ntfy;
    const topic = secrets?.topic;
    if (!this.isConfigured(env)) {
      return { channel: 'ntfy', ok: false, code: 'not-configured', ms: 0 };
    }
    // message ≤512：截断顺序 summary → 正文（此处 message 已合成，整体裁剪即可）。
    const message = payload.body.length > 512 ? `${payload.body.slice(0, 511)}…` : payload.body;
    const json = {
      topic,
      title: payload.title.slice(0, 64),
      message,
      priority: env.config.ntfyPriority,
      tags: payload.tags,
    };
    if (payload.clickUrl) json.click = payload.clickUrl;
    // icon 必须是绝对 URL（相对路径对 ntfy 服务器无意义；无公网 origin 时省略）。
    const iconPath = env.config.ntfyIconPath || noticeMediaIcon(payload);
    const absoluteIcon = toAbsoluteUrl(iconPath, env.publicOrigin);
    if (absoluteIcon) json.icon = absoluteIcon;

    const headers = { 'content-type': 'application/json' };
    if (secrets.token) headers.authorization = `Bearer ${secrets.token}`;
    const result = await requestWithRetry({
      url: `${env.config.ntfyServer}`,
      init: { method: 'POST', headers, body: JSON.stringify(json) },
      timeoutMs: env.config.requestTimeoutMs,
      retries: env.config.retries,
      retryDelayMs: 500,
      retryOn429: true,
      fetchImpl: env.fetchImpl,
    });
    env.logger.debug('ntfy send', logFields('ntfy', env.config.ntfyServer, result));
    return {
      channel: 'ntfy', ok: result.ok,
      code: result.ok ? 'ok' : result.code,
      status: result.status, ms: result.ms,
    };
  },
};

function noticeMediaIcon(payload) {
  return payload.iconUrl ?? '';
}

/** 相对路径 → 绝对 URL；只有 https 或环回 http 的 origin 才可用。 */
export function toAbsoluteUrl(path, origin) {
  if (!path || !origin) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  try {
    const base = new URL(origin);
    if (base.protocol !== 'https:' && !isLoopbackHost(base.hostname)) return undefined;
    return new URL(path, base).toString();
  } catch {
    return undefined;
  }
}

export function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function formatDur(ms) {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`;
}
