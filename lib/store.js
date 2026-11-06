// dsh-finish-notify 持久化：secrets / vapid / subscriptions / config 覆盖。
// 全部落在 ${DSH_PROFILE_DIR:-~/.dsh}/finish-notify/ 下，目录 0700、文件 0600、原子写。

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 数据目录（每个进程解析一次；测试可用 env 覆盖）。 */
export function resolveDataDir(env = process.env) {
  const base = env.DSH_PROFILE_DIR && env.DSH_PROFILE_DIR.trim() !== ''
    ? env.DSH_PROFILE_DIR
    : join(homedir(), '.dsh');
  return join(base, 'finish-notify');
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * 一个受串行写保护的 JSON 文件仓。
 * 写路径：先写同目录 tmp（0600）再 rename，保证读者永远看到完整 JSON。
 */
export class JsonStore {
  /** @param {string} dir 目录（已由 ensureDir 创建）。 @param {string} name 文件名。 */
  constructor(dir, name) {
    this.path = join(dir, name);
    this.cache = undefined; // undefined = 未读；null = 文件不存在/损坏
    this.writing = Promise.resolve();
  }

  read() {
    if (this.cache !== undefined) return this.cache;
    try {
      const text = readFileSync(this.path, 'utf8');
      this.cache = JSON.parse(text);
    } catch {
      this.cache = null;
    }
    return this.cache;
  }

  /** 串行原子写；mutate(current) 返回新对象。 */
  async update(mutate) {
    const run = async () => {
      const current = this.read() ?? {};
      const next = mutate(structuredClone(current));
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: FILE_MODE });
      renameSync(tmp, this.path);
      try { } catch { /* chmod 通过写时 mode 保证 */ }
      this.cache = next;
      return next;
    };
    this.writing = this.writing.then(run, run);
    return this.writing;
  }

  /** 重置为给定对象（或删除文件）。 */
  async replace(next) {
    return this.update(() => (next === undefined ? {} : next));
  }

  stat() {
    try {
      return statSync(this.path);
    } catch {
      return undefined;
    }
  }
}

/** 确保数据目录存在并返回各文件仓。 */
export function createStore(dataDir = resolveDataDir()) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: DIR_MODE });
  return {
    dir: dataDir,
    secrets: new JsonStore(dataDir, 'secrets.json'),
    vapid: new JsonStore(dataDir, 'vapid.json'),
    subscriptions: new JsonStore(dataDir, 'subscriptions.json'),
    configOverrides: new JsonStore(dataDir, 'config.json'),
    feishuAppImage: new JsonStore(dataDir, 'feishu-app-image.json'),
  };
}

/** 读 feishu-app 大图缓存（image_key 非敏感可落盘；无缓存返回 undefined）。 */
export function readImageKeyCache(store) {
  const data = store.feishuAppImage?.read();
  return typeof data?.imageKey === 'string' && data.imageKey !== '' ? data.imageKey : undefined;
}

/** 写 feishu-app 大图缓存（0600 原子写）。 */
export async function writeImageKeyCache(store, imageKey) {
  await store.feishuAppImage.replace({ imageKey, uploadedAt: Date.now() });
}

/** 清 feishu-app 大图缓存（image_key 失效重传前调用）。 */
export async function clearImageKeyCache(store) {
  await store.feishuAppImage.replace({});
}

/**
 * 校验飞书自定义机器人 webhook：只接受飞书官方域名（防误填），
 * 额外放行 loopback http（自建网关 / 本地测试接收端）。
 */
export function validateFeishuWebhook(webhook) {
  if (typeof webhook !== 'string') return false;
  try {
    const url = new URL(webhook);
    if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')) {
      return true;
    }
    if (url.protocol !== 'https:') return false;
    return /(^|\.)feishu\.cn$/i.test(url.hostname) || /(^|\.)larksuite\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

/** 校验 ntfy topic 名。 */
export function validateNtfyTopic(topic) {
  return typeof topic === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(topic);
}

/** 生成随机 ntfy topic：dsh-<6 位>（用户可在设置卡再生成）。 */
export function generateNtfyTopic(rand = Math.random) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let tail = '';
  for (let i = 0; i < 6; i += 1) tail += alphabet[Math.floor(rand() * alphabet.length)];
  return `dsh-${tail}`;
}

