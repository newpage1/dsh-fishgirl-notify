// 通知管线：session/event → 过滤 → 去抖/合并 → SSE 页内 + 手机通道（可插拔 + 降级）。
// 铁律：任何异常都在这里吞掉并结构化记录，绝不向会话回调抛出。
import { inQuietHours } from './config.js';
import { endpointHost } from './logger.js';
import {
  buildClickUrl, buildNotice, kindFromReason,
} from './notice.js';
import { BUILTIN_CHANNELS, resolveChannelOrder } from './channels/registry.js';
import { readSubscriptions, writeSubscriptions } from './store.js';

const LRU_MAX = 200;
const PRESENCE_TTL_MS = 30_000;
const LAST_NOTICE_WINDOW_MS = 120_000;
const RECENT_MAX = 20;
const RECENT_DELIVERY_MAX = 30;

/**
 * @param {object} opts
 * @param {object} opts.ctx 宿主 ctx（session/event、agents、sessionTitle、webApp、webServer）。
 * @param {Record<string, unknown>} opts.config 已归一化配置。
 * @param {object} opts.store createStore() 结果。
 * @param {object} opts.logger
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {object} [opts.timers] { now, set, clear }（测试注入假时钟）。
 * @param {() => string|undefined} [opts.getAdvertisedUrl]
 */
