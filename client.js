// dsh-finish-notify 客户端入口（单文件、无 JSX、不 require Harness Client 包）：
//  - SSE 订阅 /api/finish-notify/stream：页内肥鱼娘动效（assets/fishgirl-animation.css）
//  - finish=<id> 首屏衔接、lastNotice 温和回放、presence 上报
//  - Web Push 授权 + 订阅上报；设置卡：通道凭证 / 测试发送 / 快捷开关 / 诊断
// 兼容 @linxin666/dsh-remote-web-ui：容器挂 body 且 data-dsh-plugin="finish-notify"，
// 可点元素 ≥44px，正文 ≥14px，不依赖 hover，不抢焦点。
(() => {
  const loader = window.__ModuleLoader__;
  if (!loader?.load) return;

  loader.load({
    id: 'dsh-fishgirl-notify',
    factory(require) {
      const React = require('react');
      const { createRoot } = require('react-dom/client');
      const h = React.createElement;
      const {
        useState, useEffect, useRef, useCallback,
      } = React;

      const NS = 'finish-notify';
      const STRINGS = {
        zh: {
          statusTitle: '完成提醒',
          connected: '已连接',
          notConfigured: '还没配手机通道',
          openSettings: '去配置',
          sendTest: '发条测试',
          testing: '发送中…',
          feishuWebhook: '飞书机器人 Webhook',
          feishuWebhookPlaceholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
          feishuAppTitle: '飞书应用机器人',
          feishuAppHint: '不建群也能发：自建应用的 app_id/app_secret 直发消息',
          feishuAppId: 'App ID（cli_ 开头）',
          feishuAppSecret: 'App Secret',
          feishuAppReceiveIdType: '接收方类型',
          feishuAppReceiveId: '接收方 ID（群 chat_id / 用户 open_id / 邮箱）',
          feishuAppUseCard: '用卡片消息（关闭则发纯文本）',
          feishuAppToggle: '启用飞书应用机器人',
          feishuAppTest: '测试应用通道',
          ntfyTopic: 'ntfy 主题',
          ntfyServer: 'ntfy 服务器',
          generateTopic: '生成随机主题',
          copySubscribe: '复制订阅链接',
          openNtfyApp: '打开 ntfy 订阅页',
          save: '保存',
          saved: '已保存',
          pushSubscribe: '开启手机推送（Chrome / 安卓）',
          pushUnsubscribe: '关闭手机推送',
          pushUnsupported: '此浏览器不支持 Web Push（鸿蒙 / iOS 请用飞书或 ntfy 通道）',
          pushNeedHttps: 'Web Push 需要 https 地址（隧道就绪后可用）',
          diagnostics: '诊断',
          refreshDiagnostics: '刷新诊断',
          copyDiagnostics: '复制脱敏诊断',
          copied: '已复制',
          toggleEnabled: '总开关',
          togglePopup: '页内肥鱼娘弹窗',
          toggleError: '失败也提醒',
          toggleSuppressVisible: '页面可见时不发手机通知',
          viewSession: '查看会话',
          seeReason: '看看原因',
          gotIt: '知道了',
          close: '关闭提醒',
          loadingTitle: '正在把结果捞上来…',
          loadingFallback: '做好啦～ 结果已经出来啦',
          staleNotice: '这条提醒有点旧啦',
          allFailed: '手机通知没发出去',
          channelFallback: '已改用 {channel} 通知你',
          testInPage: '页内测试',
          settingsHint: '设置即时保存，凭证只存在本机 secrets.json',
        },
        en: {
          statusTitle: 'Finish Notify',
          connected: 'Connected',
          notConfigured: 'No phone channel yet',
          openSettings: 'Configure',
          sendTest: 'Send test',
          testing: 'Sending…',
          feishuWebhook: 'Feishu bot webhook',
          feishuWebhookPlaceholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
          feishuAppTitle: 'Feishu app bot',
          feishuAppHint: 'No group bot needed: send via your own app credentials',
          feishuAppId: 'App ID (cli_…)',
          feishuAppSecret: 'App Secret',
          feishuAppReceiveIdType: 'Receive ID type',
          feishuAppReceiveId: 'Receive ID (chat_id / open_id / email)',
          feishuAppUseCard: 'Use card message (off = plain text)',
          feishuAppToggle: 'Enable Feishu app bot',
          feishuAppTest: 'Test app channel',
          ntfyTopic: 'ntfy topic',
          ntfyServer: 'ntfy server',
          generateTopic: 'Generate random topic',
          copySubscribe: 'Copy subscribe link',
          openNtfyApp: 'Open ntfy subscribe page',
          save: 'Save',
          saved: 'Saved',
          pushSubscribe: 'Enable push (Chrome / Android)',
          pushUnsubscribe: 'Disable push',
          pushUnsupported: 'Web Push unsupported here (use Feishu / ntfy on HarmonyOS / iOS)',
          pushNeedHttps: 'Web Push needs https (usable once tunnel is ready)',
          diagnostics: 'Diagnostics',
          refreshDiagnostics: 'Refresh',
          copyDiagnostics: 'Copy redacted diagnostics',
          copied: 'Copied',
          toggleEnabled: 'Master switch',
          togglePopup: 'In-page popup',
          toggleError: 'Also notify on errors',
          toggleSuppressVisible: 'Mute push while page visible',
          viewSession: 'View session',
          seeReason: 'See reason',
          gotIt: 'Got it',
          close: 'Dismiss notice',
          loadingTitle: 'Fetching the result…',
          loadingFallback: 'Done! Result is ready',
          staleNotice: 'This notice is a bit old',
          allFailed: 'Phone notification failed',
          channelFallback: 'Fell back to {channel}',
          testInPage: 'In-page test',
          settingsHint: 'Saved instantly; secrets stay in local secrets.json',
        },
      };

      const css = `
        .fn-root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483100; font-family: inherit; }
        .fn-root * { box-sizing: border-box; }
        .fn-fab {
          position: fixed; right: max(14px, env(safe-area-inset-right));
          bottom: calc(max(14px, env(safe-area-inset-bottom)) + 72px);
          width: 48px; height: 48px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l2, rgba(127,145,170,.35));
          background: var(--dsw-alias-bg-layer-2, #141c2c) url('/api/finish-notify/assets/icon-192.png') center / 76% no-repeat;
          box-shadow: var(--dsw-elevation-prominent, 0 10px 28px -8px rgba(0,0,0,.5));
          cursor: pointer; pointer-events: auto; padding: 0;
        }
        .fn-fab[data-open='1'] { outline: 2px solid var(--dsw-alias-state-success-primary, #7fe3d2); }
        .fn-panel {
          position: fixed; right: max(10px, env(safe-area-inset-right));
          bottom: calc(max(14px, env(safe-area-inset-bottom)) + 128px);
          width: min(92vw, 380px); max-height: min(72vh, 620px); overflow-y: auto;
          border-radius: var(--dsw-radius-lg, 16px);
          background: var(--dsw-alias-bg-layer-2, #141c2c);
          border: 1px solid var(--dsw-alias-border-l2, rgba(127,145,170,.3));
          box-shadow: var(--dsw-elevation-prominent, 0 18px 44px -10px rgba(0,0,0,.55));
          color: var(--dsw-alias-label-primary, #eef2f8);
          padding: 14px; display: flex; flex-direction: column; gap: 12px;
          pointer-events: auto; font-size: 14px; line-height: 1.5; text-align: left;
        }
        .fn-panel h3 { margin: 0; font-size: 15px; font-weight: 600; }
        .fn-panel .row { display: flex; align-items: center; gap: 10px; min-height: 44px; }
        .fn-panel .col { display: flex; flex-direction: column; gap: 6px; }
        .fn-panel label { color: var(--dsw-alias-label-secondary, #a8b4c6); font-size: 13px; }
        .fn-panel input[type='text'], .fn-panel input[type='password'], .fn-panel input[type='url'] {
          width: 100%; min-height: 44px; padding: 8px 10px; border-radius: var(--dsw-radius-md, 10px);
          border: 1px solid var(--dsw-alias-border-l2, rgba(127,145,170,.35));
          background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.04)); color: inherit; font-size: 14px;
        }
        .fn-btn {
          min-height: 44px; min-width: 44px; padding: 8px 14px; border-radius: var(--dsw-radius-md, 10px);
          border: 1px solid var(--dsw-alias-border-l2, rgba(127,145,170,.35));
          background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.06)); color: inherit;
          font-size: 14px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        }
        .fn-btn[data-primary='1'] {
          background: var(--dsw-alias-button-primary-fill, #ff7f9e);
          color: var(--dsw-alias-button-primary-foreground, #20101a); border-color: transparent; font-weight: 600;
        }
        .fn-btn:disabled { opacity: .55; cursor: default; }
        .fn-switch { position: relative; width: 48px; height: 28px; border-radius: 999px; border: none; cursor: pointer;
          background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.12)); flex: 0 0 auto; }
        .fn-switch[data-on='1'] { background: var(--dsw-alias-state-success-primary, #57cfae); }
        .fn-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%;
          background: #fff; transition: transform .15s ease; }
        .fn-switch[data-on='1']::after { transform: translateX(20px); }
        .fn-status { display: flex; flex-wrap: wrap; gap: 6px; }
        .fn-chip { padding: 4px 10px; border-radius: 999px; font-size: 12.5px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,145,170,.3)); }
        .fn-chip[data-ok='1'] { color: var(--dsw-alias-state-success-primary, #7fe3d2); }
        .fn-chip[data-bad='1'] { color: var(--dsw-alias-error-primary, #ff8f8f); }
        .fn-note { font-size: 12.5px; color: var(--dsw-alias-label-secondary, #a8b4c6); }
        .fn-toast {
          position: fixed; left: 50%; transform: translateX(-50%);
          bottom: calc(max(14px, env(safe-area-inset-bottom)) + 8px);
          background: var(--dsw-alias-bg-layer-2, #141c2c); color: var(--dsw-alias-label-primary, #eef2f8);
          border: 1px solid var(--dsw-alias-border-l2, rgba(127,145,170,.3)); border-radius: 999px;
          padding: 8px 16px; font-size: 13px; pointer-events: none; white-space: nowrap; max-width: 92vw; overflow: hidden; text-overflow: ellipsis;
        }
        .fn-pop-actions { position: absolute; right: 12px; bottom: 10px; display: flex; gap: 8px; pointer-events: auto; }
        .fn-pop-actions button {
          min-height: 44px; padding: 8px 14px; border-radius: 12px; border: none; cursor: pointer;
          font-size: 13.5px; font-weight: 600; background: rgba(255,247,236,.92); color: #22304f;
        }
        .fn-pop-actions button[data-ghost='1'] { background: rgba(255,255,255,.22); color: #fff7ec; }
        .fn-pop-close {
          position: absolute; right: 6px; top: 6px; width: 44px; height: 44px; border-radius: 50%;
          border: none; background: transparent; color: rgba(255,247,236,.8); font-size: 18px; cursor: pointer;
          pointer-events: auto; display: flex; align-items: center; justify-content: center;
        }
      `;

      function FishPopup({ notice, t, onDismiss }) {
        const rootRef = useRef(null);
        const touchStart = useRef(null);
        useEffect(() => {
          const onKey = (event) => { if (event.key === 'Escape') onDismiss(); };
          document.addEventListener('keydown', onKey);
          return () => document.removeEventListener('keydown', onKey);
        }, [onDismiss]);
        const onTouchStart = (event) => { touchStart.current = event.touches[0]?.clientY ?? null; };
        const onTouchEnd = (event) => {
          const start = touchStart.current;
          const end = event.changedTouches[0]?.clientY ?? null;
          if (start !== null && end !== null && end - start > 24) onDismiss();
          touchStart.current = null;
        };
        const state = notice.kind === 'error' ? 'error' : 'success';
        const strong = notice.loading ? t('loadingTitle') : (notice.title || t('loadingFallback'));
        const spans = [];
        if (notice.loading) {
          spans.push(h('span', { key: 'meta' }, '…'));
        } else {
          if (notice.metaLine) spans.push(h('span', { key: 'meta' }, notice.metaLine));
          if (notice.body) spans.push(h('span', { key: 'body' }, notice.body));
        }
        const char = state === 'success'
          ? h('div', { className: 'fg-char', 'aria-hidden': 'true' },
            h('div', { className: 'fg-layer fg-shadow' }),
            h('div', { className: 'fg-tail-wrap' }, h('div', { className: 'fg-layer fg-tail' })),
            h('div', { className: 'fg-idle' },
              h('div', { className: 'fg-layer fg-body' }),
              h('div', { className: 'fg-layer fg-eyes fg-eyes-open' }),
              h('div', { className: 'fg-layer fg-eyes fg-eyes-closed' }),
              h('div', { className: 'fg-layer fg-sparkles' })))
          : h('div', { className: 'fg-char-static', 'aria-hidden': 'true' });
        return h('div', {
          className: 'fg-pop',
          'data-state': state,
          role: 'status',
          'aria-live': 'polite',
          ref: rootRef,
          onTouchStart,
          onTouchEnd,
        },
        h('div', { className: 'fg-scene' },
          char,
          h('div', { className: 'fg-bubble' }, h('strong', null, strong), ...spans)),
        h('div', { className: 'fn-pop-actions' },
          notice.clickUrl
            ? h('button', {
              type: 'button',
              onClick: () => { try { window.location.href = notice.clickUrl; } catch { /* noop */ } onDismiss(); },
            }, notice.kind === 'error' ? t('seeReason') : t('viewSession'))
            : null,
          h('button', { type: 'button', 'data-ghost': '1', onClick: onDismiss }, t('gotIt'))),
        h('button', {
          type: 'button', className: 'fn-pop-close', 'aria-label': t('close'), onClick: onDismiss,
        }, '✕'));
      }

      function Switch({ on, label, onChange, t }) {
        return h('div', { className: 'row', style: { justifyContent: 'space-between' } },
          h('label', null, label),
          h('button', {
            type: 'button', className: 'fn-switch', 'data-on': on ? '1' : '0',
            role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label,
            onClick: onChange,
          }));
      }

      function App({ t }) {
        const [state, setState] = useState(null);
        const [queue, setQueue] = useState([]);
        const [toast, setToast] = useState(null);
        const [panelOpen, setPanelOpen] = useState(false);
        const [busy, setBusy] = useState('');
        const [savedAt, setSavedAt] = useState(0);
        const [diag, setDiag] = useState(null);
        const helloRef = useRef({ vapidPublicKey: undefined, assetToken: undefined, pagePopupEnabled: true });
        const playedRef = useRef(new Set());
        const toastTimer = useRef(undefined);

        const showToast = useCallback((text, ms = 3000) => {
          setToast(text);
          if (toastTimer.current) clearTimeout(toastTimer.current);
          toastTimer.current = setTimeout(() => setToast(null), ms);
        }, []);

        const refreshState = useCallback(async () => {
          try {
            const response = await fetch('/api/finish-notify/state', { cache: 'no-store' });
            if (!response.ok) return;
            const data = await response.json();
            setState(data);
            if (data.vapidPublicKey) helloRef.current.vapidPublicKey = data.vapidPublicKey;
            if (data.assetToken) helloRef.current.assetToken = data.assetToken;
          } catch { /* 断线由 SSE 重连兜底 */ }
        }, []);

        const enqueue = useCallback((notice) => {
          setQueue((current) => {
            if (current.length >= 2) current = current.slice(-1);
            return [...current, notice];
          });
        }, []);

        // ---- 首屏：finish 参数 + lastNotice 温和回放 + SSE + presence ----
        useEffect(() => {
          let disposed = false;
          const finishParam = new URLSearchParams(location.search).get('finish');

          const resolveFinish = async (noticeId) => {
            const loading = { kind: 'completed', loading: true, id: noticeId, at: Date.now() };
            enqueue(loading);
            const fallbackTimer = setTimeout(() => {
              if (disposed) return;
              setQueue((q) => q.map((item) => (item === loading
                ? { kind: 'completed', title: t('loadingFallback'), metaLine: '', body: '', id: noticeId, at: Date.now() }
                : item)));
            }, 800);
            try {
              const response = await fetch('/api/finish-notify/pending?since=0', { cache: 'no-store' });
              const data = await response.json();
              const found = (data.notices ?? []).find((n) => n.id === noticeId);
              if (!disposed) {
                const replacement = found ? toPopupNotice(found)
                  : { kind: 'completed', title: t('staleNotice'), metaLine: '', body: '', id: noticeId, at: Date.now() };
                setQueue((q) => q.map((item) => (item === loading ? replacement : item)));
              }
            } catch { /* 保留 loading 兜底文案 */ }
            clearTimeout(fallbackTimer);
            try {
              const params = new URLSearchParams(location.search);
              params.delete('finish');
              const qs = params.toString();
              history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
            } catch { /* noop */ }
          };

          const replayLastNotice = async () => {
            try {
              const response = await fetch('/api/finish-notify/state', { cache: 'no-store' });
              const data = await response.json();
              setState(data);
              if (data.vapidPublicKey) helloRef.current.vapidPublicKey = data.vapidPublicKey;
              if (data.assetToken) helloRef.current.assetToken = data.assetToken;
              const last = data.lastNotice;
              if (last && Date.now() - last.at < 120000 && !playedRef.current.has(last.id)) {
                playedRef.current.add(last.id);
                enqueue(toPopupNotice(last));
              }
            } catch { /* noop */ }
          };

          if (finishParam) {
            playedRef.current.add(finishParam);
            resolveFinish(finishParam);
          } else {
            replayLastNotice();
          }

          // SSE。部分隧道（cloudflared/CF 边缘）会缓冲 event-stream body：连接 open 但事件永不到达。
          // 探活：open 后短时间内无任何事件 → 退化为 /pending 轮询兜底（方案 §4.7）；SSE 恢复即停轮询。
          let sseAlive = false;
          let pollTimer = null;
          let probeTimer = null;
          let lastSeenAt = 0;
          const startPolling = () => {
            if (pollTimer || disposed) return;
            pollTimer = setInterval(async () => {
              if (disposed || document.hidden) return;
              try {
                const response = await fetch(`/api/finish-notify/pending?since=${lastSeenAt}`, { cache: 'no-store' });
                const data = await response.json();
                for (const notice of data.notices ?? []) {
                  if (typeof notice.at === 'number' && notice.at > lastSeenAt) lastSeenAt = notice.at;
                  if (playedRef.current.has(notice.id)) continue;
                  playedRef.current.add(notice.id);
                  enqueue(toPopupNotice(notice));
                }
              } catch { /* noop */ }
            }, 2500);
          };
          const markAlive = () => {
            sseAlive = true;
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          };
          const armProbe = () => {
            if (probeTimer) return;
            probeTimer = setTimeout(() => {
              probeTimer = null;
              if (!disposed && !sseAlive) startPolling();
            }, 3500);
          };
          const source = new EventSource('/api/finish-notify/stream');
          source.onopen = armProbe;
          armProbe(); // 兜底：连接连 open 都没触发时也切轮询
          source.addEventListener('hello', (event) => {
            markAlive();
            try {
              const data = JSON.parse(event.data);
              if (data.vapidPublicKey) helloRef.current.vapidPublicKey = data.vapidPublicKey;
              if (data.assetToken) helloRef.current.assetToken = data.assetToken;
              helloRef.current.pagePopupEnabled = data.pagePopupEnabled !== false;
            } catch { /* noop */ }
          });
          source.addEventListener('finish', (event) => {
            markAlive();
            try {
              const notice = JSON.parse(event.data);
              if (typeof notice.at === 'number' && notice.at > lastSeenAt) lastSeenAt = notice.at;
              playedRef.current.add(notice.id);
              enqueue(toPopupNotice(notice));
            } catch { /* noop */ }
          });
          source.addEventListener('degraded', (event) => {
            markAlive();
            try {
              const data = JSON.parse(event.data);
              if (data.reason === 'all-failed') showToast(t('allFailed'));
              else if (data.reason === 'no-channel') showToast(t('notConfigured'));
              else if (data.reason === 'fallback-note' && Array.isArray(data.channels)) showToast(t('channelFallback').replace('{channel}', data.channels[0] ?? ''));
            } catch { /* noop */ }
          });

          // presence 上报。
          const reportPresence = () => {
            try {
              navigator.sendBeacon?.('/api/finish-notify/presence', JSON.stringify({ visible: !document.hidden, href: location.href }));
            } catch { /* noop */ }
          };
          reportPresence();
          const presenceTimer = setInterval(reportPresence, 20000);
          document.addEventListener('visibilitychange', reportPresence);

          return () => {
            disposed = true;
            source.close();
            if (pollTimer) clearInterval(pollTimer);
            if (probeTimer) clearTimeout(probeTimer);
            clearInterval(presenceTimer);
            document.removeEventListener('visibilitychange', reportPresence);
          };
        }, [enqueue, showToast, t]);

        // ---- 弹窗播放器：页面可见时逐条播，隐藏时冻结 ----
        const current = queue[0];
        useEffect(() => {
          if (!current) return undefined;
          if (document.hidden) return undefined;
          const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
          const duration = reduced ? 2600 : 3100;
          const timer = setTimeout(() => setQueue((q) => q.slice(1)), duration);
          return () => clearTimeout(timer);
        }, [current]);

        // ---- 动作 ----
        const patchConfig = useCallback(async (patch) => {
          try {
            const response = await fetch('/api/finish-notify/config', {
              method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
            });
            const data = await response.json();
            if (data.config) setState((s) => ({ ...(s ?? {}), config: data.config }));
            setSavedAt(Date.now());
            setTimeout(() => setSavedAt(0), 1200);
          } catch { /* noop */ }
        }, []);

        const sendTest = useCallback(async (channel) => {
          setBusy(channel);
          try {
            const response = await fetch('/api/finish-notify/test', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel }),
            });
            const data = await response.json();
            if (channel === 'inpage' || channel === 'all') {
              // in-page 演出已经由 SSE finish 事件送达；这里仅兜底提示。
              if (data.ok === false && channel === 'inpage') showToast(t('allFailed'));
            } else if (data.ok === true) showToast(`${channel} ✓`);
            else showToast(`${channel} ✗ ${data.code ?? ''}`);
          } catch { showToast(t('allFailed')); }
          setBusy('');
          refreshState();
        }, [refreshState, showToast, t]);

        const saveSecrets = useCallback(async (body) => {
          const response = await fetch('/api/finish-notify/secrets', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          });
          const data = await response.json();
          if (!data.ok) throw new Error((data.errors ?? [])[0] ?? 'save failed');
          setSavedAt(Date.now());
          setTimeout(() => setSavedAt(0), 1200);
          await refreshState();
          return data;
        }, [refreshState]);

        const subscribePush = useCallback(async () => {
          setBusy('push');
          try {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
              showToast(t('pushUnsupported'));
              return;
            }
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') { showToast(t('pushUnsupported')); return; }
            const registration = await navigator.serviceWorker.register('/api/finish-notify/sw.js', { scope: '/api/finish-notify/' });
            await navigator.serviceWorker.ready;
            let key = helloRef.current.vapidPublicKey;
            if (!key) {
              const response = await fetch('/api/finish-notify/state', { cache: 'no-store' });
              const data = await response.json();
              key = data.vapidPublicKey;
            }
            if (!key) { showToast(t('pushNeedHttps')); return; }
            const subscription = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlB64ToUint8Array(key),
            });
            await fetch('/api/finish-notify/subscribe', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ subscription: subscription.toJSON(), origin: location.origin, returnUrl: location.href }),
            });
            showToast('Web Push ✓');
            await refreshState();
          } catch (error) {
            showToast(`${t('pushNeedHttps')} (${error?.message ?? ''})`);
          }
          setBusy('');
        }, [refreshState, showToast, t]);

        const unsubscribePush = useCallback(async () => {
          setBusy('push');
          try {
            const registration = await navigator.serviceWorker.getRegistration('/api/finish-notify/');
            const subscription = await registration?.pushManager?.getSubscription?.();
            if (subscription) {
              await fetch('/api/finish-notify/unsubscribe', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ endpoint: subscription.endpoint }),
              });
              await subscription.unsubscribe();
            }
            await refreshState();
          } catch { /* noop */ }
          setBusy('');
        }, [refreshState]);

        const loadDiagnostics = useCallback(async () => {
          setBusy('diag');
          try {
            const response = await fetch('/api/finish-notify/diagnostics?force=1', { cache: 'no-store' });
            setDiag(await response.json());
          } catch { /* noop */ }
          setBusy('');
        }, []);

        const dismiss = useCallback(() => setQueue((q) => q.slice(1)), []);

        const channels = state?.channels ?? {};
        const cfg = state?.config ?? {};
        const ntfy = state?.secrets?.ntfy ?? {};
        const subscribeUrl = ntfy.topic ? `${ntfy.server || 'https://ntfy.sh'}/${ntfy.topic}` : '';

        return h('div', { className: 'fn-root' },
          current && helloRef.current.pagePopupEnabled !== false
            ? h(FishPopup, { notice: current, t, onDismiss: dismiss })
            : null,
          toast ? h('div', { className: 'fn-toast' }, toast) : null,
          h('button', {
            type: 'button',
            className: 'fn-fab',
            'data-open': panelOpen ? '1' : '0',
            'aria-label': t('statusTitle'),
            onClick: () => { setPanelOpen((v) => !v); refreshState(); },
          }),
          panelOpen ? h('div', { className: 'fn-panel', role: 'dialog', 'aria-label': t('statusTitle') },
            h('h3', null, `🐟 ${t('statusTitle')}`),
            h('div', { className: 'fn-status' },
              channelChip('feishu', channels.feishu, '飞书'),
              channelChip('feishu-app', channels['feishu-app'], '飞书应用'),
              channelChip('ntfy', channels.ntfy, 'ntfy'),
              channelChip('webpush', channels.webpush, 'Web Push')),
            h('div', { className: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
              h('button', { type: 'button', className: 'fn-btn', disabled: busy !== '', onClick: () => sendTest('all') }, busy === 'all' ? t('testing') : t('sendTest')),
              h('button', { type: 'button', className: 'fn-btn', disabled: busy !== '', onClick: () => sendTest('inpage') }, t('testInPage'))),
            h(FeishuSection, { t, secrets: state?.secrets?.feishu, saveSecrets, savedAt, busy, setBusy }),
            h(FeishuAppSection, {
              t, secrets: state?.secrets?.feishuApp, cfg, saveSecrets, patchConfig, sendTest,
              savedAt, busy, setBusy, showToast,
            }),
            h(NtfySection, { t, ntfy, subscribeUrl, saveSecrets, savedAt, busy, setBusy, showToast }),
            h(WebPushSection, {
              t, subscriptions: state?.subscriptions?.length ?? 0, supported: ('serviceWorker' in navigator) && ('PushManager' in window),
              https: location.protocol === 'https:', busy, subscribePush, unsubscribePush,
            }),
            h('div', { className: 'col' },
              h(Switch, { on: cfg.enabled !== false, label: t('toggleEnabled'), onChange: () => patchConfig({ enabled: cfg.enabled === false }), t }),
              h(Switch, { on: cfg.pagePopupEnabled !== false, label: t('togglePopup'), onChange: () => patchConfig({ pagePopupEnabled: cfg.pagePopupEnabled === false }), t }),
              h(Switch, { on: cfg.notifyError !== false, label: t('toggleError'), onChange: () => patchConfig({ notifyError: cfg.notifyError === false }), t }),
              h(Switch, { on: cfg.suppressPushWhenVisible !== false, label: t('toggleSuppressVisible'), onChange: () => patchConfig({ suppressPushWhenVisible: cfg.suppressPushWhenVisible === false }), t })),
            h('div', { className: 'col' },
              h('button', { type: 'button', className: 'fn-btn', onClick: loadDiagnostics, disabled: busy !== '' }, busy === 'diag' ? t('testing') : t('refreshDiagnostics')),
              diag ? h('pre', {
                style: {
                  margin: 0, padding: 10, maxHeight: 180, overflow: 'auto', fontSize: 12,
                  background: 'rgba(127,145,170,.08)', borderRadius: 10,
                },
              }, JSON.stringify({
                ok: diag.ok, publicOrigin: diag.publicOrigin, swScope: diag.swScope,
                subscriptions: diag.subscriptions, vapidFingerprint: diag.vapidFingerprint,
                channels: Object.fromEntries(Object.entries(diag.channels ?? {}).map(([id, c]) => [id, {
                  enabled: c.enabled, configured: c.configured, health: c.health?.status, last: c.last?.code,
                }])),
                recentDeliveries: diag.recentDeliveries,
                configIssues: diag.configIssues,
              }, null, 2)) : null,
              diag ? h('button', {
                type: 'button', className: 'fn-btn',
                onClick: () => copyText(JSON.stringify(diag)).then(() => showToast(t('copied'))),
              }, t('copyDiagnostics')) : null),
            h('div', { className: 'fn-note' }, t('settingsHint')))
            : null);
      }

      function channelChip(id, info, label) {
        const health = info?.health?.status;
        const ok = info?.configured && (health === undefined || health === 'ok' || health === 'pending');
        const bad = info?.configured === true && (health === 'unreachable' || health === 'error' || health === 'degraded');
        return h('span', { className: 'fn-chip', 'data-ok': ok && !bad ? '1' : undefined, 'data-bad': bad ? '1' : undefined },
          `${label} ${info?.configured ? (bad ? '不可达' : '✓') : '未配置'}`);
      }

      function FeishuSection({ t, secrets, saveSecrets, savedAt, busy, setBusy }) {
        const [webhook, setWebhook] = useState('');
        const [error, setError] = useState('');
        return h('div', { className: 'col' },
          h('label', { htmlFor: 'fn-feishu' }, `${t('feishuWebhook')} ${secrets?.configured ? '✓' : ''}`),
          h('input', {
            id: 'fn-feishu', type: 'password', autoComplete: 'off', spellCheck: false,
            placeholder: t('feishuWebhookPlaceholder'), value: webhook,
            onChange: (event) => { setWebhook(event.target.value); setError(''); },
          }),
          error ? h('span', { className: 'fn-note', style: { color: 'var(--dsw-alias-error-primary, #ff8f8f)' } }, error) : null,
          h('div', { className: 'row' },
            h('button', {
              type: 'button', className: 'fn-btn', disabled: busy !== '' || webhook.trim() === '',
              onClick: async () => {
                setBusy('feishu');
                try {
                  await saveSecrets({ feishu: { webhook: webhook.trim() } });
                  setWebhook('');
                } catch (saveError) {
                  setError(saveError.message ?? 'save failed');
                }
                setBusy('');
              },
            }, t('save')),
            savedAt ? h('span', { className: 'fn-note' }, t('saved')) : null));
      }

      function FeishuAppSection({ t, secrets, cfg, saveSecrets, patchConfig, sendTest, savedAt, busy, setBusy, showToast }) {
        const [appId, setAppId] = useState('');
        const [appSecret, setAppSecret] = useState('');
        const [receiveId, setReceiveId] = useState('');
        const [receiveIdType, setReceiveIdType] = useState(cfg?.feishuAppReceiveIdType || 'chat_id');
        const [error, setError] = useState('');
        const [open, setOpen] = useState(false);
        const enabled = cfg?.feishuAppEnabled === true;
        const configured = secrets?.configured === true;
        return h('div', { className: 'col' },
          h('div', { className: 'row', style: { justifyContent: 'space-between', alignItems: 'center' } },
            h('label', { onClick: () => setOpen((v) => !v), style: { cursor: 'pointer', fontWeight: 600 } },
              `${t('feishuAppTitle')} ${configured ? '✓' : ''}`),
            h('div', { className: 'row' },
              h(Switch, {
                on: enabled, label: t('feishuAppToggle'),
                onChange: () => patchConfig({ feishuAppEnabled: !enabled }), t,
              }),
              h('button', {
                type: 'button', className: 'fn-btn', style: { minWidth: 28, minHeight: 28 },
                'aria-expanded': open ? '1' : '0',
                onClick: () => setOpen((v) => !v),
              }, open ? '−' : '+'))),
          open || enabled ? h('div', { className: 'col', style: { gap: 6 } },
            h('div', { className: 'fn-note' }, t('feishuAppHint')),
            h('input', {
              type: 'text', autoComplete: 'off', spellCheck: false,
              placeholder: secrets?.appIdMasked ? `${t('feishuAppId')}（已存 …${secrets.appIdMasked.replace('…', '')}）` : t('feishuAppId'),
              value: appId, onChange: (event) => { setAppId(event.target.value); setError(''); },
            }),
            h('input', {
              type: 'password', autoComplete: 'new-password', spellCheck: false,
              placeholder: secrets?.hasCredentials ? `${t('feishuAppSecret')}（已存，重填可覆盖）` : t('feishuAppSecret'),
              value: appSecret, onChange: (event) => { setAppSecret(event.target.value); setError(''); },
            }),
            h('div', { className: 'row', style: { alignItems: 'center', gap: 8 } },
              h('label', { htmlFor: 'fn-fa-type' }, t('feishuAppReceiveIdType')),
              h('select', {
                id: 'fn-fa-type', value: receiveIdType,
                onChange: (event) => setReceiveIdType(event.target.value),
                style: { minHeight: 36, borderRadius: 8, flex: 1 },
              },
                h('option', { value: 'chat_id' }, 'chat_id（群）'),
                h('option', { value: 'open_id' }, 'open_id（用户）'),
                h('option', { value: 'email' }, 'email（邮箱）'))),
            h('input', {
              type: 'text', autoComplete: 'off', spellCheck: false,
              placeholder: secrets?.receiveIdMasked
                ? `${t('feishuAppReceiveId')}（已存 …${secrets.receiveIdMasked.replace('…', '')}）`
                : t('feishuAppReceiveId'),
              value: receiveId, onChange: (event) => { setReceiveId(event.target.value); setError(''); },
            }),
            h(Switch, {
              on: cfg?.feishuAppUseCard !== false, label: t('feishuAppUseCard'),
              onChange: () => patchConfig({ feishuAppUseCard: cfg?.feishuAppUseCard === false }), t,
            }),
            error ? h('span', { className: 'fn-note', style: { color: 'var(--dsw-alias-error-primary, #ff8f8f)' } }, error) : null,
            h('div', { className: 'row', style: { flexWrap: 'wrap' } },
              h('button', {
                type: 'button', className: 'fn-btn', disabled: busy !== '',
                onClick: async () => {
                  setBusy('feishuApp');
                  try {
                    const secretPatch = {};
                    if (appId.trim() !== '') secretPatch.appId = appId.trim();
                    if (appSecret.trim() !== '') secretPatch.appSecret = appSecret.trim();
                    if (Object.keys(secretPatch).length > 0) {
                      await saveSecrets({ feishuApp: secretPatch });
                    }
                    const configPatch = { feishuAppReceiveIdType: receiveIdType };
                    if (receiveId.trim() !== '') configPatch.feishuAppReceiveId = receiveId.trim();
                    await patchConfig(configPatch);
                    setAppId(''); setAppSecret(''); setReceiveId('');
                  } catch (saveError) {
                    setError(saveError.message ?? 'save failed');
                  }
                  setBusy('');
                },
              }, t('save')),
              h('button', {
                type: 'button', className: 'fn-btn',
                disabled: busy !== '' || !configured,
                title: configured ? '' : t('notConfigured'),
                onClick: () => { sendTest('feishu-app'); showToast(t('testing')); },
              }, busy === 'feishu-app' ? t('testing') : t('feishuAppTest')),
              savedAt ? h('span', { className: 'fn-note' }, t('saved')) : null)) : null);
      }

      function NtfySection({ t, ntfy, subscribeUrl, saveSecrets, savedAt, busy, setBusy, showToast }) {
        const [topic, setTopic] = useState('');
        return h('div', { className: 'col' },
          h('label', { htmlFor: 'fn-ntfy' }, `${t('ntfyTopic')} ${ntfy.configured ? '✓' : ''}`),
          h('div', { className: 'row', style: { flexWrap: 'wrap' } },
            h('span', { style: { fontFamily: 'monospace', fontSize: 13 } }, ntfy.topic || '—'),
            h('button', {
              type: 'button', className: 'fn-btn', disabled: busy !== '',
              onClick: async () => {
                setBusy('ntfy');
                try { await saveSecrets({ ntfy: { topic: 'auto', token: '' } }); } catch { /* noop */ }
                setBusy('');
              },
            }, t('generateTopic'))),
          subscribeUrl ? h('div', { className: 'row', style: { flexWrap: 'wrap' } },
            h('button', {
              type: 'button', className: 'fn-btn',
              onClick: () => copyText(subscribeUrl).then(() => showToast(t('copied'))),
            }, t('copySubscribe')),
            h('a', { className: 'fn-btn', href: subscribeUrl, target: '_blank', rel: 'noreferrer' }, t('openNtfyApp'))) : null,
          ntfy.hasToken || topic !== '' ? h('input', {
            type: 'password', placeholder: 'access token（可选，自建服务器预留）', value: topic,
            onChange: (event) => setTopic(event.target.value),
          }) : null,
          topic.trim() !== '' ? h('div', { className: 'row' },
            h('button', {
              type: 'button', className: 'fn-btn',
              onClick: async () => {
                setBusy('ntfy');
                try { await saveSecrets({ ntfy: { token: topic.trim() } }); setTopic(''); } catch { /* noop */ }
                setBusy('');
              },
            }, t('save'))) : null,
          savedAt ? h('span', { className: 'fn-note' }, t('saved')) : null);
      }

      function WebPushSection({ t, subscriptions, supported, https, busy, subscribePush, unsubscribePush }) {
        if (!supported) return h('div', { className: 'fn-note' }, t('pushUnsupported'));
        return h('div', { className: 'col' },
          h('div', { className: 'row', style: { justifyContent: 'space-between' } },
            h('label', null, `Web Push · ${subscriptions} 台设备`),
            subscriptions > 0
              ? h('button', { type: 'button', className: 'fn-btn', disabled: busy !== '', onClick: unsubscribePush }, t('pushUnsubscribe'))
              : h('button', { type: 'button', className: 'fn-btn', 'data-primary': '1', disabled: busy !== '' || !https, onClick: subscribePush }, t('pushSubscribe'))),
          !https ? h('span', { className: 'fn-note' }, t('pushNeedHttps')) : null);
      }

      function toPopupNotice(notice) {
        const metaParts = [];
        if (notice.sessionTitle) metaParts.push(notice.sessionTitle);
        if (notice.durationMs !== undefined && notice.durationMs !== null) {
          const total = Math.round(notice.durationMs / 1000);
          metaParts.push(`用时 ${total < 60 ? `${total} 秒` : `${Math.floor(total / 60)} 分 ${total % 60} 秒`}`);
        }
        return {
          id: notice.id,
          kind: notice.kind,
          title: notice.title,
          metaLine: metaParts.join(' · '),
          body: notice.body,
          clickUrl: notice.clickUrl,
          at: notice.at,
        };
      }

      function urlB64ToUint8Array(base64) {
        const padding = '='.repeat((4 - (base64.length % 4)) % 4);
        const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = window.atob(normalized);
        const output = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
        return output;
      }

      async function copyText(text) {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const area = document.createElement('textarea');
          area.value = text;
          area.style.cssText = 'position:fixed;opacity:0;';
          document.body.appendChild(area);
          area.select();
          try { document.execCommand('copy'); } catch { /* noop */ }
          area.remove();
        }
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          let bound = (key) => STRINGS.zh[key] ?? key;
          try {
            if (ctx.locale?.register) ctx.locale.register(NS, STRINGS);
            if (ctx.locale?.bind) bound = ctx.locale.bind(NS);
          } catch { /* locale 不可用时用中文 */ }
          const t = bound;

          const style = document.createElement('style');
          style.textContent = css;
          document.head.appendChild(style);

          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = '/api/finish-notify/assets/fishgirl-animation.css';
          document.head.appendChild(link);

          const container = document.createElement('div');
          container.dataset.dshPlugin = 'finish-notify';
          document.body.appendChild(container);
          const root = createRoot(container);
          root.render(h(App, { t }));

          return () => {
            try { root.unmount(); } catch { /* noop */ }
            container.remove();
            style.remove();
            link.remove();
          };
        },
      };
    },
  });
})();
