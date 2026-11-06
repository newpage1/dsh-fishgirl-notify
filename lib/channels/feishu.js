// 飞书群自定义机器人通道：interactive 卡片（失败自动降级纯文本）。
// webhook 只存 secrets.json，日志/诊断永不出现原文。
import { feishuCode, logFields, requestWithRetry } from './util.js';
import { validateFeishuWebhook } from '../store.js';

/** kind → 卡片头部颜色模板（设计稿 6.2：成功 green / 失败 orange / 触顶 yellow / 中断 grey / 测试 blue）。 */
export const HEADER_TEMPLATE = {
  completed: 'green',
  error: 'orange',
  'max-tokens': 'yellow',
  interrupted: 'grey',
  test: 'blue',
};

/** kind → 按钮文案（设计稿 6.2）。 */
export const BUTTON_TEXT = {
  completed: '看肥鱼娘',
  error: '看看原因',
  'max-tokens': '看看结果',
  interrupted: '看肥鱼娘',
  test: '打开 DSH',
};

/** kind → 卡片正文行（设计稿 6.2）。 */
export const CARD_BODY_LINE = {
  completed: '这一轮完成啦，点开看看结果',
  error: '这一轮没跑完，点开看看原因',
  'max-tokens': '这一轮达到长度上限，点开看看结果',
  interrupted: '这一轮被中断了',
  test: '肥鱼娘在吗？点一下看看能不能回来～',
};

/** 卡片正文/按钮通用裁剪。 */
export const clipText = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 通知 → 通道载荷（feishu 与 feishu-app 共用；kind/metaLine 为通道展示用附加字段）。 */
export function renderNoticePayload(notice) {
  const payload = {
    title: notice.title,
    body: notice.body,
    kind: notice.kind,
    metaLine: notice.sessionTitle
      ? `${notice.sessionTitle}${notice.durationMs !== undefined ? ` · 用时 ${formatDur(notice.durationMs)}` : ''}`
      : (notice.durationMs !== undefined ? `这一轮 · 用时 ${formatDur(notice.durationMs)}` : undefined),
  };
  if (notice.clickUrl) payload.clickUrl = notice.clickUrl;
  if (notice.summary) payload.summary = notice.summary;
  if (notice.media?.image) payload.imageUrl = notice.media.image;
  return payload;
}

/**
 * 组装飞书 interactive 卡片对象（header + elements）。
 * clickUrl 由调用方决定（feishu 群机器人接受 https/loopback；feishu-app 仅 https 公网）。
 */
export function buildCardObject(payload, { maxBodyChars = 600, clickUrl, now = Date.now() } = {}) {
  const elements = [];
  if (payload.metaLine) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: payload.metaLine }] });
  }
  elements.push({ tag: 'div', text: { tag: 'plain_text', content: clipText(CARD_BODY_LINE[payload.kind] ?? payload.body, maxBodyChars) } });
  if (payload.summary) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `刚刚说：${clipText(payload.summary, maxBodyChars)}` }] });
  }
  if (clickUrl) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: BUTTON_TEXT[payload.kind] ?? '打开 DSH' },
        type: 'primary',
        url: clickUrl,
      }],
    });
  }
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: `DSH · 完成提醒 · ${new Date(now).toLocaleTimeString('zh-CN', { hour12: false })}` }],
  });
  return {
    header: { template: HEADER_TEMPLATE[payload.kind] ?? 'blue', title: { tag: 'plain_text', content: clipText(payload.title, 40) } },
    elements,
  };
}

/** 纯文本消息体（feishu 群 {text} 与 IM content {text} 共用）。 */
export function buildTextContent(payload) {
  return { text: `${payload.title}\n${payload.body}${payload.clickUrl ? `\n${payload.clickUrl}` : ''}` };
}

