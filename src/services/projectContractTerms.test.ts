import { describe, expect, it } from 'vitest';
import { defaultContractTerms } from './projectContractTerms.js';
import { contentHash } from './projectStageRules.js';

const source = {
  projectName: 'Project A', clientName: 'Client A', revisionLimit: 3,
  poc: { number: 2, title: 'Booking site', summary: 'Book a table', features: [{ title: 'Online booking', detail: '' }, { title: 'Email', detail: 'x' }],
    screens: ['Home'], outOfScope: 'Payments' },
};

describe('default contract terms', () => {
  it('carries the approved POC as scope, its features as deliverables, and the revision limit in the clauses', () => {
    const terms = defaultContractTerms(source);
    expect(terms.scope).toMatchObject({ pocNumber: 2, title: 'Booking site', outOfScope: 'Payments' });
    expect(terms.deliverables).toEqual(['Online booking', 'Email']);
    expect(terms.clauses).toHaveLength(5);
    expect(terms.clauses[2]?.body).toContain('three (3) rounds');
    expect(defaultContractTerms({ ...source, revisionLimit: 1 }).clauses[2]?.body).toContain('one (1) round of');
    expect(terms.clauses[0]?.body).toContain('POC version 2');
  });

  it('hashes the same terms the same way', () => {
    expect(contentHash(defaultContractTerms(source))).toBe(contentHash(defaultContractTerms(structuredClone(source))));
    expect(contentHash(defaultContractTerms(source))).not.toBe(contentHash(defaultContractTerms({ ...source, revisionLimit: 4 })));
  });
});
