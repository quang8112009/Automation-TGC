/**
 * governance/responseMasking — Role-based PII masking for API responses.
 *
 * Applies different masking strategies based on the caller's role:
 *   - SYSTEM   : full access (no masking) — internal service calls.
 *   - ADMIN    : full access (no masking) — trusted administrators.
 *   - SALES    : partial masking — phone/email partially hidden, IDs masked.
 *   - EXTERNAL : full masking — all PII fields masked.
 *
 * PII fields are defined per resource type (Lead, Candidate, etc.) and
 * the masking depth is determined by the caller's role.
 *
 * USAGE:
 *   import { maskLeadResponse, maskCandidateResponse, PiiAccessLevel } from '../governance/responseMasking';
 *   const safe = maskLeadResponse(lead, 'SALES');
 */
import { maskPii, maskValue, type MaskStrategy, type PiiType } from './pii';

// ── Types ────────────────────────────────────────────────────────────────────

/** Access levels that determine masking depth. */
export type PiiAccessLevel = 'SYSTEM' | 'ADMIN' | 'SALES' | 'EXTERNAL';

/** Masking rule for a single field. */
export interface FieldMaskRule {
  /** Field name (supports nested paths with dots, e.g. 'profile.phone'). */
  field: string;
  /** Minimum access level to see unmasked value. */
  minLevel: PiiAccessLevel;
  /** Masking strategy for levels below minLevel. */
  strategy: MaskStrategy;
}

/** Configuration for a resource type's masking rules. */
export interface ResourceMaskConfig {
  /** Resource type name (used in audit logging). */
  resourceType: string;
  /** Field-level masking rules. */
  fields: FieldMaskRule[];
}

// ── Access Level Hierarchy ────────────────────────────────────────────────────

const LEVELHierarchy: Record<PiiAccessLevel, number> = {
  SYSTEM: 4,
  ADMIN: 3,
  SALES: 2,
  EXTERNAL: 1,
};

function hasAccess(userLevel: PiiAccessLevel, requiredLevel: PiiAccessLevel): boolean {
  return (LEVELHierarchy[userLevel] ?? 0) >= (LEVELHierarchy[requiredLevel] ?? 0);
}

/** Map a field name to a PiiType for masking. */
function fieldToPiiType(field: string): PiiType {
  const lower = field.toLowerCase();
  if (lower.includes('phone')) return 'PHONE_VN';
  if (lower.includes('email')) return 'EMAIL';
  if (lower.includes('name') || lower.includes('full')) return 'FULL_NAME';
  if (lower.includes('address')) return 'ADDRESS';
  if (lower.includes('id') || lower.includes('cccd') || lower.includes('national')) return 'CCCD';
  if (lower.includes('passport')) return 'PASSPORT';
  if (lower.includes('bank')) return 'BANK_ACCOUNT';
  if (lower.includes('tax')) return 'TAX_ID';
  if (lower.includes('dob') || lower.includes('birth')) return 'DATE_OF_BIRTH';
  if (lower.includes('gender')) return 'FULL_NAME';
  if (lower.includes('ssn')) return 'SSN';
  if (lower.includes('note') || lower.includes('text') || lower.includes('message')) return 'FULL_NAME';
  return 'FULL_NAME'; // default for unknown PII fields
}

// ── Resource Mask Configurations ──────────────────────────────────────────────

/** Lead PII fields. */
const LEAD_MASK_CONFIG: ResourceMaskConfig = {
  resourceType: 'lead',
  fields: [
    { field: 'name',     minLevel: 'ADMIN',   strategy: 'partial' },
    { field: 'phone',    minLevel: 'SALES',   strategy: 'partial' },
    { field: 'email',    minLevel: 'SALES',   strategy: 'partial' },
    { field: 'note',     minLevel: 'SALES',   strategy: 'redact'  },
  ],
};

/** Candidate PII fields (extends Lead PII). */
const CANDIDATE_MASK_CONFIG: ResourceMaskConfig = {
  resourceType: 'candidate',
  fields: [
    { field: 'fullName',     minLevel: 'ADMIN',   strategy: 'partial' },
    { field: 'phone',        minLevel: 'SALES',   strategy: 'partial' },
    { field: 'email',        minLevel: 'SALES',   strategy: 'partial' },
    { field: 'dob',          minLevel: 'ADMIN',   strategy: 'redact'  },
    { field: 'gender',       minLevel: 'ADMIN',   strategy: 'redact'  },
    { field: 'nationalId',   minLevel: 'SYSTEM',  strategy: 'full'    },
    { field: 'passportNo',   minLevel: 'SYSTEM',  strategy: 'full'    },
    { field: 'address',      minLevel: 'ADMIN',   strategy: 'partial' },
    { field: 'bankAccount',  minLevel: 'SYSTEM',  strategy: 'full'    },
    { field: 'bankName',     minLevel: 'ADMIN',   strategy: 'partial' },
    { field: 'taxId',        minLevel: 'SYSTEM',  strategy: 'full'    },
  ],
};

