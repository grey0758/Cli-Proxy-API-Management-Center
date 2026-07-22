export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

const rotateLeft = (value: number, bits: number) =>
  ((value << bits) | (value >>> (32 - bits))) >>> 0;

const sha1 = (message: Uint8Array): Uint8Array => {
  const byteLength = message.length;
  const bitLength = byteLength * 8;
  const totalLength = Math.ceil((byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(totalLength);
  const view = new DataView(padded.buffer);

  padded.set(message);
  padded[byteLength] = 0x80;
  view.setUint32(totalLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(totalLength - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);

  for (let offset = 0; offset < totalLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft(
        words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16],
        1
      );
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let index = 0; index < 80; index += 1) {
      let f: number;
      let k: number;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temporary = (rotateLeft(a, 5) + f + e + k + words[index]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temporary;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const digest = new Uint8Array(20);
  const digestView = new DataView(digest.buffer);
  [h0, h1, h2, h3, h4].forEach((word, index) => {
    digestView.setUint32(index * 4, word, false);
  });
  return digest;
};

const joinBytes = (first: Uint8Array, second: Uint8Array): Uint8Array => {
  const output = new Uint8Array(first.length + second.length);
  output.set(first, 0);
  output.set(second, first.length);
  return output;
};

const hmacSha1 = (key: Uint8Array, message: Uint8Array): Uint8Array => {
  const normalizedKey = key.length > 64 ? sha1(key) : key;
  const blockKey = new Uint8Array(64);
  blockKey.set(normalizedKey);

  const innerPad = new Uint8Array(64);
  const outerPad = new Uint8Array(64);
  for (let index = 0; index < 64; index += 1) {
    innerPad[index] = blockKey[index] ^ 0x36;
    outerPad[index] = blockKey[index] ^ 0x5c;
  }

  return sha1(joinBytes(outerPad, sha1(joinBytes(innerPad, message))));
};

export const normalizeTotpSecret = (secret: string): string =>
  secret.toUpperCase().replace(/\s+/g, '').replace(/-/g, '').replace(/=+$/, '');

export const base32ToBytes = (secret: string): Uint8Array => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = normalizeTotpSecret(secret);
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    throw new Error('invalid_base32');
  }

  const output: number[] = [];
  let value = 0;
  let bits = 0;
  for (const character of normalized) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(output);
};

export function generateTotp(
  secret: string,
  timeMs = Date.now(),
  digits = TOTP_DIGITS,
  periodSeconds = TOTP_PERIOD_SECONDS
): string {
  const key = base32ToBytes(secret);
  const counter = Math.floor(timeMs / 1000 / periodSeconds);
  const counterBytes = new Uint8Array(8);
  const counterView = new DataView(counterBytes.buffer);
  counterView.setUint32(0, Math.floor(counter / 0x100000000), false);
  counterView.setUint32(4, counter >>> 0, false);

  const digest = hmacSha1(key, counterBytes);
  const offset = digest[digest.length - 1] & 0x0f;
  const binaryCode =
    (((digest[offset] & 0x7f) << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3]) >>>
    0;

  return String(binaryCode % 10 ** digits).padStart(digits, '0');
}

export const formatTotp = (code: string): string =>
  code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