/** 掩码：仅保留末 4 位（appId/receiveId 展示用；短值整体打码）。 */
export function maskTail(value) {
  if (typeof value !== 'string' || value === '') return '';
  if (value.length <= 4) return '****';
  return `…${value.slice(-4)}`;
}

/** 保存一组通道凭证（其余键保持原样）。 */
export async function saveChannelSecrets(store, patch) {
  await store.secrets.update((current) => {
    if (patch.feishu) {
      current.feishu = {
        ...(current.feishu ?? {}),
        ...(patch.feishu.webhook === undefined ? {} : { webhook: patch.feishu.webhook }),
        ...(patch.feishu.secret === undefined ? {} : { secret: patch.feishu.secret === '' ? undefined : patch.feishu.secret }),
      };
      if (current.feishu.secret === undefined) delete current.feishu.secret;
      if (current.feishu.webhook === '') delete current.feishu.webhook;
      if (Object.keys(current.feishu).length === 0) delete current.feishu;
    }
    if (patch.ntfy) {
      current.ntfy = {
        ...(current.ntfy ?? {}),
        ...(patch.ntfy.topic === undefined ? {} : { topic: patch.ntfy.topic }),
        ...(patch.ntfy.token === undefined ? {} : { token: patch.ntfy.token === '' ? undefined : patch.ntfy.token }),
      };
      if (current.ntfy?.token === undefined) delete current.ntfy.token;
      if (current.ntfy?.topic === '') delete current.ntfy.topic;
      if (current.ntfy && Object.keys(current.ntfy).length === 0) delete current.ntfy;
    }
    if (patch.feishuApp) {
      current.feishuApp = {
        ...(current.feishuApp ?? {}),
        ...(patch.feishuApp.appId === undefined ? {} : { appId: patch.feishuApp.appId === '' ? undefined : patch.feishuApp.appId }),
        ...(patch.feishuApp.appSecret === undefined ? {} : { appSecret: patch.feishuApp.appSecret === '' ? undefined : patch.feishuApp.appSecret }),
      };
      if (current.feishuApp?.appId === undefined) delete current.feishuApp.appId;
      if (current.feishuApp?.appSecret === undefined) delete current.feishuApp.appSecret;
      if (current.feishuApp && Object.keys(current.feishuApp).length === 0) delete current.feishuApp;
    }
    return current;
  });
}

/** 当前凭证形状（布尔 + 非敏感展示字段，绝不含 webhook/token 原文）。 */
export function secretsView(store, config) {
  const secrets = store.secrets.read() ?? {};
  const feishuAppConfigured = typeof secrets.feishuApp?.appId === 'string' && secrets.feishuApp.appId !== ''
    && typeof secrets.feishuApp?.appSecret === 'string' && secrets.feishuApp.appSecret !== '';
  return {
    feishu: {
      configured: typeof secrets.feishu?.webhook === 'string' && secrets.feishu.webhook !== '',
      hasSignSecret: typeof secrets.feishu?.secret === 'string' && secrets.feishu.secret !== '',
    },
    ntfy: {
      configured: typeof secrets.ntfy?.topic === 'string' && secrets.ntfy.topic !== '',
      server: config.ntfyServer,
      topic: secrets.ntfy?.topic ?? '',
      hasToken: typeof secrets.ntfy?.token === 'string' && secrets.ntfy.token !== '',
    },
    feishuApp: {
      hasCredentials: feishuAppConfigured,
      // configured = 凭据 + 接收方都齐（与通道 isConfigured 同口径）。
      configured: feishuAppConfigured && typeof config.feishuAppReceiveId === 'string' && config.feishuAppReceiveId !== '',
      appIdMasked: maskTail(secrets.feishuApp?.appId),
      receiveIdMasked: maskTail(config.feishuAppReceiveId),
      receiveIdType: config.feishuAppReceiveIdType,
      useCard: config.feishuAppUseCard,
    },
  };
}

/** 订阅表（数组形态 [{endpoint,keys,origin,returnUrl,createdAt,...}]）。 */
export function readSubscriptions(store) {
  const data = store.subscriptions.read();
  if (!Array.isArray(data)) return [];
  return data.filter(
    (s) => s && typeof s.endpoint === 'string' && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string',
  );
}

/** 落盘订阅表。 */
export async function writeSubscriptions(store, list) {
  await store.subscriptions.replace(list.slice(0, 20));
}

/** 删除文件（清理用，容错）。 */
export function removeFile(path) {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
