import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { validateRegistration, validateLoginShape } from '../src/auth/validation';
import { authorize } from '../src/auth/rbac';
import type { Module, Action } from '../src/auth/rbac';

describe('foundation-and-deployment', () => {
  // Feature: foundation-and-deployment, Property 1: Registration input validation
  it('Property 1: registration accepts iff all rules pass', () => {
    fc.assert(
      fc.property(
        fc.record({
          username: fc.string(),
          email: fc.string(),
          password: fc.string(),
          passwordConfirmation: fc.string(),
        }),
        (input) => {
          const r = validateRegistration(input);
          const emailOk = input.email.length > 0 && input.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email);
          const pwOk = input.password.length >= 8 && input.password.length <= 128;
          const matchOk = input.password === input.passwordConfirmation;
          const userOk = input.username.trim().length > 0 && input.username.length <= 50;
          const expected = emailOk && pwOk && matchOk && userOk;
          expect(r.ok).toBe(expected);
          if (!r.ok) expect(r.status).toBe(400);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: foundation-and-deployment, Property: valid registration passes
  it('accepts a known-good registration', () => {
    const r = validateRegistration({ username: 'alice', email: 'a@b.co', password: 'password123', passwordConfirmation: 'password123' });
    expect(r.ok).toBe(true);
  });

  // Feature: foundation-and-deployment, login shape
  it('login rejects empty username/password with 400', () => {
    expect(validateLoginShape({ username: '', password: 'x' }).ok).toBe(false);
    expect(validateLoginShape({ username: 'u', password: '' }).ok).toBe(false);
    expect(validateLoginShape({ username: 'u', password: 'p' }).ok).toBe(true);
  });

  // Feature: foundation-and-deployment, Property 8: RBAC decisions
  it('Property 8: RBAC matches role/module/action policy', () => {
    const modules: Module[] = ['strategy', 'generation', 'publishing', 'analytics', 'feedback', 'lead_management', 'settings', 'dashboard'];
    const actions: Action[] = ['read', 'create', 'update', 'delete', 'status_update'];
    fc.assert(
      fc.property(
        fc.constantFrom('ADMIN', 'SALES') as fc.Arbitrary<'ADMIN' | 'SALES'>,
        fc.constantFrom(...modules),
        fc.constantFrom(...actions),
        fc.boolean(),
        (role, module, action, assignedToSelf) => {
          const ctx = { userId: 'u1', role };
          const ownerUserId = module === 'lead_management' ? (assignedToSelf ? 'u1' : 'u2') : undefined;
          const d = authorize(ctx, { module, action, ownerUserId });
          if (role === 'ADMIN') {
            expect(d.allowed).toBe(true);
            return;
          }
          // SALES
          if (module === 'lead_management') {
            // SALES may read/update/status_update assigned leads; never create or delete.
            if (action === 'delete' || action === 'create') expect(d.allowed).toBe(false);
            else if (!assignedToSelf) expect(d.allowed).toBe(false);
            else expect(d.allowed).toBe(true);
          } else if (module === 'dashboard') {
            const isWrite = action !== 'read';
            expect(d.allowed).toBe(!isWrite);
          } else {
            expect(d.allowed).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
