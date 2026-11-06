// 通道注册表：可插拔。新增通道 = 新文件 + 在 BUILTIN_CHANNELS 加一行。
import { feishuChannel } from './feishu.js';
import { feishuAppChannel } from './feishu-app.js';
import { ntfyChannel } from './ntfy.js';
import { webpushChannel } from './webpush.js';

export const BUILTIN_CHANNELS = [feishuChannel, feishuAppChannel, ntfyChannel, webpushChannel];

/** 通道的启用开关键（默认 `${id}Enabled`；连字符 id 如 feishu-app 用 enabledKey 覆盖）。 */
function enabledKeyOf(channel) {
  return channel.enabledKey ?? `${channel.id}Enabled`;
}

/** 全部通道能力（含未启用的），供 /state 呈现。 */
export function allChannelDescriptors(env, { force = false } = {}) {
  const descriptors = {};
  for (const channel of BUILTIN_CHANNELS) {
    const enabled = env.config[enabledKeyOf(channel)] !== false;
    descriptors[channel.id] = {
      enabled,
      configured: channel.isConfigured(env),
      capabilities: channel.capabilities(),
      health: channel.health(env, { force }),
      last: env.lastResults?.[channel.id],
    };
  }
  return descriptors;
}

/** 按 channelOrder 解析可用通道（过滤未启用/未配置），未知 id 记 debug 跳过。 */
export function resolveChannelOrder(env) {
  const order = Array.isArray(env.config.channelOrder) ? env.config.channelOrder : [];
  const resolved = [];
  for (const id of order) {
    const channel = BUILTIN_CHANNELS.find((c) => c.id === id);
    if (!channel) {
      env.logger.debug('unknown channel id in channelOrder, skipped', { channel: id });
      continue;
    }
    if (env.config[enabledKeyOf(channel)] === false) continue;
    if (!channel.isConfigured(env)) {
      env.logger.debug('channel not configured, skipped', { channel: id });
      continue;
    }
    resolved.push(channel);
  }
  return resolved;
}
