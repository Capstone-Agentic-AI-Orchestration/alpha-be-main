import { describe, it, expect } from 'vitest';
import { agentValidationError } from './agentValidation.js';

/**
 * Agent writes used to be unvalidated — `POST /agents` handed `req.body`
 * straight to SQLite. The client counts the description as it is typed, but a
 * seeded or scripted payload never passes through that counter, so the limit
 * has to hold here too.
 */
describe('agentValidationError', () => {
  const create = { partial: false };
  const update = { partial: true };

  it('requires a name on create', () => {
    expect(agentValidationError({}, create)).toBe('name is required');
    expect(agentValidationError({ name: '   ' }, create)).toBe('name is required');
    expect(agentValidationError({ name: 'Aegis' }, create)).toBeNull();
  });

  it('leaves an absent field alone on update', () => {
    // A PUT carrying only `{ workStatus }` must not be read as clearing the name.
    expect(agentValidationError({ workStatus: 'idle' }, update)).toBeNull();
  });

  it('still rejects a name explicitly emptied on update', () => {
    expect(agentValidationError({ name: '' }, update)).toBe('name is required');
  });

  it('caps the description at 255 characters', () => {
    expect(agentValidationError({ name: 'A', description: 'x'.repeat(255) }, create)).toBeNull();
    expect(agentValidationError({ name: 'A', description: 'x'.repeat(256) }, create)).toBe(
      'description exceeds 255 characters'
    );
  });

  it('counts characters, not UTF-16 code units', () => {
    // 200 astral-plane emoji are 200 characters but 400 `.length` units. The
    // database stores them as 200, so rejecting them here would be wrong.
    expect(agentValidationError({ name: 'A', description: '🚀'.repeat(200) }, create)).toBeNull();
    expect(agentValidationError({ name: 'A', description: '🚀'.repeat(256) }, create)).toBe(
      'description exceeds 255 characters'
    );
  });
});
