// dsh-finish-notice 组装：文案模板、时长、错误码映射、clickUrl 与载荷 schema。
// 纯函数集合，测试直接覆盖。

export const NOTICE_VERSION = 2;

/** reason.kind → 提醒档位；aborted/blocked/forked 一律不打扰。 */
export function kindFromReason(kind) {
  switch (kind) {
    case 'completed': return 'completed';
    case 'error': return 'error';
    case 'max-tokens': return 'max-tokens';
    case 'interrupted': return 'interrupted';
    default: return undefined; // aborted / blocked / forked / 未知
  }
}

/** 错误短词映射：只渲染人类可读短词，绝不透传原始错误串。 */
export function shortErrorCode(kind, error) {
  if (kind !== 'error') return undefined;
  const message = typeof error === 'string' ? error : error?.message ?? '';
  const lower = String(message).toLowerCase();
  if (lower.includes('etimedout') || lower.includes('timeout') || lower.includes('超时')) return '超时';
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('限流')) return '限流';
  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('forbidden')) return '没权限';
  return '出错了';
}

/** 时长中文：48 秒 / 2 分 13 秒。 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}

/**
 * 模板渲染：{key} 有值则替换；未知变量原样保留并记入 unknown（debug 用）。
 * @returns {{ text: string, unknown: string[] }}
 */
export function renderTemplate(template, vars = {}) {
  const unknown = [];
  const text = String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (whole, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined) return String(vars[key]);
    unknown.push(key);
    return whole;
  });
  return { text, unknown };
}

/** 会话标题截断（≤12 字）。 */
export function clipTitle(title) {
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (trimmed === '') return undefined;
  return trimmed.length <= 12 ? trimmed : `${trimmed.slice(0, 12)}…`;
}

/**
 * 统一 clickUrl：base 优先 presence 上报的 href，其次 getAdvertisedUrl()；
 * 没有可用 base 时返回 undefined（通道省略按钮），绝不把 127.0.0.1 发给公网通道
 * 由通道层再判一次；这里只做「追加/替换 finish 参数」。
 */
export function buildClickUrl(noticeId, { reportedHref, advertisedUrl } = {}) {
  const base = pickUrlBase(reportedHref) ?? pickUrlBase(advertisedUrl);
  if (base === undefined) return undefined;
  try {
    const url = new URL(base);
    url.searchParams.set('finish', noticeId);
    return url.toString();
  } catch {
    return undefined;
  }
}

function pickUrlBase(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol === 'https:') return url.toString();
    if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')) {
      return url.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 组装一条 FinishNotice（v2）。
 * @param {object} input
 * @param {'completed'|'error'|'max-tokens'|'interrupted'|'test'} input.kind
 */
export function buildNotice(input) {
  const {
    kind, sessionId, sessionTitle, turn, durationMs, summary,
    clickUrl, config, now = Date.now(), count = 1, ids,
  } = input;
  const vars = {
    sessionTitle: clipTitle(sessionTitle),
    duration: formatDuration(durationMs),
    errorCode: shortErrorCode(kind, input.error),
    count,
  };
  const merged = count > 1 && kind === 'completed';
  let title;
  if (kind === 'test') title = config.titleTest;
  else if (merged) title = `${config.titleCompleted}×${count}`;
  else if (kind === 'completed') title = config.titleCompleted;
  else if (kind === 'error') title = config.titleError;
  else if (kind === 'max-tokens') title = config.titleMaxTokens;
  else title = config.titleInterrupted;

  const pickBody = () => {
    if (kind === 'test') return config.bodyTestTemplate;
    if (merged) return '一下子完成 {count} 轮啦';
    if (kind === 'completed') return config.bodyCompletedTemplate;
    if (kind === 'error') return config.bodyErrorTemplate;
    if (kind === 'max-tokens') return config.bodyMaxTokensTemplate;
    return config.bodyInterruptedTemplate;
  };
  const rendered = renderTemplate(pickBody(), vars);
  let body = rendered.text;
  // 无标题回退：{sessionTitle} 变量为空时去掉「{sessionTitle} 」前缀形态。
  if (!vars.sessionTitle && kind === 'completed' && !merged) {
    body = body.replace(/^\{sessionTitle\}\s*/, '').replace(/^这一轮完成啦/, '这一轮完成啦');
  }
  const notice = {
    v: NOTICE_VERSION,
    id: kind === 'test' ? `test:${now}` : `${sessionId}:${turn}`,
    kind,
    at: now,
    sessionId,
    turn,
    title,
    body,
    tag: sessionId,
    media: {
      icon: config.iconPath,
      image: config.imagePath,
    },
  };
  if (sessionTitle !== undefined && sessionTitle !== '') notice.sessionTitle = vars.sessionTitle;
  if (durationMs !== undefined && Number.isFinite(durationMs)) notice.durationMs = Math.round(durationMs);
  if (config.includeSummary && summary !== undefined && summary !== '') notice.summary = summary;
  if (clickUrl !== undefined) notice.clickUrl = clickUrl;
  if (merged) notice.batch = { count, ids: ids ?? [] };
  if (rendered.unknown.length > 0) notice.templateUnknownVars = rendered.unknown;
  return notice;
}

/** 通知标题（气泡 strong）与副行（气泡 span）的客户端视图。 */
export function bubbleLines(notice) {
  const meta = [];
  if (notice.sessionTitle) meta.push(notice.sessionTitle);
  if (notice.durationMs !== undefined) meta.push(`用时 ${formatDuration(notice.durationMs)}`);
  const metaLine = meta.length > 0 ? meta.join(' · ') : (notice.kind === 'test' ? '完成提醒 · 测试' : '这一轮');
  return { title: notice.title, metaLine };
}

/** 通道载荷（ChannelPayload）schema 校验：缺字段/类型错即 fail。 */
export function validateChannelPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') return ['payload 必须是对象'];
  if (typeof payload.title !== 'string' || payload.title === '') errors.push('title 必须是非空字符串');
  if (typeof payload.body !== 'string' || payload.body === '') errors.push('body 必须是非空字符串');
  for (const key of ['iconUrl', 'imageUrl', 'clickUrl']) {
    if (payload[key] !== undefined && typeof payload[key] !== 'string') errors.push(`${key} 若存在必须是字符串`);
  }
  if (payload.tag !== undefined && typeof payload.tag !== 'string') errors.push('tag 若存在必须是字符串');
  if (payload.summary !== undefined && typeof payload.summary !== 'string') errors.push('summary 若存在必须是字符串');
  return errors;
}

/** FinishNotice schema 校验（自测与 /pending 读取端共用）。 */
export function validateNotice(notice) {
  const errors = [];
  if (!notice || typeof notice !== 'object') return ['notice 必须是对象'];
  if (notice.v !== NOTICE_VERSION) errors.push('v 必须是 2');
  if (typeof notice.id !== 'string' || notice.id === '') errors.push('id 必须是非空字符串');
  if (!['completed', 'error', 'max-tokens', 'interrupted', 'test'].includes(notice.kind)) errors.push('kind 非法');
  if (typeof notice.at !== 'number') errors.push('at 必须是数字');
  if (typeof notice.title !== 'string' || notice.title === '') errors.push('title 必须是非空字符串');
  if (typeof notice.body !== 'string' || notice.body === '') errors.push('body 必须是非空字符串');
  if (notice.clickUrl !== undefined && typeof notice.clickUrl !== 'string') errors.push('clickUrl 若存在必须是字符串');
  return errors;
}
