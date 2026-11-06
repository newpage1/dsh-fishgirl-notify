// 飞书自建应用机器人通道：app_id/app_secret → tenant_access_token → IM API 直发。
// 与群 webhook 不同，无需群里加机器人；token 内存缓存（到期前 300s 提前刷新），
// 失效码 99991663/99991661 自动清缓存重试一次；卡片失败自动降级纯文本。
// 日志/诊断永不出现 appSecret / receive_id 原文（掩码到末 4 位）。
import { feishuCode, logFields, requestWithRetry } from './util.js';
import { maskTail } from '../store.js';
import { buildCardObject, buildTextContent, renderNoticePayload } from './feishu.js';

const FEISHU_OPEN_BASE = 'https://open.feishu.cn';
const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';
const MESSAGES_PATH = '/open-apis/im/v1/messages';

/** tenant_access_token 失效码：清缓存重取后重试一次。 */
const TOKEN_EXPIRED_CODES = [99991663, 99991661];

/** 接收方 id 类型（feishuAppReceiveIdType 的合法值）。 */
const FEISHU_RECEIVE_TYPES = ['chat_id', 'open_id', 'email'];

/** token 提前刷新窗口（ms）。 */
const TOKEN_EARLY_REFRESH_MS = 300_000;

/** 仅 https 公网地址才能进按钮/click（loopback 与 http 不外发）。 */
function publicHttpsClickUrl(clickUrl) {
  if (!clickUrl) return undefined;
  try {
    const url = new URL(clickUrl);
    if (url.protocol !== 'https:') return undefined;
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') return undefined;
    return clickUrl;
  } catch {
    return undefined;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return undefined;
  }
}

class TokenError extends Error {}

/** 取 tenant_access_token（带内存缓存，挂 env.feishuAppToken；测试可注入 env.now）。 */
async function getTenantAccessToken(env, { appId, appSecret }) {
  const cached = env.feishuAppToken;
  if (cached && cached.expireAt - TOKEN_EARLY_REFRESH_MS > env.now()) {
    return cached.token;
  }
  const result = await requestWithRetry({
    url: `${FEISHU_OPEN_BASE}${TOKEN_PATH}`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
    timeoutMs: env.config.requestTimeoutMs,
    retries: env.config.retries,
    fetchImpl: env.fetchImpl,
  });
  const data = safeJson(result.bodyText);
  if (!result.ok || data?.code !== 0 || typeof data?.tenant_access_token !== 'string' || data.tenant_access_token === '') {
    env.logger.info('feishu-app token fetch failed', {
      ...logFields('feishu-app', `${FEISHU_OPEN_BASE}${TOKEN_PATH}`, result),
      bizCode: data?.code,
      appId: maskTail(appId),
    });
    throw new TokenError(`token 获取失败（app ${maskTail(appId)}）`);
  }
  const expireSec = Number.isFinite(Number(data.expire)) && Number(data.expire) > 0 ? Number(data.expire) : 7200;
  env.feishuAppToken = { token: data.tenant_access_token, expireAt: env.now() + expireSec * 1000 };
  return data.tenant_access_token;
}

