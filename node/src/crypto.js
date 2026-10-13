// AES-256-GCM credentials — node:crypto built-in, no deps.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const key32 = (master) => createHash('sha256').update(master).digest();

export function encrypt(master, plaintext) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key32(master), nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return 'gcm:' + Buffer.concat([nonce, ct]).toString('base64');
}

export function decrypt(master, blob) {
  if (!blob) return '';
  if (blob.startsWith('gcm:')) {
    const data = Buffer.from(blob.slice(4), 'base64');
    const nonce = data.subarray(0, 12);
    const ct = data.subarray(12, -16);
    const tag = data.subarray(-16);
    const decipher = createDecipheriv('aes-256-gcm', key32(master), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
  return blob;
}
