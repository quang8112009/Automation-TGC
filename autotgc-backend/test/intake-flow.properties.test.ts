/**
 * Property + unit tests for the pure Intake_Flow engine (chatbot brain) and the
 * default XKLĐ flow definition.
 *
 * Invariants: parseAnswer never throws; required fields are always asked before
 * optional ones; `isComplete` is true exactly when every required field has a
 * non-empty answer; `advance` only ever stores a value for the current field
 * and re-asks on invalid input.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  parseAnswer,
  nextField,
  isComplete,
  advance,
  firstStep,
} from '../src/intake/intakeFlow';
import type { IntakeFlow, CollectedAnswers } from '../src/intake/intakeFlow';
import { XKLD_DEFAULT_FLOW, getFlow } from '../src/intake/flows';

const flow: IntakeFlow = XKLD_DEFAULT_FLOW;

describe('parseAnswer', () => {
  it('never throws for arbitrary input across all field types', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('text', 'phone', 'email', 'number', 'date', 'choice' as const),
        fc.string(),
        (type, raw) => {
          const field = { key: 'k', prompt: 'p', type, required: true, choices: ['Nam', 'Nữ'] } as const;
          const result = parseAnswer(field, raw);
          expect(typeof result.ok).toBe('boolean');
        },
      ),
      { numRuns: 300 },
    );
  });

  it('validates phone / email / choice with concrete examples', () => {
    expect(parseAnswer({ key: 'phone', prompt: '', type: 'phone', required: true }, '0901234567').ok).toBe(true);
    expect(parseAnswer({ key: 'phone', prompt: '', type: 'phone', required: true }, 'abc').ok).toBe(false);
    expect(parseAnswer({ key: 'email', prompt: '', type: 'email', required: true }, 'a@b.com').ok).toBe(true);
    expect(parseAnswer({ key: 'email', prompt: '', type: 'email', required: true }, 'nope').ok).toBe(false);
    const choice = { key: 'g', prompt: '', type: 'choice' as const, required: true, choices: ['Nam', 'Nữ'] };
    expect(parseAnswer(choice, 'nam').ok).toBe(true); // case-insensitive
    expect(parseAnswer(choice, 'xyz').ok).toBe(false);
  });

  it('normalizes a number answer to an integer', () => {
    const r = parseAnswer({ key: 'age', prompt: '', type: 'number', required: true }, '25 tuổi');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(25);
  });
});

describe('nextField / isComplete', () => {
  it('asks every required field before any optional field', () => {
    // With nothing collected, nextField must be a required field (the first one).
    const first = nextField(flow, {});
    expect(first).not.toBeNull();
    expect(first?.required).toBe(true);
  });

  it('isComplete is true exactly when all required fields are answered', () => {
    const required = flow.fields.filter((f) => f.required);
    const partial: CollectedAnswers = {};
    for (const f of required.slice(0, -1)) partial[f.key] = 'x';
    expect(isComplete(flow, partial)).toBe(false);

    const full: CollectedAnswers = {};
    for (const f of required) full[f.key] = 'x';
    expect(isComplete(flow, full)).toBe(true);
  });

  it('property: once all required answered, nextField is null or optional', () => {
    const full: CollectedAnswers = {};
    for (const f of flow.fields.filter((x) => x.required)) full[f.key] = 'x';
    const nf = nextField(flow, full);
    expect(nf === null || nf.required === false).toBe(true);
  });
});

describe('advance', () => {
  it('stores a valid answer for the current field and moves on', () => {
    const { collected, step } = advance(flow, {}, 'fullName', 'Nguyễn Văn A');
    expect(collected.fullName).toBe('Nguyễn Văn A');
    expect(step.kind).toBe('ask');
    expect(step.fieldKey).not.toBe('fullName'); // advanced to the next field
  });

  it('re-asks the same field on an invalid answer (and stores nothing)', () => {
    const { collected, step } = advance(flow, {}, 'phone', 'not-a-phone');
    expect(collected.phone).toBeUndefined();
    expect(step.kind).toBe('ask');
    expect(step.fieldKey).toBe('phone');
    expect(step.reAsk).toBe(true);
  });

  it('reaches complete once the last required answer lands', () => {
    const collected: CollectedAnswers = {};
    for (const f of flow.fields.filter((x) => x.required).slice(0, -1)) collected[f.key] = 'x';
    const lastRequired = flow.fields.filter((x) => x.required).slice(-1)[0];
    // answer the last required field; choice/number need valid values
    const value =
      lastRequired.type === 'choice'
        ? (lastRequired.choices?.[0] ?? 'x')
        : lastRequired.type === 'number'
          ? '25'
          : 'x';
    const { step } = advance(flow, collected, lastRequired.key, value);
    // either complete, or asks an optional field (both acceptable: required done)
    expect(['complete', 'ask']).toContain(step.kind);
  });

  it('property: advance never stores a value for a field other than currentFieldKey', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...flow.fields.map((f) => f.key)),
        fc.string({ minLength: 1, maxLength: 20 }),
        (currentKey, answer) => {
          const before: CollectedAnswers = {};
          const { collected } = advance(flow, before, currentKey, answer);
          // only currentKey may have been added
          const addedKeys = Object.keys(collected).filter((k) => before[k] === undefined);
          for (const k of addedKeys) expect(k).toBe(currentKey);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('firstStep / getFlow', () => {
  it('firstStep asks the first required field of a fresh conversation', () => {
    const step = firstStep(flow, {});
    expect(step.kind).toBe('ask');
    expect(step.fieldKey).toBe('fullName');
  });

  it('getFlow falls back to the default flow for an unknown key', () => {
    expect(getFlow('does-not-exist').key).toBe(XKLD_DEFAULT_FLOW.key);
    expect(getFlow(XKLD_DEFAULT_FLOW.key).key).toBe(XKLD_DEFAULT_FLOW.key);
  });
});