export const feishuChannel = {
  id: 'feishu',

  capabilities() {
    return {
      transport: 'feishu-webhook',
      fcmDependent: false,
      requiresClient: false,
      platforms: ['harmonyos', 'ios', 'android', 'desktop'],
      image: true,
      icon: false,
      maxTitleChars: 40,
      maxBodyChars: 600,
      requiresPublicOrigin: false,
      recommended: true,
    };
  },

  isConfigured(env) {
    const webhook = env.store.secrets.read()?.feishu?.webhook;
    return typeof webhook === 'string' && validateFeishuWebhook(webhook);
  },

  health(env, { force = false } = {}) {
    const now = env.now();
    const cached = env.healthCache.feishu;
    if (!force && cached && now - cached.checkedAt < env.config.healthCacheMs && cached.status !== 'pending') {
      return cached;
    }
    const entry = { status: 'not-configured', checkedAt: now, note: undefined };
    if (!this.isConfigured(env)) {
      env.healthCache.feishu = entry;
      return entry;
    }
    entry.status = 'pending';
    env.healthCache.feishu = entry;
    (async () => {
      const result = await requestWithRetry({
        url: env.store.secrets.read()?.feishu?.webhook,
        init: { method: 'GET' },
        timeoutMs: Math.min(env.config.requestTimeoutMs, 3000),
        retries: 0,
        fetchImpl: env.fetchImpl,
      });
      env.healthCache.feishu = {
        status: result.ok ? 'ok' : (result.code === 'timeout' || result.code === 'network' ? 'unreachable' : 'error'),
        checkedAt: env.now(),
        note: result.ok ? undefined : `probe ${result.code}${result.status ? ` (${result.status})` : ''}`,
      };
    })().catch(() => {
      env.healthCache.feishu = { status: 'error', checkedAt: env.now(), note: 'probe failed' };
    });
    return entry;
  },

  /** 纯函数：notice → 通道载荷（kind/metaLine 为通道展示用附加字段）。 */
  render(notice) {
    return renderNoticePayload(notice);
  },

  async send(payload, env) {
    const webhook = env.store.secrets.read()?.feishu?.webhook;
    if (!validateFeishuWebhook(webhook)) {
      return { channel: 'feishu', ok: false, code: 'not-configured', ms: 0 };
    }

    const buildCard = () => ({
      msg_type: 'interactive',
      card: buildCardObject(payload, {
        maxBodyChars: env.config.feishuMaxBodyChars,
        clickUrl: payload.clickUrl,
        now: env.now(),
      }),
    });

    const buildText = () => ({ msg_type: 'text', content: buildTextContent(payload) });

    const post = (body) => requestWithRetry({
      url: webhook,
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      timeoutMs: env.config.requestTimeoutMs,
      retries: env.config.retries,
      fetchImpl: env.fetchImpl,
    });

    if (env.config.feishuUseCard) {
      const cardResult = await post(buildCard());
      if (cardResult.ok && feishuCode(cardResult.bodyText) === 0) {
        return { channel: 'feishu', ok: true, code: 'ok', status: cardResult.status, ms: cardResult.ms };
      }
      // 卡片被群机器人拒绝（版本/格式原因）→ 自动降级纯文本重发一次。
      const cardRejected = cardResult.ok && feishuCode(cardResult.bodyText) !== 0;
      if (cardRejected) {
        const textResult = await post(buildText());
        const textOk = textResult.ok && feishuCode(textResult.bodyText) === 0;
        env.logger.info('feishu card degraded to text', logFields('feishu', webhook, textResult));
        return {
          channel: 'feishu', ok: textOk,
          code: textOk ? 'ok' : (textResult.code === 'ok' ? 'error' : textResult.code),
          status: textResult.status, ms: cardResult.ms + textResult.ms,
          note: 'card rejected, fell back to text',
        };
      }
      return {
        channel: 'feishu', ok: false,
        code: cardResult.code === 'ok' ? 'error' : cardResult.code,
        status: cardResult.status, ms: cardResult.ms,
      };
    }
    const textResult = await post(buildText());
    const textOk = textResult.ok && feishuCode(textResult.bodyText) === 0;
    return {
      channel: 'feishu', ok: textOk,
      code: textOk ? 'ok' : (textResult.code === 'ok' ? 'error' : textResult.code),
      status: textResult.status, ms: textResult.ms,
    };
  },
};

function formatDur(ms) {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`;
}
