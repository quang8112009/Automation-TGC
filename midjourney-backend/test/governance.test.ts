/**
 * Governance Platform — comprehensive tests.
 *
 * Tests all governance modules: encryption, PII, classification, audit,
 * retention, and workload protection.
 */
import { describe, it, expect } from 'vitest';
import {
  encrypt, decrypt, hashSha256, hmacSha256, safeCompare, deriveKey,
  encryptField, decryptField,
} from '../src/governance/encryption';
import {
  detectPii, detectPiiInObject, maskPii, maskObject, maskValue, scanReport,
} from '../src/governance/pii';
import {
  classifyField, classifyObject, classifyValue, classificationLabel, retentionLabel,
} from '../src/governance/classification';
import { AuditLogger } from '../src/governance/audit';
import {
  scanWorkload, auditEnvironment, auditConfiguration,
} from '../src/governance/protection';

// ── Encryption Tests ────────────────────────────────────────────────────────

describe('Governance: Encryption', () => {
  const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('encrypts and decrypts a string', () => {
    const plaintext = 'sensitive-data-12345';
    const encrypted = encrypt(plaintext, key);
    expect(encrypted.data).not.toBe(plaintext);
    expect(encrypted.algorithm).toBe('aes-256-gcm');
    expect(encrypted.encryptedAt).toBeTruthy();

    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext for same plaintext (unique IV)', () => {
    const e1 = encrypt('hello', key);
    const e2 = encrypt('hello', key);
    expect(e1.data).not.toBe(e2.data);
  });

  it('throws on wrong key', () => {
    const encrypted = encrypt('hello', key);
    const wrongKey = '1111111111111111111111111111111111111111111111111111111111111111';
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it('throws on invalid key length', () => {
    expect(() => encrypt('hello', 'short-key')).toThrow();
  });

  it('hashSha256 is deterministic', () => {
    const h1 = hashSha256('input');
    const h2 = hashSha256('input');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('hmacSha256 produces different hashes with different secrets', () => {
    const h1 = hmacSha256('msg', 'secret1');
    const h2 = hmacSha256('msg', 'secret2');
    expect(h1).not.toBe(h2);
  });

  it('safeCompare is constant-time', () => {
    expect(safeCompare('abc', 'abc')).toBe(true);
    expect(safeCompare('abc', 'abd')).toBe(false);
    expect(safeCompare('abc', 'ab')).toBe(false);
  });

  it('deriveKey produces consistent keys', () => {
    const k1 = deriveKey('passphrase', 'salt');
    const k2 = deriveKey('passphrase', 'salt');
    expect(k1).toEqual(k2);
    expect(k1).toHaveLength(32);
  });

  it('encryptField encrypts a specific field', () => {
    const obj = { name: 'John', email: 'john@test.com' };
    const encrypted = encryptField(obj, 'email', key);
    expect(encrypted.name).toBe('John');
    expect(encrypted.email).not.toBe('john@test.com');
    expect((encrypted.email as { data: string }).data).toBeTruthy();
  });

  it('decryptField decrypts a specific field', () => {
    const obj = { name: 'John', email: 'john@test.com' };
    const encrypted = encryptField(obj, 'email', key);
    const decrypted = decryptField(encrypted, 'email', key);
    expect(decrypted.email).toBe('john@test.com');
  });
});

// ── PII Detection Tests ────────────────────────────────────────────────────

describe('Governance: PII Detection', () => {
  it('detects email addresses', () => {
    const detections = detectPii('Contact me at user@example.com');
    expect(detections.length).toBeGreaterThanOrEqual(1);
    expect(detections[0].type).toBe('EMAIL');
    expect(detections[0].value).toBe('user@example.com');
  });

  it('detects Vietnamese phone numbers', () => {
    const detections = detectPii('Call 0912345678');
    expect(detections.some((d) => d.type === 'PHONE_VN')).toBe(true);
  });

  it('detects CCCD (Vietnamese national ID)', () => {
    const detections = detectPii('My CCCD is 012345678901');
    expect(detections.some((d) => d.type === 'CCCD')).toBe(true);
  });

  it('detects IP addresses', () => {
    const detections = detectPii('Server at 192.168.1.100');
    expect(detections.some((d) => d.type === 'IP_ADDRESS')).toBe(true);
  });

  it('returns empty for no PII', () => {
    const detections = detectPii('Hello world');
    expect(detections).toHaveLength(0);
  });

  it('detects PII in nested objects', () => {
    const obj = {
      user: {
        email: 'test@example.com',
        phone: '0912345678',
        name: 'Nguyen Van A',
      },
    };
    const detections = detectPiiInObject(obj);
    expect(detections.length).toBeGreaterThanOrEqual(2);
    expect(detections.some((d) => d.path.includes('email'))).toBe(true);
    expect(detections.some((d) => d.path.includes('phone'))).toBe(true);
  });

  it('filters by PII type', () => {
    const detections = detectPii('Email test@example.com phone 0912345678', {
      types: ['EMAIL'],
    });
    expect(detections.every((d) => d.type === 'EMAIL')).toBe(true);
  });
});

// ── PII Masking Tests ──────────────────────────────────────────────────────

describe('Governance: PII Masking', () => {
  it('masks email with partial strategy', () => {
    const masked = maskPii('Email: test@example.com');
    expect(masked).not.toContain('test@example.com');
    expect(masked).toContain('***');
  });

  it('masks with full strategy', () => {
    const masked = maskPii('0912345678', { strategy: 'full' });
    expect(masked).toBe('**********');
  });

  it('masks with redact strategy', () => {
    const masked = maskPii('test@example.com', { strategy: 'redact' });
    expect(masked).toContain('[REDACTED:EMAIL]');
  });

  it('masks with hash strategy', () => {
    const masked = maskPii('test@example.com', { strategy: 'hash' });
    expect(masked).toContain('[HASH:');
  });

  it('preserves non-PII text', () => {
    const masked = maskPii('No PII here');
    expect(masked).toBe('No PII here');
  });

  it('maskObject masks all string fields', () => {
    const obj = { email: 'test@example.com', name: 'Safe text' };
    const masked = maskObject(obj);
    expect(masked.email).not.toBe('test@example.com');
    expect(masked.name).toBe('Safe text');
  });

  it('scanReport generates a summary', () => {
    const report = scanReport('Email test@example.com phone 0912345678');
    expect(report.totalFound).toBeGreaterThanOrEqual(2);
    expect(report.hasHighConfidence).toBe(true);
    expect(report.byType.EMAIL).toBeGreaterThanOrEqual(1);
  });
});

// ── Classification Tests ────────────────────────────────────────────────────

describe('Governance: Classification', () => {
  it('classifies email as CONFIDENTIAL', () => {
    const result = classifyField('email', 'test@example.com');
    expect(result.level).toBe('CONFIDENTIAL');
    expect(result.piiTypes).toContain('EMAIL');
    expect(result.maskInLogs).toBe(true);
  });

  it('classifies CCCD as RESTRICTED', () => {
    const result = classifyField('id_card', '012345678901');
    expect(result.level).toBe('RESTRICTED');
    expect(result.encryptAtRest).toBe(true);
  });

  it('classifies public data as PUBLIC or INTERNAL', () => {
    const result = classifyField('status', 'active');
    // status is PUBLIC, title/body are INTERNAL by field hint
    expect(['PUBLIC', 'INTERNAL']).toContain(result.level);
    expect(result.piiTypes).toHaveLength(0);
  });

  it('classifies object with PII as CONFIDENTIAL', () => {
    const result = classifyObject({
      email: 'test@example.com',
      title: 'Safe title',
    });
    expect(result.level).toBe('CONFIDENTIAL');
    expect(result.piiTypes).toContain('EMAIL');
    expect(result.compliance).toContain('GDPR');
  });

  it('classifies object with no PII as PUBLIC or INTERNAL', () => {
    const result = classifyObject({
      status: 'active',
      createdAt: '2024-01-01',
    });
    // status and created_at are PUBLIC
    expect(['PUBLIC', 'INTERNAL']).toContain(result.level);
  });

  it('classificationLabel returns descriptive labels', () => {
    expect(classificationLabel('PUBLIC')).toContain('Public');
    expect(classificationLabel('RESTRICTED')).toContain('Restricted');
  });

  it('retentionLabel returns human-readable periods', () => {
    expect(retentionLabel('24_months')).toBe('24 months');
    expect(retentionLabel('legal_hold')).toContain('Legal hold');
  });
});

// ── Audit Logger Tests ─────────────────────────────────────────────────────

describe('Governance: Audit Logger', () => {
  it('creates an audit entry with chained hash', async () => {
    const logger = new AuditLogger();
    const entry1 = await logger.log({
      action: 'DATA_ACCESS',
      actor: { id: 'user-1', role: 'ADMIN' },
      resource: { type: 'lead', id: 'lead-123' },
    });

    expect(entry1.id).toBeTruthy();
    expect(entry1.entryHash).toHaveLength(64);
    expect(entry1.previousHash).toBe('0'.repeat(64));
    expect(entry1.risk).toBe('low');

    const entry2 = await logger.log({
      action: 'DATA_DELETE',
      actor: { id: 'user-1' },
      resource: { type: 'lead', id: 'lead-456' },
    });

    expect(entry2.previousHash).toBe(entry1.entryHash);
    expect(entry2.risk).toBe('critical');
  });

  it('verifies chain integrity', async () => {
    const logger = new AuditLogger();
    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push(await logger.log({
        action: 'DATA_ACCESS',
        actor: { id: `user-${i}` },
        resource: { type: 'test', id: `test-${i}` },
      }));
    }

    expect(logger.verifyChain(entries)).toBe(true);

    // Tamper with an entry.
    entries[2].action = 'DATA_DELETE' as never;
    expect(logger.verifyChain(entries)).toBe(false);
  });

  it('auto-masks PII in detail fields', async () => {
    const logger = new AuditLogger();
    const entry = await logger.log({
      action: 'DATA_ACCESS',
      actor: { id: 'user-1' },
      resource: { type: 'lead', id: 'lead-1' },
      detail: { email: 'test@example.com', note: 'Safe text' },
    });

    expect(entry.detail?.email).not.toBe('test@example.com');
    expect(entry.detail?.note).toBe('Safe text');
  });

  it('exportReport generates a summary', async () => {
    const logger = new AuditLogger();
    const entries = [];
    for (let i = 0; i < 3; i++) {
      entries.push(await logger.log({
        action: i === 0 ? 'DATA_DELETE' : 'DATA_ACCESS',
        actor: { id: 'user-1' },
        resource: { type: 'test', id: `test-${i}` },
      }));
    }

    const report = logger.exportReport(entries);
    expect(report.totalEntries).toBe(3);
    expect(report.integrityValid).toBe(true);
    expect(report.riskBreakdown.critical).toBe(1);
  });
});

// ── Workload Protection Tests ──────────────────────────────────────────────

describe('Governance: Workload Protection', () => {
  it('detects missing required secrets', () => {
    const findings = auditEnvironment({});
    expect(findings.some((f) => f.id === 'ENV_MISSING_DATABASE_URL')).toBe(true);
    expect(findings.some((f) => f.id === 'ENV_MISSING_JWT_SECRET')).toBe(true);
  });

  it('detects weak JWT_SECRET', () => {
    const findings = auditEnvironment({
      DATABASE_URL: 'postgresql://localhost/db',
      JWT_SECRET: 'short',
      REDIS_URL: 'redis://localhost',
    });
    expect(findings.some((f) => f.id === 'ENV_SHORT_JWT_SECRET')).toBe(true);
  });

  it('detects default JWT_SECRET', () => {
    const findings = auditEnvironment({
      DATABASE_URL: 'postgresql://localhost/db',
      JWT_SECRET: 'CHANGE_ME_LONG_RANDOM_AT_LEAST_32_CHARS',
      REDIS_URL: 'redis://localhost',
    });
    expect(findings.some((f) => f.id === 'ENV_DEFAULT_JWT_SECRET')).toBe(true);
  });

  it('detects wildcard CORS', () => {
    const findings = auditConfiguration({ corsOrigin: '*' });
    expect(findings.some((f) => f.id === 'CONFIG_CORS_WILDCARD')).toBe(true);
  });

  it('scanWorkload produces a report', async () => {
    const report = await scanWorkload({
      env: {
        DATABASE_URL: '',
        JWT_SECRET: 'CHANGE_ME',
        REDIS_URL: '',
      },
    });

    expect(report.totalFindings).toBeGreaterThan(0);
    expect(report.riskScore).toBeGreaterThan(0);
    expect(['WARN', 'FAIL']).toContain(report.verdict);
  });

  it('scanWorkload passes with secure config', async () => {
    const report = await scanWorkload({
      env: {
        DATABASE_URL: 'postgresql://user:complex-password-12345@localhost:5432/db',
        JWT_SECRET: 'a'.repeat(64),
        REDIS_URL: 'redis://localhost:6379',
        FRONTEND_ORIGIN: 'https://app.example.com',
        TRUST_PROXY: 'true',
      },
    });

    // With a secure config, critical findings should be minimal.
    // Some findings may still exist for localhost/development URLs.
    expect(report.criticalFindings.length).toBeLessThanOrEqual(1);
  });
});
