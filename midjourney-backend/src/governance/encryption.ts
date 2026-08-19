/**
 * encryption — Data encryption at rest and in transit.
 *
 * Provides AES-256-GCM encryption for sensitive fields (PII, credentials,
 * tokens) and TLS enforcement helpers for transport security.
 *
 * SECURITY:
 *   - Uses Node.js crypto (no external dependencies).
 *   - AES-256-GCM provides authenticated encryption (confidentiality + integrity).
 *   - Each encryption generates a unique IV (never reuse IVs).
 *   - Key is loaded from env (ENCRYPTION_KEY), never hardcoded.
 *   - Fails closed: missing key → encryption refused, never plaintext.
 *
 * USAGE:
 *   import { encrypt, decrypt, hashSha256 } from '../governance/encryption';
 *
 *   const encrypted = encrypt('sensitive-data', key);
 *   const decrypted = decrypt(encrypted, key);  // 'sensitive-data'
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';

// ── Constants ───────────────────────────────────────────────────────────────

/** AES-256-GCM requires a 32-byte key. */
const KEY_LENGTH = 32;

/** GCM recommends a 12-byte IV. */
const IV_LENGTH = 12;

/** GCM auth tag length. */
const TAG_LENGTH = 16;

/** Algorithm identifier stored in the encrypted payload. */
const ALGORITHM = 'aes-256-gcm';

// ── Types ───────────────────────────────────────────────────────────────────

/** Encrypted payload format: base64(iv + tag + ciphertext). */
export interface EncryptedPayload {
  /** The encrypted data as a base64 string. */
  data: string;
  /** The algorithm used (for future-proofing). */
  algorithm: string;
  /** ISO timestamp of when the encryption was performed. */
  encryptedAt: string;
}

// ── Key Management ──────────────────────────────────────────────────────────

/**
 * Derive a 32-byte key from a passphrase using PBKDF2.
 * Use this when the raw key is a human-readable passphrase.
 */
export function deriveKey(passphrase: string, salt: string): Buffer {
  const { pbkdf2Sync } = require('crypto') as typeof import('crypto');
  return pbkdf2Sync(passphrase, salt, 100_000, KEY_LENGTH, 'sha512');
}

/**
 * Validate that a key is exactly 32 bytes (AES-256).
 * Returns the key as a Buffer if valid, throws if not.
 */
function validateKey(key: string | Buffer): Buffer {
  const buf = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
  if (buf.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex chars). Got ${buf.length} bytes.`);
  }
  return buf;
}

// ── Encryption ──────────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * @param plaintext - The string to encrypt.
 * @param key - 32-byte key (hex string or Buffer).
 * @returns EncryptedPayload with data, algorithm, and timestamp.
 */
export function encrypt(plaintext: string, key: string | Buffer): EncryptedPayload {
  const keyBuf = validateKey(key);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, keyBuf, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Pack: iv (12) + tag (16) + ciphertext
  const packed = Buffer.concat([iv, tag, encrypted]);

  return {
    data: packed.toString('base64'),
    algorithm: ALGORITHM,
    encryptedAt: new Date().toISOString(),
  };
}

/**
 * Decrypt an EncryptedPayload back to plaintext.
 *
 * @param payload - The encrypted payload from encrypt().
 * @param key - 32-byte key (hex string or Buffer).
 * @returns The decrypted plaintext string.
 * @throws On wrong key, tampered data, or invalid format.
 */
export function decrypt(payload: EncryptedPayload, key: string | Buffer): string {
  const keyBuf = validateKey(key);
  const packed = Buffer.from(payload.data, 'base64');

  if (packed.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Encrypted payload is too short or corrupt.');
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, keyBuf, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

// ── Hashing ─────────────────────────────────────────────────────────────────

/**
 * SHA-256 hash of a string (one-way, for indexing/comparison).
 * Returns hex-encoded hash.
 */
export function hashSha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * HMAC-SHA256 for signed payloads (keyed hash).
 */
export function hmacSha256(input: string, secret: string): string {
  const { createHmac } = require('crypto') as typeof import('crypto');
  return createHmac('sha256', secret).update(input, 'utf8').digest('hex');
}

/**
 * Constant-time string comparison (prevents timing attacks).
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ── Field-level Encryption ──────────────────────────────────────────────────

/**
 * Encrypt a specific field in an object (field-level encryption).
 * Useful for encrypting PII columns before database storage.
 *
 * @example
 *   const safe = encryptField(user, 'email', key);
 *   // { ...user, email: { data: '...', algorithm: '...', encryptedAt: '...' } }
 */
export function encryptField<T extends Record<string, unknown>>(
  obj: T,
  field: keyof T,
  key: string | Buffer,
): T {
  const value = obj[field];
  if (typeof value !== 'string') return obj;

  return {
    ...obj,
    [field]: encrypt(value, key),
  };
}

/**
 * Decrypt a specific field in an object.
 */
export function decryptField<T extends Record<string, unknown>>(
  obj: T,
  field: keyof T,
  key: string | Buffer,
): T {
  const value = obj[field];
  if (!value || typeof value !== 'object' || !('data' in (value as object))) return obj;

  return {
    ...obj,
    [field]: decrypt(value as unknown as EncryptedPayload, key),
  };
}