export function createNotifier(opts) {
  const {
    ctx, config: initialConfig, store, logger, fetchImpl = globalThis.fetch,
    timers = { now: () => Date.now(), set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
    getAdvertisedUrl,
  } = opts;

  let config = initialConfig;
  const env = {
    store,
    logger,
    fetchImpl,
    config, // 会被 setConfig 原位替换
    now: () => timers.now(),
    healthCache: {},
    lastResults: {},
    feishuAppToken: undefined, // feishu-app 通道的 tenant_access_token 缓存 {token, expireAt}
    get publicOrigin() { return publicOrigin(); },
    timers,
  };

  // ---- 运行态 ----
  const seen = new Map(); // `${sessionId}:${turn}` LRU 去重
  const turnStarts = new Map(); // sessionId -> { turn, at }
  const lastAssistantText = new Map(); // sessionId -> 最后一段助手文本
  const queues = new Map(); // sessionId -> 待合并的原始项
  const timersBySession = new Map(); // sessionId -> timer id
  const pushDelayTimer = { id: undefined };
  const sseClients = new Set();
  const recentNotices = [];
  const recentDeliveries = [];
  let lastPushAt = 0;
  let presence = { visible: false, href: undefined, at: 0 };
  let lastDegraded = undefined;
  let disposed = false;

  function touchSeen(key) {
    seen.delete(key);
    seen.set(key, true);
    if (seen.size > LRU_MAX) {
      const oldest = seen.keys().next().value;
      seen.delete(oldest);
    }
  }

  function publicOrigin() {
    let url;
    try { url = getAdvertisedUrl?.(); } catch { /* 防御 */ }
    if (!url) {
      try { url = ctx.webServer?.getOrigin?.(); } catch { /* 防御 */ }
    }
    if (typeof url !== 'string' || url === '') return undefined;
    return url;
  }

  function isPageVisible() {
    if (timers.now() - presence.at > PRESENCE_TTL_MS) return false;
    return presence.visible === true;
  }

  function pushSseClients(event, data) {
    for (const client of sseClients) {
      try {
        client.write(event, data);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  function recordDelivery(entry) {
    recentDeliveries.push(entry);
    if (recentDeliveries.length > RECENT_DELIVERY_MAX) recentDeliveries.shift();
    env.lastResults[entry.channel] = {
      ok: entry.ok, code: entry.code, status: entry.status, ms: entry.ms, at: entry.at, note: entry.note,
    };
  }

  function setDegraded(reason, channels) {
    lastDegraded = { reason, channels, at: timers.now() };
    pushSseClients('degraded', lastDegraded);
  }

  /** 事件入口（由 index.js 注册，一切异常都在这里消化）。 */
  function handleEvent(session, event) {
    try {
      onEvent(session, event);
    } catch (error) {
      logger.warn('event handler error swallowed', { error: error?.message ?? String(error) });
    }
  }

  function onEvent(session, event) {
    if (disposed || !event || typeof event.type !== 'string') return;
    if (config.enabled === false) return;
    const sessionId = session?.id ?? session?.header?.id ?? event.sessionId;
    if (!sessionId) return;

    // 子代理 / 内部会话过滤（短路顺序即技术方案 §4）。
    const header = session?.header ?? {};
    if (header.parentSession !== undefined && header.parentSession !== null) return;
    if (header.origin === 'subagent') return;
    if ((header.delegationDepth ?? 0) > 0) return;

    switch (event.type) {
      case 'turn/start': {
        turnStarts.set(sessionId, { turn: event.data?.turn, at: timers.now() });
        // 新回合开始：上一轮的待发通知作废（用户已经在继续对话）。
        cancelPending(sessionId);
        return;
      }
      case 'assistant/message': {
        const text = extractAssistantText(event.data);
        if (text) lastAssistantText.set(sessionId, clipSummary(text));
        return;
      }
      case 'turn/end': {
        onTurnEnd(session, event, sessionId, header);
        return;
      }
      default:
    }
  }

  function onTurnEnd(session, event, sessionId, header) {
    const turn = event.data?.turn;
    const kind = kindFromReason(event.data?.reason?.kind);
    if (kind === undefined) return; // aborted / blocked / forked / 未知：不打扰

    // 顶层会话校验：agents 服务可用时，非 root 会话不提醒。
    if (config.onlyRootSessions) {
      const agents = safeGetAgents();
      if (agents) {
        try {
          const roots = agents.roots?.() ?? [];
          const rootIds = new Set(roots.map((r) => (typeof r === 'string' ? r : r?.session?.id ?? r?.id)));
          if (rootIds.size > 0 && !rootIds.has(sessionId)) return;
        } catch (error) {
          logger.debug('agents.roots() failed, rely on header filters only', { error: error?.message });
        }
      } else {
        logger.debug('agents service unavailable, header filters only');
      }
    }

    const notifyKey = kind === 'completed' ? 'notifyCompleted'
      : kind === 'error' ? 'notifyError'
        : kind === 'max-tokens' ? 'notifyMaxTokens' : 'notifyInterrupted';
    if (config[notifyKey] !== true) return;

    const dedupeKey = `${sessionId}:${turn ?? 'x'}`;
    if (seen.has(dedupeKey)) return;
    touchSeen(dedupeKey);

    const start = turnStarts.get(sessionId);
    const durationMs = start?.at !== undefined ? Math.max(0, timers.now() - start.at) : undefined;
    // 合并窗口（coalesceMs/debounceMs 内同会话连续 completed）：合成 ×N。
    const existing = queues.get(sessionId);
    if (existing && existing.kind === 'completed' && kind === 'completed') {
      existing.count = (existing.count ?? 1) + 1;
      existing.items.push(dedupeKey);
      existing.turn = turn;
      existing.durationMs = durationMs;
      scheduleNotice(sessionId);
      return;
    }
    queues.set(sessionId, {
      sessionId,
      kind,
      turn,
      count: 1,
      durationMs,
      sessionTitle: readSessionTitle(session),
      summary: lastAssistantText.get(sessionId),
      reason: event.data?.reason,
      items: [dedupeKey],
    });
    scheduleNotice(sessionId);
  }

  function scheduleNotice(sessionId) {
    if (timersBySession.has(sessionId)) return;
    const delay = Math.max(0, Number(config.debounceMs) || 0);
    const id = timers.set(() => {
      timersBySession.delete(sessionId);
      flushQueue(sessionId);
    }, delay);
    timersBySession.set(sessionId, id);
  }

  function cancelPending(sessionId) {
    const id = timersBySession.get(sessionId);
    if (id !== undefined) {
      timers.clear(id);
      timersBySession.delete(sessionId);
    }
    queues.delete(sessionId);
  }

  async function flushQueue(sessionId) {
    if (disposed) return;
    const queue = queues.get(sessionId);
    queues.delete(sessionId);
    if (!queue) return;
    try {
      const clickUrl = buildClickUrl(`${sessionId}:${queue.turn}`, {
        reportedHref: isPresenceFresh() ? presence.href : undefined,
        advertisedUrl: publicOrigin(),
      });
      const notice = buildNotice({
        kind: queue.kind,
        sessionId,
        sessionTitle: queue.sessionTitle,
        turn: queue.turn,
        durationMs: queue.durationMs,
        summary: queue.summary,
        error: queue.reason?.error,
        clickUrl,
        config,
        now: timers.now(),
        count: queue.count ?? 1,
        ids: queue.items,
      });
      rememberNotice(notice);
      // 页内动效：始终广播（客户端按 pagePopupEnabled 决定是否呈现）。
      pushSseClients('finish', notice);
      await deliverPush(notice);
    } catch (error) {
      logger.warn('flushQueue error swallowed', { error: error?.message ?? String(error) });
    }
  }

  function isPresenceFresh() {
    return timers.now() - presence.at <= PRESENCE_TTL_MS && typeof presence.href === 'string' && presence.href !== '';
  }

  async function deliverPush(notice) {
    if (notice.kind !== 'test') {
      // 静默时段：压所有手机通道，页内保留。
      if (config.quietEnabled && config.quietSuppressPush && inQuietHours(config, new Date(timers.now()))) {
        logger.info('push suppressed: quiet hours', { notice: notice.id });
        return;
      }
      // 页面可见：不需要手机打扰。
      if (config.suppressPushWhenVisible && isPageVisible()) {
        logger.info('push suppressed: page visible', { notice: notice.id });
        return;
      }
    }
    const run = async () => {
      const channels = resolveChannelOrder(env);
      if (channels.length === 0) {
        setDegraded('no-channel', []);
        return;
      }
      let sent = false;
      let firstFailure;
      for (const channel of channels) {
        let payload;
        try {
          payload = channel.render(notice, env);
        } catch (error) {
          recordDelivery({ channel: channel.id, ok: false, code: 'error', ms: 0, at: timers.now(), note: `render failed: ${error?.message}` });
          continue;
        }
        let results = [];
        try {
          results = toArray(await channel.send(payload, env));
        } catch (error) {
          results = [{ channel: channel.id, ok: false, code: 'error', ms: 0 }];
          logger.warn('channel send threw', { channel: channel.id, error: error?.message });
        }
        for (const result of results) recordDelivery({ ...result, at: timers.now() });
        const okResults = results.filter((r) => r.ok);
        if (okResults.length > 0) {
          sent = true;
          if (okResults.some((r) => r.note)) setDegraded('fallback-note', [channel.id]);
          break;
        }
        if (!firstFailure) firstFailure = results[0] ?? { channel: channel.id, code: 'error' };
        if (config.fallbackOnFailure !== true) break;
      }
      lastPushAt = timers.now();
      if (!sent) {
        setDegraded('all-failed', channels.map((c) => c.id));
        logger.warn('all channels failed', { notice: notice.id, first: firstFailure?.channel, code: firstFailure?.code });
      }
    };
    // minGap 全局节流：距上次推送太近则延后（页内已即时呈现，不影响）。
    const sinceLast = timers.now() - lastPushAt;
    const gap = Number(config.minGapMs) || 0;
    if (notice.kind !== 'test' && gap > 0 && sinceLast < gap && !pushDelayTimer.id) {
      pushDelayTimer.id = timers.set(() => {
        pushDelayTimer.id = undefined;
        run().catch(() => {});
      }, gap - sinceLast);
      return;
    }
    await run();
  }

  function rememberNotice(notice) {
    recentNotices.push(notice);
    if (recentNotices.length > RECENT_MAX) recentNotices.shift();
  }

  /** 测试发送：合成 test 通知走完整管线（绕过静默/可见抑制）。 */
  async function sendTest(channelFilter) {
    const notice = buildNotice({
      kind: 'test',
      sessionId: 'test',
      sessionTitle: '完成提醒',
      turn: 0,
      config,
      now: timers.now(),
      clickUrl: buildClickUrl(`test:${timers.now()}`, {
        reportedHref: isPresenceFresh() ? presence.href : undefined,
        advertisedUrl: publicOrigin(),
      }),
    });
    rememberNotice(notice);
    pushSseClients('finish', notice);
    if (channelFilter && channelFilter !== 'all') {
      const channel = resolveChannelOrder(env).find((c) => c.id === channelFilter)
        ?? BUILTIN_CHANNELS.find((c) => c.id === channelFilter);
      if (!channel) return { ok: false, code: 'unknown-channel', results: [] };
      if (!channel.isConfigured(env)) return { ok: false, code: 'not-configured', results: [] };
      let results = [];
      try {
        results = toArray(await channel.send(channel.render(notice, env), env));
      } catch (error) {
        results = [{ channel: channel.id, ok: false, code: 'error', ms: 0 }];
      }
      for (const result of results) recordDelivery({ ...result, at: timers.now() });
      return { ok: results.some((r) => r.ok), code: results[0]?.code, results };
    }
    await deliverPush(notice);
    const results = recentDeliveries.slice(-4).map((r) => ({ channel: r.channel, ok: r.ok, code: r.code, ms: r.ms }));
    return { ok: results.some((r) => r.ok), code: undefined, results };
  }

  // ---- 对外状态 ----
  function getState() {
    const now = timers.now();
    const lastNotice = recentNotices.length > 0 ? recentNotices[recentNotices.length - 1] : undefined;
    return {
      enabled: config.enabled,
      publicOrigin: publicOrigin(),
      subscriptions: readSubscriptions(store).map((s) => ({
        endpoint: endpointHost(s.endpoint),
        createdAt: s.createdAt,
        lastOkAt: s.lastOkAt,
      })),
      lastNotice: lastNotice && now - lastNotice.at <= LAST_NOTICE_WINDOW_MS ? lastNotice : undefined,
      pageVisible: isPageVisible(),
      vapidPublicKey: safeVapidPublicKey(),
      lastDegraded,
      version: 2,
    };
  }

  function safeVapidPublicKey() {
    try {
      const stored = store.vapid.read();
      return typeof stored?.publicKeyB64url === 'string' ? stored.publicKeyB64url : undefined;
    } catch {
      return undefined;
    }
  }

  function getPending(since = 0) {
    const now = timers.now();
    return recentNotices.filter((n) => n.at > since && now - n.at <= LAST_NOTICE_WINDOW_MS);
  }

  function setPresence(patch) {
    presence = {
      visible: patch.visible === true,
      href: typeof patch.href === 'string' ? patch.href : undefined,
      at: timers.now(),
    };
  }

  async function addSubscription(entry) {
    const list = readSubscriptions(store).filter((s) => s.endpoint !== entry.endpoint);
    list.push({
      endpoint: entry.endpoint,
      keys: entry.keys,
      origin: entry.origin,
      returnUrl: entry.returnUrl,
      createdAt: timers.now(),
    });
    await writeSubscriptions(store, list);
  }

  async function removeSubscription(endpoint) {
    const list = readSubscriptions(store).filter((s) => s.endpoint !== endpoint);
    await writeSubscriptions(store, list);
  }

  function setConfig(next) {
    config = next;
    env.config = next;
  }

  function getRecentDeliveries() {
    return recentDeliveries.slice(-5).reverse().map((d) => ({
      channel: d.channel, ok: d.ok, code: d.code, status: d.status, ms: d.ms, at: d.at, note: d.note,
    }));
  }

  function dispose() {
    disposed = true;
    for (const id of timersBySession.values()) timers.clear(id);
    timersBySession.clear();
    if (pushDelayTimer.id !== undefined) timers.clear(pushDelayTimer.id);
    for (const client of sseClients) {
      try { client.close(); } catch { /* 已断开 */ }
    }
    sseClients.clear();
  }

  function safeGetAgents() {
    try {
      return ctx.get?.('agents', false);
    } catch {
      return undefined;
    }
  }

  function readSessionTitle(session) {
    try {
      const service = ctx.get?.('sessionTitle', false);
      if (service?.get) {
        const snapshot = service.get(session);
        if (snapshot?.title) return snapshot.title;
      }
    } catch { /* 防御 */ }
    return session?.header?.title ?? session?.title ?? undefined;
  }

  return {
    env,
    handleEvent,
    sendTest,
    getState,
    getPending,
    getRecentDeliveries,
    setPresence,
    addSubscription,
    removeSubscription,
    setConfig,
    sseClients,
    dispose,
  };
}

function extractAssistantText(data) {
  if (!data) return undefined;
  const content = data.content ?? data.message?.content ?? data.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((part) => part && (part.type === 'text' || typeof part.text === 'string'))
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter((t) => t !== '');
    if (texts.length > 0) return texts.join(' ');
  }
  return undefined;
}

function clipSummary(text) {
  const trimmed = String(text).trim().replace(/\s+/g, ' ');
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 119)}…`;
}

function toArray(value) {
  return Array.isArray(value) ? value : [value];
}
