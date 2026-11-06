// dsh-finish-notify 日志与脱敏。
// 铁律：webhook / token / 私钥 / 订阅 endpoint 全路径 / ntfy topic 永不原文入日志；
// 日志只输出 notice.id / channel / code / status / ms / host 这类无敏感字段。

/** URL 脱敏：保留 scheme+host，路径与查询替换为 <redacted>。 */
export function redactUrl(url) {
  if (typeof url !== 'string' || url === '') return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/<redacted>`;
  } catch {
    return '<redacted>';
  }
}

/** 只保留 host 的脱敏（订阅 endpoint 展示用）。 */
export function endpointHost(endpoint) {
  if (typeof endpoint !== 'string' || endpoint === '') return undefined;
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

/** 任意值安全脱敏：字符串里可能内嵌敏感片段时直接整体 <redacted>。 */
export function redactText(value) {
  if (value === undefined || value === null) return undefined;
  return '<redacted>';
}

/**
 * 建一个受控 logger：包住 ctx.logger，输出固定前缀 + 结构化字段。
 * @param {object} base ctx.logger 或等价物。
 * @param {string} scope 日志前缀。
 */
export function createLogger(base, scope = 'finish-notify') {
  const write = (level, msg, fields) => {
    const line = base?.[level];
    if (typeof line !== 'function') return;
    try {
      const extra = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
      line(`[${scope}] ${msg}${extra}`);
    } catch {
      /* 日志本身绝不成为故障源 */
    }
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
