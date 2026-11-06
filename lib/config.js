// dsh-finish-notify 配置层：默认值、归一化与可诊断回退。
// 约定：任何非法 / 越界值都回退到默认，并把原因收进 issues，
// 供 /api/finish-notify/state 与 /diagnostics 呈现——绝不抛异常阻塞加载。

/** §10.1 配置表的默认值（与 cordis.patch.yml 保持一致）。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  notifyCompleted: true,
  notifyError: true,
  notifyMaxTokens: false,
  notifyInterrupted: false,
  onlyRootSessions: true,
  pagePopupEnabled: true,
  debounceMs: 1200,
  coalesceMs: 5000,
  minGapMs: 3000,
  quietEnabled: false,
  quietStart: '23:00',
  quietEnd: '08:00',
  quietSuppressPush: true,
  suppressPushWhenVisible: true,
  channelOrder: ['feishu', 'ntfy', 'webpush'],
  fallbackOnFailure: true,
  feishuEnabled: true,
  feishuUseCard: true,
  feishuMaxBodyChars: 600,
  feishuAppEnabled: false,
  feishuAppReceiveIdType: 'chat_id',
  feishuAppReceiveId: '',
  feishuAppUseCard: true,
  ntfyEnabled: true,
  ntfyServer: 'https://ntfy.sh',
  ntfyPriority: 4,
  ntfyTags: ['fish'],
  ntfyIconPath: '',
  ntfyAttachPath: '',
  ntfyAttachMaxKB: 2048,
  webpushEnabled: true,
  pushTtlSeconds: 3600,
  pushUrgency: 'high',
  healthCacheMs: 300000,
  requestTimeoutMs: 5000,
  retries: 1,
  diagnosticsEnabled: true,
  allowLoopbackControl: true,
  titleCompleted: '做好啦～',
  bodyCompletedTemplate: '{sessionTitle} 这一轮完成啦（用时 {duration}）',
  titleError: '呜…出错了',
  bodyErrorTemplate: '{sessionTitle} 卡住了（{errorCode}）',
  titleMaxTokens: '话说太满啦',
  bodyMaxTokensTemplate: '这一轮达到长度上限',
  titleInterrupted: '被打断啦',
  bodyInterruptedTemplate: '这一轮被中断',
  titleTest: '测试一下～',
  bodyTestTemplate: '能听到我说话吗？听到就眨眨眼',
  iconPath: '/api/finish-notify/assets/icon-192.png',
  imagePath: '/api/finish-notify/assets/notify-card.png',
  feishuImageKey: '',
  includeSummary: false,
  excludePresets: [],
});

/** 已知通道 id（未知 id 在运行期被跳过并记 debug）。 */
export const KNOWN_CHANNEL_IDS = ['feishu', 'ntfy', 'webpush', 'feishu-app'];

