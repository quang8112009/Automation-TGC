/**
 * Response Masking — tests.
 *
 * Tests the role-based PII masking for API responses:
 *   - Lead masking at each access level
 *   - Candidate masking at each access level
 *   - List response masking
 *   - Nested field masking
 *   - Null/undefined passthrough
 *   - Access level resolution from role
 *   - Intake conversation masking
 */
import { describe, it, expect } from 'vitest';
import {
  maskLeadResponse,
  maskLeadsResponse,
  maskCandidateResponse,
  maskCandidatesResponse,
  maskIntakeResponse,
  maskLeadListResponse,
  maskCandidateListResponse,
  resolveAccessLevel,
  maskObject,
  maskArray,
  type PiiAccessLevel,
} from '../src/governance/responseMasking';

// ── Test Data ────────────────────────────────────────────────────────────────

const sampleLead = {
  leadId: 'lead-1',
  name: 'Nguyen Van A',
  phone: '0912345678',
  email: 'nguyen@example.com',
  note: 'Interested in Japan program',
  source: 'website_form',
  status: 'NEW',
};

const sampleCandidate = {
  id: 'cand-1',
  fullName: 'Tran Thi B',
  phone: '0987654321',
  email: 'tran@test.com',
  dob: '1995-06-15',
  gender: 'female',
  nationalId: '001234567890',
  passportNo: 'B1234567',
  address: '123 Le Loi, HCMC',
  bankAccount: '1234567890',
  bankName: 'Vietcombank',
  taxId: '1234567890',
  stage: 'DOCUMENT',
};