/** Intake conversation PII fields (message text may contain PII). */
const INTAKE_MASK_CONFIG: ResourceMaskConfig = {
  resourceType: 'intake_conversation',
  fields: [
    { field: 'externalUserId', minLevel: 'SALES',   strategy: 'hash'   },
    { field: 'displayName',    minLevel: 'SALES',   strategy: 'partial' },
    { field: 'lastMessage',    minLevel: 'SALES',   strategy: 'partial' },
  ],
};

// ── Masking Engine ────────────────────────────────────────────────────────────

/**
 * Apply role-based PII masking to a single object.
 */
export function maskObject<T extends Record<string, unknown>>(
  obj: T,
  accessLevel: PiiAccessLevel,
  config: ResourceMaskConfig,
): T {
  if (accessLevel === 'SYSTEM') return obj;

  const result = { ...obj };

  for (const rule of config.fields) {
    if (hasAccess(accessLevel, rule.minLevel)) continue;

    const parts = rule.field.split('.');
    let target: Record<string, unknown> = result;

    // Navigate to the parent of the target field.
    for (let i = 0; i < parts.length - 1; i++) {
      const next = target[parts[i]];
      if (!next || typeof next !== 'object') {
        target = {};
        break;
      }
      target = next as Record<string, unknown>;
    }

    const fieldName = parts[parts.length - 1];
    const value = target[fieldName];

    if (typeof value === 'string' && value.length > 0) {
      // Apply field-level masking directly (not pattern-based PII detection).
      // The field is known to contain PII based on the resource config,
      // so we mask it unconditionally with the specified strategy.
      const piiType = fieldToPiiType(rule.field);
      (target as Record<string, unknown>)[fieldName] = maskValue(value, piiType, {
        strategy: rule.strategy,
      });
    } else if (value === null || value === undefined) {
      // Leave null/undefined as-is.
    }
  }

  return result;
}

/**
 * Apply role-based PII masking to an array of objects.
 */
export function maskArray<T extends Record<string, unknown>>(
  arr: T[],
  accessLevel: PiiAccessLevel,
  config: ResourceMaskConfig,
): T[] {
  return arr.map((item) => maskObject(item, accessLevel, config));
}

// ── Resource-Specific Helpers ─────────────────────────────────────────────────

/**
 * Mask a Lead response based on caller's access level.
 */
export function maskLeadResponse<T extends Record<string, unknown>>(
  lead: T,
  accessLevel: PiiAccessLevel,
): T {
  return maskObject(lead, accessLevel, LEAD_MASK_CONFIG);
}

/**
 * Mask an array of Lead responses.
 */
export function maskLeadsResponse<T extends Record<string, unknown>>(
  leads: T[],
  accessLevel: PiiAccessLevel,
): T[] {
  return maskArray(leads, accessLevel, LEAD_MASK_CONFIG);
}

/**
 * Mask a Candidate response based on caller's access level.
 */
export function maskCandidateResponse<T extends Record<string, unknown>>(
  candidate: T,
  accessLevel: PiiAccessLevel,
): T {
  return maskObject(candidate, accessLevel, CANDIDATE_MASK_CONFIG);
}

/**
 * Mask an array of Candidate responses.
 */
export function maskCandidatesResponse<T extends Record<string, unknown>>(
  candidates: T[],
  accessLevel: PiiAccessLevel,
): T[] {
  return maskArray(candidates, accessLevel, CANDIDATE_MASK_CONFIG);
}

/**
 * Mask an Intake conversation response.
 */
export function maskIntakeResponse<T extends Record<string, unknown>>(
  conversation: T,
  accessLevel: PiiAccessLevel,
): T {
  return maskObject(conversation, accessLevel, INTAKE_MASK_CONFIG);
}

/**
 * Mask an array of Intake conversation responses.
 */
export function maskIntakeArrayResponse<T extends Record<string, unknown>>(
  conversations: T[],
  accessLevel: PiiAccessLevel,
): T[] {
  return maskArray(conversations, accessLevel, INTAKE_MASK_CONFIG);
}

// ── Access Level Resolution ───────────────────────────────────────────────────

/**
 * Resolve a user's PII access level from their auth info.
 *
 * @param role - The user's RBAC role (ADMIN, SALES, etc.)
 * @param isServiceAccount - Whether this is an internal service account.
 */
export function resolveAccessLevel(
  role?: string,
  isServiceAccount?: boolean,
): PiiAccessLevel {
  if (isServiceAccount) return 'SYSTEM';
  switch (role) {
    case 'ADMIN': return 'ADMIN';
    case 'SALES': return 'SALES';
    default: return 'EXTERNAL';
  }
}

/**
 * Mask a Lead list response with total count (for paginated endpoints).
 */
export function maskLeadListResponse<T extends Record<string, unknown>>(
  response: { items: T[]; total: number; page: number; limit: number },
  accessLevel: PiiAccessLevel,
): { items: T[]; total: number; page: number; limit: number } {
  return {
    ...response,
    items: maskLeadsResponse(response.items, accessLevel),
  };
}

/**
 * Mask a Candidate list response with total count.
 */
export function maskCandidateListResponse<T extends Record<string, unknown>>(
  response: { items: T[]; total: number; page: number; limit: number },
  accessLevel: PiiAccessLevel,
): { items: T[]; total: number; page: number; limit: number } {
  return {
    ...response,
    items: maskCandidatesResponse(response.items, accessLevel),
  };
}
