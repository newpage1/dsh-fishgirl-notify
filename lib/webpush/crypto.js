// RFC 8291 Web Push 载荷加密（aes128gcm），纯 node:crypto。
// 结构：body = salt(16) || rs(4, BE=4096) || idlen(1)=65 || as_public_raw(65) || AES-GCM(plaintext||0x02)
import {
  createCipheriv, createECDH, createPrivateKey, generateKeyPairSync,
  hkdfSync, randomBytes, sign as cryptoSign,
} from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** 解 base64url（兼容标准 base64 尾巴）为 Buffer。 */
export function fromB64Url(text) {
  const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/** 生成一对临时 ECDH 密钥（服务器侧 as_*）。 */
export function generateServerKey() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, publicKeyRaw: Buffer.from(ecdh.getPublicKey(null, 'uncompressed')) };
}

/** RFC 8291：按订阅的 p256dh/auth 加密 payload，返回可直接作为请求体的 Buffer。 */
export function encryptPayload(subscription, plaintext, serverKey = generateServerKey()) {
  const uaPublicRaw = fromB64Url(subscription.keys.p256dh);
  if (uaPublicRaw.length !== 65 || uaPublicRaw[0] !== 0x04) {
    throw new Error('invalid p256dh key (expect 65-byte uncompressed)');
  }
  const authSecret = fromB64Url(subscription.keys.auth);
  if (authSecret.length !== 16) throw new Error('invalid auth secret (expect 16 bytes)');

  // IKM = ECDH(as_private, ua_public)
  const ikm = Buffer.from(serverKey.ecdh.computeSecret(uaPublicRaw));
  // PRK = HKDF-Extract(salt = auth_secret, IKM)
  const prk = Buffer.from(hkdfSync('sha256', ikm, authSecret, Buffer.alloc(0), 32));
  const infoFor = (label) => Buffer.concat([
    Buffer.from(label, 'utf8'),
    Buffer.from('\0', 'utf8'),
    uaPublicRaw,
    serverKey.publicKeyRaw,
  ]);
  const cek = Buffer.from(hkdfSync('sha256', prk, Buffer.alloc(0), infoFor('Content-Encoding: aes128gcm'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', prk, Buffer.alloc(0), infoFor('Content-Encoding: nonce'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const salt = randomBytes(16);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  const idlen = Buffer.from([serverKey.publicKeyRaw.length]);
  return Buffer.concat([salt, rs, idlen, serverKey.publicKeyRaw, ciphertext]);
}

/** 生成 VAPID 密钥对（ES256），持久化形态。 */
export function generateVapidKeys(subject = 'mailto:finish-notify@localhost') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const raw = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }));
  // SPKI DER 的最后 65 字节即未压缩公钥点。
  const publicKeyRaw = raw.subarray(raw.length - 65);
  return {
    privateKeyPem,
    publicKeyB64url: b64url(publicKeyRaw),
    subject,
    createdAt: new Date().toISOString(),
  };
}

/** 校验持久化的 VAPID 材料可加载。 */
export function loadVapidKey(vapid) {
  if (!vapid || typeof vapid.privateKeyPem !== 'string' || typeof vapid.publicKeyB64url !== 'string') return undefined;
  try {
    const key = createPrivateKey(vapid.privateKeyPem);
    return { key, publicKeyB64url: vapid.publicKeyB64url };
  } catch {
    return undefined;
  }
}

/** 组装 Authorization: vapid t=JWT, k=pub（ES256 / ieee-p1363 签名）。 */
export function buildVapidAuthorization(endpoint, vapidKey, subject, now = Date.now()) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const aud = new URL(endpoint).origin;
  const payload = b64url(JSON.stringify({
    aud,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject || 'mailto:finish-notify@localhost',
  }));
  const input = Buffer.from(`${header}.${payload}`, 'utf8');
  const signature = cryptoSign('sha256', input, { key: vapidKey.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64url(signature)}, k=${vapidKey.publicKeyB64url}`;
}
