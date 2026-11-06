#!/usr/bin/env node
/**
 * e2e-installed.mjs —— 对「已安装到 web profile 并运行中」的 dsh-finish-notify 插件做通道级验证。
 *
 * 前置：插件已安装（plugin_manager install_bundle），DSH 宿主在 127.0.0.1:3080 运行。
 * 全程离线：feishu / ntfy 端点都是本脚本在 127.0.0.1 上起的 mock 接收端，
 * 不触碰任何真实 webhook / 外网服务器，不产生任何真实凭证。
 *
 * 验证项：
 *   1) POST /secrets 写入飞书 mock webhook + ntfy topic，secrets.json 以 0600 落盘；
 *   2) PATCH /config 把 ntfyServer 指到 mock（持久化覆盖）；
 *   3) POST /test feishu：interactive 卡片结构（header template / plain_text / 按钮 url 含 finish=）；
 *   4) POST /test ntfy：JSON 载荷形状（topic/title/message/priority/tags/click）；
 *   5) 卡片被拒（feishu code 9499）→ 自动降级 msg_type=text 重发；
 *   6) feishu 5xx → 通道降级链 feishu→ntfy 顶上；
 *   7) SSE /stream 能收到 hello 与 finish(test) 事件（页内动效广播链路）；
 *   8) 清理：secrets 清空、config 恢复默认 server，/state 确认 configured=false。
 *
 * 产物：docs/evidence/channel-verification.json（断言结果 + mock 收到的原始请求，均无真实凭证）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3080/api/finish-notify';
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 4591);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.resolve(HERE, '../docs/evidence');

const startedAt = new Date().toISOString();
const steps = [];
const mockLog = [];
let failed = 0;

function record(name, ok, detail) {
  steps.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 8000, everyMs = 200) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  return undefined;
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text };
}

// ---------------- mock 接收端 ----------------
function startMock() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(raw); } catch { /* text */ }
      const entry = {
        ts: new Date().toISOString(),
        method: req.method,
        path: req.url,
        contentType: req.headers['content-type'] ?? null,
        authorization: req.headers.authorization ? '<omitted>' : null,
        body,
      };
      mockLog.push(entry);
      const send = (code, payload) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && req.url === '/v1/health') return send(200, { healthy: true });
      if (req.method === 'POST' && req.url === '/') return send(200, { id: 'mock-ntfy' }); // ntfy POST 目标
      if (req.method === 'POST' && req.url === '/open-apis/bot/v2/hook/ok') return send(200, { code: 0, msg: 'ok' });
      if (req.method === 'POST' && req.url === '/open-apis/bot/v2/hook/reject') {
        // 模拟飞书网关拒绝 interactive 卡片（签名/格式错误码），接受降级 text
        if (body && body.msg_type === 'interactive') return send(200, { code: 9499, msg: 'sign match fail' });
        return send(200, { code: 0, msg: 'ok' });
      }
      if (req.method === 'POST' && req.url === '/open-apis/bot/v2/hook/down') {
        return send(500, { code: 500, msg: 'mock server error' });
      }
      send(404, { code: 404 });
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

// ---------------- SSE 读取器 ----------------
async function startSseReader(collector) {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await fetch(BASE + '/stream', { signal: controller.signal, headers: { accept: 'text/event-stream' } });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          const dataLines = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length) {
            try { collector.push({ event, data: JSON.parse(dataLines.join('\n')) }); } catch { collector.push({ event, data: dataLines.join('\n') }); }
          }
        }
      }
    } catch { /* aborted */ }
  })();
  return controller;
}

