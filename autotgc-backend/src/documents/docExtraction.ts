/**
 * Doc_Extraction — pure parsing + verification of study-abroad documents
 * (IELTS / TOEFL / transcript / financial proof). Framework-free + deterministic
 * so it is property-testable; the service handles I/O and the OCR provider seam.
 *
 * `parseDocumentText` turns OCR/raw text into structured fields (score, expiry,
 * gpa, amount). `verifyExtraction` checks those fields against a target
 * requirement (min score, in-date, min GPA, min budget) and returns the next
 * status + human issues. When fields are missing/low-confidence it asks for a
 * resend instead of falsely failing.
 */

export type DocType = 'IELTS' | 'TOEFL' | 'TRANSCRIPT' | 'FINANCIAL' | 'PASSPORT' | 'OTHER';

export interface ExtractedFields {
  /** Overall band/score (IELTS 0–9, TOEFL 0–120). */
  score?: number;
  /** ISO date (YYYY-MM-DD) of validity expiry, when detected. */
  expiryDate?: string;
  /** GPA on a 10-point scale (transcripts). */
  gpa?: number;
  /** Financial-proof amount in million VND. */
  amountVndM?: number;
}

export interface DocRequirement {
  /** Minimum overall score required (IELTS/TOEFL). */
  minScore?: number;
  /** Minimum GPA (10-scale) required. */
  minGpa?: number;
  /** Minimum financial amount required (million VND). */
  minAmountVndM?: number;
  /** The doc must be valid (not expired) as of this date. */
  asOf?: Date;
}

export type DocVerifyStatus = 'VERIFIED' | 'FAILED' | 'NEEDS_RESEND' | 'EXTRACTED';

export interface DocVerifyResult {
  status: DocVerifyStatus;
  issues: string[];
  met: boolean;
}

/** Clamp helper; returns undefined for non-finite input. */
function finiteOrUndef(n: number): number | undefined {
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse structured fields from raw OCR text for a given document type. Pure and
 * tolerant: returns only the fields it can confidently detect.
 */
export function parseDocumentText(docType: DocType, rawText: string): ExtractedFields {
  const text = (rawText ?? '').replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  const fields: ExtractedFields = {};

  if (docType === 'IELTS') {
    // "Overall Band Score 6.5" / "Overall: 6.5" / "Band 6.5"
    const m = lower.match(/overall[^0-9]{0,12}(\d(?:\.\d)?)/) ?? lower.match(/band[^0-9]{0,8}(\d(?:\.\d)?)/);
    if (m) {
      const v = finiteOrUndef(Number(m[1]));
      if (v !== undefined && v >= 0 && v <= 9) fields.score = v;
    }
  } else if (docType === 'TOEFL') {
    // "Total Score 95" / "TOEFL iBT 95"
    const m = lower.match(/total[^0-9]{0,12}(\d{2,3})/) ?? lower.match(/ibt[^0-9]{0,8}(\d{2,3})/);
    if (m) {
      const v = finiteOrUndef(Number(m[1]));
      if (v !== undefined && v >= 0 && v <= 120) fields.score = v;
    }
  } else if (docType === 'TRANSCRIPT') {
    // "GPA 8.0" / "Điểm trung bình 8.0" (10-scale)
    const m = lower.match(/gpa[^0-9]{0,10}(\d(?:\.\d{1,2})?)/) ?? lower.match(/trung bình[^0-9]{0,10}(\d(?:\.\d{1,2})?)/);
    if (m) {
      const v = finiteOrUndef(Number(m[1]));
      if (v !== undefined && v >= 0 && v <= 10) fields.gpa = v;
    }
  } else if (docType === 'FINANCIAL') {
    // Amount in million VND: "300 triệu" / "1.2 tỷ"
    const billion = lower.match(/(\d+(?:[.,]\d+)?)\s*tỷ/);
    const million = lower.match(/(\d+(?:[.,]\d+)?)\s*triệu/);
    if (billion) {
      const v = finiteOrUndef(Number(billion[1].replace(',', '.')) * 1000);
      if (v !== undefined) fields.amountVndM = v;
    } else if (million) {
      const v = finiteOrUndef(Number(million[1].replace(',', '.')));
      if (v !== undefined) fields.amountVndM = v;
    }
  }

  // Expiry date detection (IELTS/TOEFL/passport): ISO or DD/MM/YYYY.
  const iso = text.match(/(20\d{2})-(\d{2})-(\d{2})/);
  const dmy = text.match(/(\d{2})[/-](\d{2})[/-](20\d{2})/);
  if (iso) {
    fields.expiryDate = `${iso[1]}-${iso[2]}-${iso[3]}`;
  } else if (dmy) {
    fields.expiryDate = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  }

  return fields;
}

/**
 * Verify extracted fields against a requirement. Decision policy:
 *  - No usable field for the doc's key metric and low confidence → NEEDS_RESEND.
 *  - Expired (expiryDate < asOf) → FAILED (with an "expired" issue).
 *  - Key metric below requirement → FAILED (with a "below_requirement" issue).
 *  - All present requirements satisfied → VERIFIED.
 *  - Fields present but no requirement to check against → EXTRACTED.
 */
export function verifyExtraction(
  docType: DocType,
  fields: ExtractedFields,
  requirement: DocRequirement,
  confidence: number,
): DocVerifyResult {
  const issues: string[] = [];

  // Determine the key metric for this doc type.
  const keyMetric =
    docType === 'IELTS' || docType === 'TOEFL'
      ? fields.score
      : docType === 'TRANSCRIPT'
        ? fields.gpa
        : docType === 'FINANCIAL'
          ? fields.amountVndM
          : undefined;

  const needsKey = docType === 'IELTS' || docType === 'TOEFL' || docType === 'TRANSCRIPT' || docType === 'FINANCIAL';

  if (needsKey && keyMetric === undefined) {
    issues.push('missing_key_field');
    if (confidence < 0.5) issues.push('low_confidence_image');
    return { status: 'NEEDS_RESEND', issues, met: false };
  }

  // Expiry check.
  if (requirement.asOf && fields.expiryDate) {
    const exp = new Date(fields.expiryDate);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() < requirement.asOf.getTime()) {
      issues.push('expired');
    }
  }

  // Requirement checks per metric.
  let belowRequirement = false;
  if ((docType === 'IELTS' || docType === 'TOEFL') && requirement.minScore !== undefined) {
    if ((fields.score ?? -Infinity) < requirement.minScore) belowRequirement = true;
  }
  if (docType === 'TRANSCRIPT' && requirement.minGpa !== undefined) {
    if ((fields.gpa ?? -Infinity) < requirement.minGpa) belowRequirement = true;
  }
  if (docType === 'FINANCIAL' && requirement.minAmountVndM !== undefined) {
    if ((fields.amountVndM ?? -Infinity) < requirement.minAmountVndM) belowRequirement = true;
  }
  if (belowRequirement) issues.push('below_requirement');

  if (issues.includes('expired') || issues.includes('below_requirement')) {
    return { status: 'FAILED', issues, met: false };
  }

  // Did we actually check anything?
  const hadRequirement =
    requirement.minScore !== undefined ||
    requirement.minGpa !== undefined ||
    requirement.minAmountVndM !== undefined ||
    (requirement.asOf !== undefined && fields.expiryDate !== undefined);

  if (hadRequirement) {
    return { status: 'VERIFIED', issues, met: true };
  }
  return { status: 'EXTRACTED', issues, met: false };
}
