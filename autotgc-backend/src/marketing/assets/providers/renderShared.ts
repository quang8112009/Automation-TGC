/**
 * renderShared — small pieces shared by the OpenAI-compatible image/video
 * render providers (customer: Thanh Giang, XKLĐ):
 *   - the file-writing seam (WriteFileFn) + its default fs implementation,
 *   - the default rendered-asset output directory,
 *   - the sleep seam + a default real backoff used for 429 retry,
 *   - helpers to decode base64 / coerce a download body into bytes and to pick
 *     a file extension from a MIME type or URL.
 *
 * No hosts/credentials are encoded here; everything transport-related is passed
 * in by the providers (which read keys/models/base-urls from the SecretLoader).
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { asString, isRecord } from '../../../platforms/narrow';

/** Signature of the file-writing seam (injectable for tests). */
export type WriteFileFn = (fullPath: string, bytes: Buffer) => Promise<void>;

/** Sleep seam: injectable so tests run with no real delay. */
export type SleepFn = (ms: number) => Promise<void>;

/** Default writer: mkdir -p then write (mirrors mediaService). */
export const defaultWriteFile: WriteFileFn = async (fullPath, bytes) => {
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, bytes);
};

/** Default sleep: real wall-clock delay (overridden to a no-op in tests). */
export const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Default storage location for rendered asset files (env-driven in the factory). */
export const DEFAULT_ASSET_RENDER_DIR =
  process.platform === 'win32'
    ? path.join(process.cwd(), 'media', 'assets')
    : '/opt/autotgc/media/assets';

/** Default number of attempts on a transient HTTP 429 ("overloaded"). */
export const DEFAULT_MAX_RETRIES = 3;

/** Exponential backoff delay (ms) for the Nth retry (0-based): 500, 1000, 2000… */
export function backoffMs(attempt: number): number {
  return 500 * 2 ** Math.max(0, attempt);
}

/** Map an image MIME type to a file extension (defensive default: .png). */
export function imageExtensionForMime(mimeType: string): string {
  const mt = mimeType.toLowerCase();
  if (mt.includes('jpeg') || mt.includes('jpg')) return '.jpg';
  if (mt.includes('webp')) return '.webp';
  if (mt.includes('gif')) return '.gif';
  return '.png';
}

/** Derive a file extension from a URL path (defensive default: ''). */
export function extensionFromUrl(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? '';
  const base = withoutQuery.substring(withoutQuery.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = base.slice(dot).toLowerCase();
  // Only accept short, alphanumeric extensions to avoid garbage.
  return /^\.[a-z0-9]{2,5}$/.test(ext) ? ext : '';
}

/** Decode a base64 string into bytes (empty buffer on failure). */
export function decodeBase64(data: string): Buffer {
  try {
    return Buffer.from(data, 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * Coerce an HTTP GET body (Buffer | base64/binary string | { data }) into bytes.
 * Used when downloading the bytes behind a returned media `url`.
 */
export function bodyToBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') {
    // Could be base64 or raw binary text; prefer a base64 decode, else binary.
    const decoded = decodeBase64(body);
    return decoded.length > 0 ? decoded : Buffer.from(body, 'binary');
  }
  if (isRecord(body)) {
    const data = asString(body.data) ?? asString(body.b64_json) ?? asString(body.bytesBase64Encoded);
    if (data) return decodeBase64(data);
  }
  return Buffer.alloc(0);
}