/** 每个数值键的取值区间（闭区间）。 */
const RANGES = {
  debounceMs: [0, 10000],
  coalesceMs: [0, 30000],
  minGapMs: [0, 60000],
  feishuMaxBodyChars: [100, 800],
  ntfyPriority: [1, 5],
  ntfyAttachMaxKB: [64, 10240],
  pushTtlSeconds: [60, 86400],
  healthCacheMs: [0, 3600000],
  requestTimeoutMs: [1000, 15000],
  retries: [0, 3],
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const URGENCY = ['very-low', 'low', 'normal', 'high'];
const FEISHU_RECEIVE_ID_TYPES = ['chat_id', 'open_id', 'email'];

function issue(list, key, value, reason) {
  list.push({ key, value: String(value), reason });
}

function clampRange(key, value) {
  const [min, max] = RANGES[key];
  if (!Number.isFinite(value)) return { value: DEFAULT_CONFIG[key], ok: false };
  if (value < min || value > max) return { value: DEFAULT_CONFIG[key], ok: false };
  return { value: Math.round(value), ok: true };
}

/**
 * 归一化一份局部配置：未知键忽略，非法键回退默认。
 * @param {Record<string, unknown>} partial 装载层 config 或运行期 PATCH。
 * @param {object} [opts]
 * @param {string[]} [opts.knownKeys] 允许出现的键（默认 DEFAULT_CONFIG 全集）。
 * @returns {{ value: Record<string, unknown>, issues: Array<{key:string,value:string,reason:string}> }}
 */
export function normalizeConfig(partial, opts = {}) {
  const issues = [];
  const out = {};
  const source = partial && typeof partial === 'object' && !Array.isArray(partial) ? partial : {};
  for (const [key, def] of Object.entries(DEFAULT_CONFIG)) {
    if (!(key in source) || source[key] === undefined || source[key] === null) {
      out[key] = def;
      continue;
    }
    const raw = source[key];
    switch (key) {
      case 'channelOrder': {
        if (!Array.isArray(raw)) {
          issue(issues, key, raw, '必须是字符串数组');
          out.channelOrder = def;
          break;
        }
        const ids = raw.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim());
        const unknown = ids.filter((id) => !KNOWN_CHANNEL_IDS.includes(id));
        for (const id of unknown) issue(issues, key, id, '未知通道 id，已跳过');
        out.channelOrder = ids.filter((id) => KNOWN_CHANNEL_IDS.includes(id));
        break;
      }
      case 'ntfyTags': {
        if (!Array.isArray(raw)) {
          issue(issues, key, raw, '必须是字符串数组');
          out.ntfyTags = def;
          break;
        }
        out.ntfyTags = raw
          .filter((t) => typeof t === 'string' && /^[a-z0-9_+-]{1,32}$/i.test(t))
          .slice(0, 8);
        if (out.ntfyTags.length === 0) out.ntfyTags = def;
        break;
      }
      case 'quietStart':
      case 'quietEnd': {
        if (typeof raw !== 'string' || !TIME_RE.test(raw)) {
          issue(issues, key, raw, '必须是 HH:mm（24 小时制）');
          out[key] = def;
        } else {
          out[key] = raw;
        }
        break;
      }
      case 'ntfyServer': {
        if (typeof raw !== 'string' || !/^https?:\/\/[^\s]+$/i.test(raw.trim())) {
          issue(issues, key, raw, '必须是 http(s) URL');
          out.ntfyServer = def;
        } else {
          out.ntfyServer = raw.trim().replace(/\/+$/, '');
        }
        break;
      }
      case 'pushUrgency': {
        if (typeof raw !== 'string' || !URGENCY.includes(raw)) {
          issue(issues, key, raw, `必须是 ${URGENCY.join(' / ')} 之一`);
          out.pushUrgency = def;
        } else {
          out.pushUrgency = raw;
        }
        break;
      }
      case 'feishuAppReceiveIdType': {
        if (typeof raw !== 'string' || !FEISHU_RECEIVE_ID_TYPES.includes(raw)) {
          issue(issues, key, raw, `必须是 ${FEISHU_RECEIVE_ID_TYPES.join(' / ')} 之一`);
          out.feishuAppReceiveIdType = def;
        } else {
          out.feishuAppReceiveIdType = raw;
        }
        break;
      }
      case 'iconPath':
      case 'imagePath':
      case 'ntfyIconPath':
      case 'ntfyAttachPath':
      case 'feishuImageKey':
      case 'feishuAppReceiveId': {
        if (typeof raw !== 'string') {
          issue(issues, key, raw, '必须是字符串');
          out[key] = def;
        } else {
          out[key] = raw.trim();
        }
        break;
      }
      case 'excludePresets': {
        if (!Array.isArray(raw)) {
          issue(issues, key, raw, '必须是字符串数组');
          out.excludePresets = def;
          break;
        }
        out.excludePresets = raw.filter((p) => typeof p === 'string').slice(0, 32);
        break;
      }
      default: {
        if (key in RANGES) {
          const num = typeof raw === 'number' ? raw : Number(raw);
          const clamped = clampRange(key, num);
          if (!clamped.ok) issue(issues, key, raw, `必须是 ${RANGES[key][0]}–${RANGES[key][1]} 之间的整数`);
          out[key] = clamped.value;
        } else if (typeof def === 'boolean') {
          out[key] = raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : (issue(issues, key, raw, '必须是布尔值'), def);
        } else if (typeof def === 'string') {
          if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) {
            issue(issues, key, raw, '必须是非空字符串（≤300 字）');
            out[key] = def;
          } else {
            out[key] = raw;
          }
        } else {
          out[key] = def;
        }
      }
    }
  }
  const allowed = opts.knownKeys ?? Object.keys(DEFAULT_CONFIG);
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key) && !(key in DEFAULT_CONFIG)) {
      issue(issues, key, source[key], '未知配置键，已忽略');
    }
  }
  return { value: out, issues };
}

/** 静默时段判断：start === end 视为全天静默；支持跨零点（23:00 → 08:00）。 */
export function inQuietHours(config, now = new Date()) {
  if (!config.quietEnabled) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMin = (hhmm) => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  };
  const start = toMin(config.quietStart);
  const end = toMin(config.quietEnd);
  if (start < 0 || end < 0) return false;
  if (start === end) return true;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // 跨零点
}
