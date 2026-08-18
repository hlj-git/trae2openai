// Trae storage.json "tc" 加密凭证解密
// 格式: base64([6B header][32B random][AES-128-CBC cipher])
// 明文: [64B SHA-512(plaintext)][plaintext JSON]
'use strict';
const crypto = require('crypto');

// 来自 Trae 前端 JS 的 4 个硬编码盐（每盐 64 字节）
const SALT_A = Uint8Array.from([
  82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,
  124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,
  84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,
  8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37
]);
const SALT_B = Uint8Array.from([
  31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,
  96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,
  160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,
  23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125
]);
const SALT_C = Uint8Array.from([
  191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,
  135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,
  51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,
  18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209
]);
const SALT_D = Uint8Array.from([
  246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,
  50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,
  175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,
  86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170
]);

function xorSalts(a, b) {
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = a[i] ^ b[i];
  return out;
}

function detectEncType(header) {
  // 74 63 05 10 00 00 => AES; 18 57 32 32 02 03 => AES_PRIVATE
  if (header[0] === 0x74 && header[1] === 0x63) return 'AES';
  if (header[0] === 0x12 && header[1] === 0x39) return 'AES_PRIVATE';
  return 'UNKNOWN';
}

function deriveKeyAndIV(randomBytes, encType) {
  const salt = encType === 'AES_PRIVATE' ? xorSalts(SALT_C, SALT_D) : xorSalts(SALT_A, SALT_B);
  const hashOfRandom = crypto.createHash('sha512').update(Buffer.from(randomBytes)).digest();
  const finalHash = crypto.createHash('sha512')
    .update(Buffer.concat([hashOfRandom, Buffer.from(salt)])).digest();
  return { aesKey: finalHash.slice(0, 16), iv: finalHash.slice(16, 32) };
}

// 解密 tc 加密值，返回明文字符串；失败返回 null
function decryptStorageValue(base64Value) {
  try {
    const buffer = Buffer.from(String(base64Value), 'base64');
    if (buffer.length < 48) return null;
    const header = buffer.slice(0, 6);
    const randomBytes = buffer.slice(6, 38);
    const encryptedData = buffer.slice(38);
    const encType = detectEncType(header);
    if (encType === 'UNKNOWN') return null;
    const { aesKey, iv } = deriveKeyAndIV(randomBytes, encType);
    const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey, iv);
    let decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    const storedHash = decrypted.slice(0, 64);
    const plaintext = decrypted.slice(64);
    const computedHash = crypto.createHash('sha512').update(plaintext).digest();
    if (!storedHash.equals(computedHash)) return null;
    return plaintext.toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { decryptStorageValue };
