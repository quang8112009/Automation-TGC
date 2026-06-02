/**
 * OCR provider seam for AI Document OCR & Verification (Feature 1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONESTY / SCOPE NOTE (read me) — mirrors the RenderProvider seam in
 * marketing/assets/assetGenerator.ts:
 *   This module does NOT perform OCR itself. In Phase 1 no vision/OCR model is
 *   wired (no API key). The `OcrProvider` interface is the seam a real provider
 *   (Gemini Vision, Tesseract, etc.) implements later. When no provider is
 *   supplied, `DocExtractionService` falls back to `NoopOcrProvider`, which
 *   returns empty text + zero confidence. The pure engine then degrades the
 *   document to NEEDS_RESEND — the system asks the contact to resend rather than
 *   fabricating fake OCR output.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Input to an OCR extraction: a stored image key and/or inline base64 bytes. */
export interface OcrInput {
  /** Where the source image is stored (object store key), when persisted. */
  storageKey?: string;
  /** Inline image bytes, base64-encoded (when not yet persisted). */
  imageBase64?: string;
  /** MIME type of the image (e.g. 'image/jpeg', 'image/png'). */
  mimeType?: string;
}

/** What an OCR provider returns: extracted text + a 0..1 confidence estimate. */
export interface OcrResult {
  text: string;
  confidence: number;
}

/**
 * The optional seam. A real provider implements `extractText` to turn an image
 * into raw text + a confidence score. The service passes the text into the pure
 * engine (`parseDocumentText` / `verifyExtraction`).
 */
export interface OcrProvider {
  /** Provider identifier recorded on the extraction row (e.g. 'gemini-vision'). */
  readonly name?: string;
  extractText(input: OcrInput): Promise<OcrResult>;
}

/**
 * No-op OCR provider used when no vision model is wired. It NEVER fabricates
 * text: it returns empty text with zero confidence so the engine degrades the
 * document to NEEDS_RESEND.
 */
export class NoopOcrProvider implements OcrProvider {
  readonly name = 'none';

  async extractText(_input: OcrInput): Promise<OcrResult> {
    return { text: '', confidence: 0 };
  }
}