// ---------------- 断言辅助 ----------------
function findCardButtonUrl(payload) {
  const elements = payload?.card?.elements ?? [];
  for (const el of elements) {
    for (const action of el.actions ?? []) {
      if (action.type === 'button' || action.tag === 'button') return action;
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const server = await startMock();
  const sseEvents = [];
  const sse = await startSseReader(sseEvents);
  const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
  const dataDir = path.join(os.homedir(), '.dsh', 'finish-notify');

  try {
    // 1. baseline
    const st0 = await api('GET', '/state');
    record('GET /state 基线 200 且 enabled', st0.status === 200 && st0.json?.enabled === true, `status=${st0.status}`);

    // SSE hello
    const hello = await waitFor(() => sseEvents.find((e) => e.event === 'hello'));
    record('SSE /stream 收到 hello（含 assetToken/vapidPublicKey）', !!hello && typeof hello.data?.assetToken === 'string' && typeof hello.data?.vapidPublicKey === 'string',
      hello ? 'hello ok' : '8s 内未见 hello');

    // 2. secrets 写入
    const sec = await api('POST', '/secrets', {
      feishu: { webhook: `${MOCK}/open-apis/bot/v2/hook/ok` },
      ntfy: { topic: 'dsh-e2e-test' },
    });
    record('POST /secrets 写入 mock webhook + topic', sec.status === 200 && sec.json?.ok === true && sec.json?.secrets?.feishu?.configured === true,
      `status=${sec.status}`);
    const secPath = path.join(dataDir, 'secrets.json');
    let modeOk = false;
    try { modeOk = (fs.statSync(secPath).mode & 0o777) === 0o600; } catch { modeOk = false; }
    record('secrets.json 落盘且权限 0600', modeOk, secPath);

    // 3. config 覆盖
    const cfg = await api('PATCH', '/config', { ntfyServer: MOCK });
    record('PATCH /config ntfyServer→mock 且持久化', cfg.status === 200 && cfg.json?.config?.ntfyServer === MOCK, `status=${cfg.status}`);
    const cfgPath = path.join(dataDir, 'config.json');
    let cfgPersist = false;
    try { cfgPersist = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).ntfyServer === MOCK; } catch { cfgPersist = false; }
    record('config.json 持久化覆盖生效', cfgPersist, cfgPath);

    // 4. feishu 卡片
    const tf = await api('POST', '/test', { channel: 'feishu' });
    const feishuReq = await waitFor(() => mockLog.find((m) => m.path === '/open-apis/bot/v2/hook/ok' && m.body?.msg_type === 'interactive'));
    const card = feishuReq?.body?.card;
    const btn = feishuReq ? findCardButtonUrl(feishuReq.body) : null;
    const btnUrl = String(btn?.action_url_v2 ?? btn?.url ?? '');
    const feishuChecks = {
      respOk: tf.status === 200 && tf.json?.ok === true,
      template: card?.header?.template === 'blue',
      title: JSON.stringify(card?.header?.title).includes('测试一下'),
      plainText: JSON.stringify(card?.elements).includes('plain_text'),
      button: btnUrl.includes('finish=test') || btnUrl.includes('finish%3Dtest'),
    };
    const feishuOk = Object.values(feishuChecks).every(Boolean);
    record('POST /test feishu：卡片结构(template/title/plain_text/按钮 finish=)', feishuOk,
      `checks=${JSON.stringify(feishuChecks)}; btn=${btnUrl || 'none'}`);

    // 5. ntfy
    const tn = await api('POST', '/test', { channel: 'ntfy' });
    const ntfyReq = await waitFor(() => mockLog.find((m) => m.method === 'POST' && m.path === '/' && m.body?.topic === 'dsh-e2e-test'));
    const ntfyOk = tn.status === 200 && tn.json?.ok === true && ntfyReq
      && ntfyReq.body.priority === 4
      && (ntfyReq.body.tags ?? []).includes('fish') && (ntfyReq.body.tags ?? []).includes('loudspeaker')
      && typeof ntfyReq.body.click === 'string' && ntfyReq.body.click.includes('finish=test')
      && typeof ntfyReq.body.title === 'string' && ntfyReq.body.title.length <= 64;
    record('POST /test ntfy：载荷形状(topic/priority/tags/click/title)', !!ntfyOk,
      ntfyReq ? `topic=${ntfyReq.body.topic} priority=${ntfyReq.body.priority} tags=${JSON.stringify(ntfyReq.body.tags)}` : 'mock 未收到 ntfy POST');

    // SSE finish(test)
    const sseFinish = await waitFor(() => sseEvents.find((e) => e.event === 'finish' && String(e.data?.id ?? '').startsWith('test:')));
    record('SSE finish(test) 页内广播', !!sseFinish, sseFinish ? `id=${sseFinish.data.id} title=${sseFinish.data.title}` : '未收到');

    // 6. 卡片被拒 → 降级 text
    await api('POST', '/secrets', { feishu: { webhook: `${MOCK}/open-apis/bot/v2/hook/reject` } });
    await sleep(3200); // 错开 minGapMs
    const tr = await api('POST', '/test', { channel: 'feishu' });
    const rejected = await waitFor(() => mockLog.filter((m) => m.path === '/open-apis/bot/v2/hook/reject').length >= 2);
    const inter = mockLog.find((m) => m.path === '/open-apis/bot/v2/hook/reject' && m.body?.msg_type === 'interactive');
    const text = mockLog.find((m) => m.path === '/open-apis/bot/v2/hook/reject' && m.body?.msg_type === 'text');
    record('卡片被拒自动降级 text 重发', !!rejected && !!inter && !!text && tr.json?.ok === true,
      `interactive=${!!inter} text=${!!text} resp.ok=${tr.json?.ok}`);

    // 7. feishu 5xx → ntfy 顶上
    await api('POST', '/secrets', { feishu: { webhook: `${MOCK}/open-apis/bot/v2/hook/down` } });
    await sleep(3200);
    const ntfyCountBefore = mockLog.filter((m) => m.method === 'POST' && m.path === '/').length;
    const ta = await api('POST', '/test', {});
    const downHits = await waitFor(() => mockLog.filter((m) => m.path === '/open-apis/bot/v2/hook/down').length >= 1, 10000);
    const ntfyAfter = await waitFor(() => mockLog.filter((m) => m.method === 'POST' && m.path === '/').length > ntfyCountBefore, 10000);
    const feishuFail = (ta.json?.results ?? []).some((r) => r.channel === 'feishu' && r.ok === false);
    const ntfyWin = (ta.json?.results ?? []).some((r) => r.channel === 'ntfy' && r.ok === true);
    record('feishu 5xx → fallback ntfy 顶上', !!downHits && !!ntfyAfter && feishuFail && ntfyWin,
      `results=${JSON.stringify(ta.json?.results)}`);

    // 8. 无凭证静默降级：清空 secrets 后单通道 test → not-configured，不抛错
    await api('POST', '/secrets', { feishu: { webhook: '' }, ntfy: { topic: '' } });
    await sleep(3200);
    const tnc = await api('POST', '/test', { channel: 'feishu' });
    record('无凭证时 test 返回 not-configured（静默降级）', tnc.status === 200 && tnc.json?.ok === false && tnc.json?.code === 'not-configured',
      `code=${tnc.json?.code}`);

    // 9. 恢复默认配置
    const restore = await api('PATCH', '/config', { ntfyServer: 'https://ntfy.sh' });
    const st1 = await api('GET', '/state');
    const clean = st1.json?.channels?.feishu?.configured === false && st1.json?.channels?.ntfy?.configured === false;
    record('清理：secrets 清空 + config 恢复默认', restore.status === 200 && clean,
      `feishu.configured=${st1.json?.channels?.feishu?.configured} ntfy.configured=${st1.json?.channels?.ntfy?.configured}`);
  } finally {
    sse.abort();
    server.close();
    const report = {
      startedAt, finishedAt: new Date().toISOString(),
      base: BASE, mockPort: MOCK_PORT,
      passed: steps.length - failed, failed, total: steps.length,
      steps, mockRequests: mockLog,
    };
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'channel-verification.json'), JSON.stringify(report, null, 2));
  }
  console.log(failed === 0 ? `\n全部通过：${steps.length}/${steps.length}` : `\n失败 ${failed} 项（共 ${steps.length}）`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('e2e crashed:', e); process.exit(1); });
