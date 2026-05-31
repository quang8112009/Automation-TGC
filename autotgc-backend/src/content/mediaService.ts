/**
 * Media_Service — store user-supplied media and attach it to a draft
 * (Content Pipeline Req 8.2, 8.3, 12.3).
 *
 * File bytes are written to a configurable storage directory (object-store
 * stand-in) and NEVER stored in PostgreSQL; only a Media_Asset metadata row is
 * persisted. `isTikTokEligible` reports whether a draft's media satisfies the
 * TikTok requirement (a video or photo_carousel asset must be present).
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { MediaAsset, PrismaClient } from '@prisma/client';
import { NotFoundError, ValidationError } from '../infra/errors';

/** Media kinds (mirrors Media_Asset.kind). */
export type MediaKind = 'image' | 'video' | 'photo_carousel';

/** Default storage location; overridable via constructor (env-driven in routes). */
export const DEFAULT_MEDIA_DIR =
  process.platform === 'win32' ? path.join(process.cwd(), 'media') : '/opt/autotgc/media';

export interface UploadFile {
  filename: string;
  mimetype: string;
  buffer: Buffer;
}

/** Infer media kind from a MIME type (image/* -> image, video/* -> video). */
export function inferKind(mimeType: string): MediaKind {
  const mt = (mimeType ?? '').toLowerCase();
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('image/')) return 'image';
  throw new ValidationError(`Unsupported media MIME type: ${mimeType}`, 'MEDIA_MIME_UNSUPPORTED');
}

/** True iff the asset collection contains a video or photo_carousel (Req 12.3). */
export function isTikTokEligible(assets: ReadonlyArray<{ kind: string }>): boolean {
  return assets.some((a) => a.kind === 'video' || a.kind === 'photo_carousel');
}

export class MediaService {
  private readonly storageDir: string;

  constructor(
    private readonly prisma: PrismaClient,
    storageDir: string = DEFAULT_MEDIA_DIR,
  ) {
    this.storageDir = storageDir;
  }

  /**
   * Persist a file under the storage dir and attach a Media_Asset to the draft
   * (Req 8.2, 8.3). Returns the created asset row.
   */
  async attach(draftId: string, file: UploadFile): Promise<MediaAsset> {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new ValidationError('Empty media upload', 'MEDIA_EMPTY');
    }
    const draft = await this.prisma.contentDraft.findUnique({ where: { id: draftId } });
    if (!draft) {
      throw new NotFoundError('Draft not found', 'DRAFT_NOT_FOUND');
    }

    const kind = inferKind(file.mimetype);
    const ext = safeExtension(file.filename);
    const storageKey = `${draftId}/${randomUUID()}${ext}`;
    const fullPath = path.join(this.storageDir, storageKey);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.buffer);

    return this.prisma.mediaAsset.create({
      data: { draftId, kind, storageKey, mimeType: file.mimetype },
    });
  }

  /** All media assets attached to a draft. */
  async listForDraft(draftId: string): Promise<MediaAsset[]> {
    return this.prisma.mediaAsset.findMany({
      where: { draftId },
      orderBy: { createdAt: 'asc' },
    });
  }
}

/** Extract a safe, lowercase file extension (no path separators). */
function safeExtension(filename: string): string {
  const ext = path.extname(filename ?? '').toLowerCase();
  return /^\.[a-z0-9]+$/.test(ext) ? ext : '';
}