const sampleConversation = {
  id: 'conv-1',
  externalUserId: 'fb-user-12345',
  displayName: 'Nguyen Van C',
  lastMessage: 'Xin chào, tôi muốn tư vấn',
  channel: 'FACEBOOK',
  status: 'ACTIVE',
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Response Masking', () => {
  // ── Access Level Resolution ────────────────────────────────────────────

  describe('resolveAccessLevel', () => {
    it('resolves ADMIN role to ADMIN level', () => {
      expect(resolveAccessLevel('ADMIN')).toBe('ADMIN');
    });

    it('resolves SALES role to SALES level', () => {
      expect(resolveAccessLevel('SALES')).toBe('SALES');
    });

    it('resolves unknown role to EXTERNAL level', () => {
      expect(resolveAccessLevel('GUEST')).toBe('EXTERNAL');
    });

    it('resolves undefined role to EXTERNAL level', () => {
      expect(resolveAccessLevel(undefined)).toBe('EXTERNAL');
    });

    it('resolves service account to SYSTEM level', () => {
      expect(resolveAccessLevel('SALES', true)).toBe('SYSTEM');
    });
  });

  // ── Lead Masking ──────────────────────────────────────────────────────

  describe('maskLeadResponse', () => {
    it('ADMIN sees full data (no masking)', () => {
      const masked = maskLeadResponse(sampleLead, 'ADMIN');
      expect(masked.name).toBe('Nguyen Van A');
      expect(masked.phone).toBe('0912345678');
      expect(masked.email).toBe('nguyen@example.com');
    });

    it('SALES sees partial masking (name fully hidden, phone/email partial)', () => {
      const masked = maskLeadResponse(sampleLead, 'SALES');
      // Name is ADMIN-only → should be masked
      expect(masked.name).not.toBe('Nguyen Van A');
      // Phone is SALES-level → should be visible
      expect(masked.phone).toBe('0912345678');
      // Email is SALES-level → should be visible
      expect(masked.email).toBe('nguyen@example.com');
      // Note is SALES-level → should be visible
      expect(masked.note).toBe('Interested in Japan program');
    });

    it('EXTERNAL sees full masking', () => {
      const masked = maskLeadResponse(sampleLead, 'EXTERNAL');
      expect(masked.name).not.toBe('Nguyen Van A');
      expect(masked.phone).not.toBe('0912345678');
      expect(masked.email).not.toBe('nguyen@example.com');
      expect(masked.note).not.toBe('Interested in Japan program');
    });

    it('SYSTEM sees full data (no masking)', () => {
      const masked = maskLeadResponse(sampleLead, 'SYSTEM');
      expect(masked.name).toBe('Nguyen Van A');
      expect(masked.phone).toBe('0912345678');
      expect(masked.email).toBe('nguyen@example.com');
    });

    it('non-PII fields are never masked', () => {
      const masked = maskLeadResponse(sampleLead, 'EXTERNAL');
      expect(masked.leadId).toBe('lead-1');
      expect(masked.source).toBe('website_form');
      expect(masked.status).toBe('NEW');
    });
  });

  // ── Candidate Masking ─────────────────────────────────────────────────

  describe('maskCandidateResponse', () => {
    it('ADMIN sees most data (nationalId/passport/bankAccount/taxId masked)', () => {
      const masked = maskCandidateResponse(sampleCandidate, 'ADMIN');
      expect(masked.fullName).toBe('Tran Thi B');
      expect(masked.phone).toBe('0987654321');
      expect(masked.email).toBe('tran@test.com');
      // SYSTEM-only fields are masked even for ADMIN
      expect(masked.nationalId).not.toBe('001234567890');
      expect(masked.passportNo).not.toBe('B1234567');
      expect(masked.bankAccount).not.toBe('1234567890');
      expect(masked.taxId).not.toBe('1234567890');
    });

    it('SALES sees partial masking on name, full masking on IDs', () => {
      const masked = maskCandidateResponse(sampleCandidate, 'SALES');
      // Name is ADMIN-only → masked
      expect(masked.fullName).not.toBe('Tran Thi B');
      // Phone is SALES-level → visible
      expect(masked.phone).toBe('0987654321');
      // Email is SALES-level → visible
      expect(masked.email).toBe('tran@test.com');
      // DOB is ADMIN-only → masked
      expect(masked.dob).not.toBe('1995-06-15');
      // Gender is ADMIN-only → masked
      expect(masked.gender).not.toBe('female');
      // National ID is SYSTEM-only → fully masked
      expect(masked.nationalId).not.toBe('001234567890');
    });

    it('EXTERNAL sees full masking on all PII fields', () => {
      const masked = maskCandidateResponse(sampleCandidate, 'EXTERNAL');
      expect(masked.fullName).not.toBe('Tran Thi B');
      expect(masked.phone).not.toBe('0987654321');
      expect(masked.email).not.toBe('tran@test.com');
      expect(masked.dob).not.toBe('1995-06-15');
      expect(masked.address).not.toBe('123 Le Loi, HCMC');
      expect(masked.nationalId).not.toBe('001234567890');
    });

    it('non-PII fields are never masked', () => {
      const masked = maskCandidateResponse(sampleCandidate, 'EXTERNAL');
      expect(masked.id).toBe('cand-1');
      expect(masked.stage).toBe('DOCUMENT');
    });
  });

  // ── List Masking ──────────────────────────────────────────────────────

  describe('list masking', () => {
    it('masks all items in a leads list', () => {
      const leads = [sampleLead, { ...sampleLead, leadId: 'lead-2', name: 'Le Van C' }];
      const masked = maskLeadsResponse(leads, 'EXTERNAL');
      expect(masked).toHaveLength(2);
      expect(masked[0].name).not.toBe('Nguyen Van A');
      expect(masked[1].name).not.toBe('Le Van C');
    });

    it('masks all items in a candidates list', () => {
      const candidates = [sampleCandidate];
      const masked = maskCandidatesResponse(candidates, 'EXTERNAL');
      expect(masked).toHaveLength(1);
      expect(masked[0].fullName).not.toBe('Tran Thi B');
    });

    it('maskLeadListResponse masks items but preserves metadata', () => {
      const response = {
        items: [sampleLead],
        total: 1,
        page: 1,
        limit: 20,
      };
      const masked = maskLeadListResponse(response, 'EXTERNAL');
      expect(masked.total).toBe(1);
      expect(masked.page).toBe(1);
      expect(masked.items[0].name).not.toBe('Nguyen Van A');
    });

    it('maskCandidateListResponse masks items but preserves metadata', () => {
      const response = {
        items: [sampleCandidate],
        total: 1,
        page: 1,
        limit: 20,
      };
      const masked = maskCandidateListResponse(response, 'EXTERNAL');
      expect(masked.total).toBe(1);
      expect(masked.items[0].fullName).not.toBe('Tran Thi B');
    });
  });

  // ── Intake Masking ────────────────────────────────────────────────────

  describe('maskIntakeResponse', () => {
    it('SALES sees partial masking on intake fields', () => {
      const masked = maskIntakeResponse(sampleConversation, 'SALES');
      expect(masked.id).toBe('conv-1');
      expect(masked.channel).toBe('FACEBOOK');
      expect(masked.status).toBe('ACTIVE');
      // externalUserId is SALES-level → should be visible
      expect(masked.externalUserId).toBe('fb-user-12345');
    });

    it('EXTERNAL sees masking on intake fields', () => {
      const masked = maskIntakeResponse(sampleConversation, 'EXTERNAL');
      expect(masked.id).toBe('conv-1');
      expect(masked.externalUserId).not.toBe('fb-user-12345');
    });
  });

  // ── Generic maskObject ────────────────────────────────────────────────

  describe('maskObject', () => {
    it('returns same object for SYSTEM level', () => {
      const obj = { name: 'Test', phone: '0912345678' };
      const result = maskObject(obj, 'SYSTEM', { resourceType: 'test', fields: [] });
      expect(result).toBe(obj); // Same reference
    });

    it('handles empty fields config', () => {
      const obj = { name: 'Test' };
      const result = maskObject(obj, 'EXTERNAL', { resourceType: 'test', fields: [] });
      expect(result.name).toBe('Test');
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles null/undefined PII fields gracefully', () => {
      const lead = { ...sampleLead, phone: null, email: undefined };
      const masked = maskLeadResponse(lead, 'EXTERNAL');
      expect(masked.phone).toBeNull();
      expect(masked.email).toBeUndefined();
    });

    it('handles empty string PII fields', () => {
      const lead = { ...sampleLead, phone: '' };
      const masked = maskLeadResponse(lead, 'EXTERNAL');
      expect(masked.phone).toBe('');
    });

    it('preserves array fields that are not PII', () => {
      const lead = { ...sampleLead, tags: ['japan', 'urgent'] };
      const masked = maskLeadResponse(lead, 'EXTERNAL');
      expect(masked.tags).toEqual(['japan', 'urgent']);
    });
  });
});
