import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MAGIC = Buffer.from('HRPW1', 'ascii');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

export function encryptBuffer(plain, passphrase) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, encrypted]);
}

export function decryptBuffer(bundle, passphrase) {
  const headerBytes = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
  if (bundle.length <= headerBytes || !bundle.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Encrypted bundle header is invalid.');
  }

  let offset = MAGIC.length;
  const salt = bundle.subarray(offset, offset += SALT_BYTES);
  const iv = bundle.subarray(offset, offset += IV_BYTES);
  const tag = bundle.subarray(offset, offset += TAG_BYTES);
  const encrypted = bundle.subarray(offset);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

async function runCli() {
  const [mode, inputPath, outputPath] = process.argv.slice(2);
  const passphrase = process.env.SITE_KEY;
  if (!['encrypt', 'decrypt'].includes(mode) || !inputPath || !outputPath) {
    throw new Error('Usage: SITE_KEY=... node decrypt.mjs <encrypt|decrypt> <input> <output>');
  }
  if (!passphrase || passphrase.length < 32) {
    throw new Error('SITE_KEY is missing or too short.');
  }

  const input = await readFile(inputPath);
  const output = mode === 'encrypt'
    ? encryptBuffer(input, passphrase)
    : decryptBuffer(input, passphrase);
  await writeFile(outputPath, output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
