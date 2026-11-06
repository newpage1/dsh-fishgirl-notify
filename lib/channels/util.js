// 通道共享 HTTP 小件：超时、重试分类。绝不把 URL/响应体写进日志。
import { redactUrl } from '../logger.js';

/**
 * fetch + 超时 + 可控重试。
 * @param {object} opts
 * @param {string} opts.url 目标 URL（凭证所在，只以脱敏形式出现在日志）。
 * @param {object} [opts.init] fetch init（method/headers/body）。
 * @param {number} opts.timeoutMs
 * @param {number} opts.retries 网络错误/5xx 额外重试次数。
 * @param {(ms:number)=>Promise<void>} [opts.sleep]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ ok:boolean, status?:number, code:string, headers?:object, bodyText?:string, ms:number, retried:number }>}
 */
export async function requestWithRetry(opts) {
  const {
    url, init = {}, timeoutMs = 5000, retries = 1,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetchImpl = globalThis.fetch, retryDelayMs = 800, retryOn429 = false,
  } = opts;
  const startedAt = Date.now();
  let attempt = 0;
  let lastCode = 'network';
  let lastStatus;
  let lastHeaders;
  let lastBodyText;
  while (attempt <= retries) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const headers = {};
      response.headers?.forEach?.((value, key) => { headers[key.toLowerCase()] = value; });
      let bodyText = '';
      try { bodyText = await response.text(); } catch { /* body 读失败按空处理 */ }
      const status = response.status;
      let retryable = false;
      if (status >= 500) {
        retryable = true;
        lastCode = 'server-error'; lastStatus = status; lastHeaders = headers; lastBodyText = bodyText;
      } else if (status === 429) {
        if (retryOn429 && attempt < retries) {
          const retryAfter = Number(headers['retry-after']);
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : retryDelayMs;
          lastCode = 'rate-limited'; lastStatus = status;
          await sleep(delay);
          attempt += 1;
          continue;
        }
        return { ok: false, status, code: 'rate-limited', headers, bodyText, ms: Date.now() - startedAt, retried: attempt };
      } else if (status === 401 || status === 403) {
        return { ok: false, status, code: 'unauthorized', headers, bodyText, ms: Date.now() - startedAt, retried: attempt };
      } else if (status >= 400) {
        return { ok: false, status, code: 'http-error', headers, bodyText, ms: Date.now() - startedAt, retried: attempt };
      }
      if (!retryable) {
        return { ok: true, status, code: 'ok', headers, bodyText, ms: Date.now() - startedAt, retried: attempt };
      }
    } catch (error) {
      lastCode = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network';
    }
    attempt += 1;
    if (attempt <= retries) await sleep(retryDelayMs);
  }
  return { ok: false, status: lastStatus, code: lastCode, headers: lastHeaders, bodyText: lastBodyText, ms: Date.now() - startedAt, retried: attempt - 1 };
}

/** 日志安全字段（通道名 + 脱敏 host）。 */
export function logFields(channel, url, result) {
  return {
    channel,
    host: url ? redactUrl(url) : undefined,
    code: result.code,
    status: result.status,
    ms: result.ms,
  };
}

/** 解析飞书返回的 code（飞书 200 也可能带非 0 code）。 */
export function feishuCode(bodyText) {
  try {
    const parsed = JSON.parse(bodyText || '{}');
    return typeof parsed.code === 'number' ? parsed.code : typeof parsed.StatusCode === 'number' ? parsed.StatusCode : 0;
  } catch {
    return 0;
  }
}