export const feishuAppChannel = {
  id: 'feishu-app',
  enabledKey: 'feishuAppEnabled', // `${id}Enabled` 约定在此通道不成立

  capabilities() {
    return {
      transport: 'feishu-app',
      fcmDependent: false,
      requiresClient: false,
      platforms: ['harmonyos', 'ios', 'android', 'desktop'],
      image: true,
      icon: false,
      maxTitleChars: 40,
      maxBodyChars: 600,
      requiresPublicOrigin: false,
      recommended: false,
    };
  },

  isConfigured(env) {
    const secrets = env.store.secrets.read()?.feishuApp ?? {};
    return typeof secrets.appId === 'string' && secrets.appId !== ''
      && typeof secrets.appSecret === 'string' && secrets.appSecret !== ''
      && typeof env.config.feishuAppReceiveId === 'string' && env.config.feishuAppReceiveId.trim() !== '';
  },

  health(env, { force = false } = {}) {
    const now = env.now();
    const cached = env.healthCache['feishu-app'];
    if (!force && cached && now - cached.checkedAt < env.config.healthCacheMs && cached.status !== 'pending') {
      return cached;
    }
    const entry = { status: 'not-configured', checkedAt: now, note: undefined };
    if (!this.isConfigured(env)) {
      env.healthCache['feishu-app'] = entry;
      return entry;
    }
    // 已有新鲜 token → 直接 ok，不重复探测。
    if (env.feishuAppToken && env.feishuAppToken.expireAt - TOKEN_EARLY_REFRESH_MS > now) {
      env.healthCache['feishu-app'] = { status: 'ok', checkedAt: now, note: undefined };
      return env.healthCache['feishu-app'];
    }
    entry.status = 'pending';
    env.healthCache['feishu-app'] = entry;
    (async () => {
      const secrets = env.store.secrets.read()?.feishuApp ?? {};
      await getTenantAccessToken(env, { appId: secrets.appId, appSecret: secrets.appSecret });
      env.healthCache['feishu-app'] = { status: 'ok', checkedAt: env.now(), note: undefined };
    })().catch((error) => {
      // TokenError = HTTP 通了但业务失败（凭据无效/无权限）；否则按网络不可达。
      const credentialsBad = error instanceof TokenError;
      env.healthCache['feishu-app'] = {
        status: credentialsBad ? 'error' : 'unreachable',
        checkedAt: env.now(),
        note: credentialsBad ? '凭据无效或应用未开通权限' : 'probe failed',
      };
    });
    return entry;
  },

  /** 纯函数：notice → 通道载荷（与 feishu 群机器人同构）。 */
  render(notice) {
    return renderNoticePayload(notice);
  },

  async send(payload, env) {
    const secrets = env.store.secrets.read()?.feishuApp ?? {};
    const receiveId = String(env.config.feishuAppReceiveId ?? '').trim();
    if (typeof secrets.appId !== 'string' || secrets.appId === ''
      || typeof secrets.appSecret !== 'string' || secrets.appSecret === ''
      || receiveId === '') {
      return { channel: 'feishu-app', ok: false, code: 'not-configured', ms: 0 };
    }
    const receiveIdType = FEISHU_RECEIVE_TYPES.includes(env.config.feishuAppReceiveIdType)
      ? env.config.feishuAppReceiveIdType
      : 'chat_id';
    const clickUrl = publicHttpsClickUrl(payload.clickUrl);
    let ms = 0;

    const postMessage = async (token, msgType, contentObj) => {
      const result = await requestWithRetry({
        url: `${FEISHU_OPEN_BASE}${MESSAGES_PATH}?receive_id_type=${encodeURIComponent(receiveIdType)}`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content: JSON.stringify(contentObj) }),
        },
        timeoutMs: env.config.requestTimeoutMs,
        retries: 0, // 每条消息最多一次直发 + 可能一次降级重发，不做传输层重试
        fetchImpl: env.fetchImpl,
      });
      ms += result.ms;
      return result;
    };

    const sendOnce = async (msgType, contentObj) => {
      let token = await getTenantAccessToken(env, secrets);
      let result = await postMessage(token, msgType, contentObj);
      let bizCode = feishuCode(result.bodyText);
      if (result.ok && TOKEN_EXPIRED_CODES.includes(bizCode)) {
        // token 失效：清缓存重取后整条重试一次。
        env.feishuAppToken = undefined;
        env.logger.info('feishu-app token expired, refreshing', { channel: 'feishu-app', bizCode });
        token = await getTenantAccessToken(env, secrets);
        result = await postMessage(token, msgType, contentObj);
        bizCode = feishuCode(result.bodyText);
      }
      return { result, bizCode };
    };

    try {
      if (env.config.feishuAppUseCard) {
        const card = buildCardObject(payload, {
          maxBodyChars: env.config.feishuMaxBodyChars,
          clickUrl,
          now: env.now(),
        });
        const { result, bizCode } = await sendOnce('interactive', card);
        if (result.ok && bizCode === 0) {
          return { channel: 'feishu-app', ok: true, code: 'ok', status: result.status, ms };
        }
        const cardRejected = result.ok && bizCode !== 0;
        if (cardRejected) {
          const text = buildTextContent(payload);
          const retry = await sendOnce('text', text);
          const textOk = retry.result.ok && retry.bizCode === 0;
          env.logger.info('feishu-app card degraded to text', {
            channel: 'feishu-app', code: retry.result.code, status: retry.result.status, ms,
          });
          return {
            channel: 'feishu-app', ok: textOk,
            code: textOk ? 'ok' : (retry.result.code === 'ok' ? 'error' : retry.result.code),
            status: retry.result.status, ms,
            note: 'card rejected, fell back to text',
          };
        }
        return {
          channel: 'feishu-app', ok: false,
          code: result.code === 'ok' ? 'error' : result.code,
          status: result.status, ms,
        };
      }
      const text = buildTextContent(payload);
      const { result, bizCode } = await sendOnce('text', text);
      const ok = result.ok && bizCode === 0;
      return {
        channel: 'feishu-app', ok,
        code: ok ? 'ok' : (result.code === 'ok' ? 'error' : result.code),
        status: result.status, ms,
      };
    } catch (error) {
      // TokenError：凭据无效/网络不可达——不阻塞会话，只回错误结果。
      const note = error instanceof TokenError ? error.message : 'send failed';
      return { channel: 'feishu-app', ok: false, code: 'error', ms, note };
    }
  },
};
