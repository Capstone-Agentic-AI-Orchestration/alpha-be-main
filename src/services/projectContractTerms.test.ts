import { describe, expect, it } from 'vitest';
import { defaultContractTerms } from './projectContractTerms.js';
import { contentHash } from './projectStageRules.js';

const source = { projectName: 'Project A', clientName: 'Client A', revisionLimit: 3 };

describe('default contract terms', () => {
  it('starts from the project name, no deliverables, and the revision limit in the clauses', () => {
    const terms = defaultContractTerms(source);
    expect(terms.scope).toEqual({ title: 'Project A', summary: '' });
    // The features live on the board; the draft does not copy a feature list.
    expect(terms.deliverables).toEqual([]);
    expect(terms.clauses).toHaveLength(5);
    expect(terms.clauses[2]?.body).toContain('three (3) rounds');
    expect(defaultContractTerms({ ...source, revisionLimit: 1 }).clauses[2]?.body).toContain('one (1) round of');
    expect(terms.clauses.map(clause => clause.body).join(' ')).not.toMatch(/POC version|approved POC/);
  });

  it('hashes the same terms the same way', () => {
    expect(contentHash(defaultContractTerms(source))).toBe(contentHash(defaultContractTerms(structuredClone(source))));
    expect(contentHash(defaultContractTerms(source))).not.toBe(contentHash(defaultContractTerms({ ...source, revisionLimit: 4 })));
  });
});
