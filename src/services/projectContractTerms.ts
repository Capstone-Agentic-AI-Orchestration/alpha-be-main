import type { ContractClause, ContractTerms, PocFeature } from '../store/clientProjectStageStore.js';

/**
 * Alphaexplora's standard development contract, filled in from the approved
 * proof of concept. The PM may edit the deliverables, clauses and notes before
 * issuing it; once issued, the text is fixed and its hash is what the client
 * and the PM sign.
 */

export interface ContractSource {
  projectName: string;
  clientName: string;
  revisionLimit: number;
  poc: { number: number; title: string; summary: string; features: PocFeature[]; screens: string[]; outOfScope: string };
}

const rounds = (limit: number) => {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const word = words[limit] ?? String(limit);
  return `${word} (${limit}) round${limit === 1 ? '' : 's'}`;
};

export function defaultContractClauses(revisionLimit: number, pocNumber: number): ContractClause[] {
  return [
    { title: 'Proof of Concept (POC) Stage',
      body: 'Unlimited revisions were allowed during the POC stage to make sure the proposed design, features and overall concept '
        + `met the client's expectations. This contract is based on POC version ${pocNumber}, which the client approved.` },
    { title: 'POC Approval and Contract Signing',
      body: 'With the POC formally approved, both parties sign this development contract, confirming the agreed project scope, '
        + 'specifications, deliverables and terms set out here.' },
    { title: 'Product Development Stage',
      body: `The developed product includes a maximum of ${rounds(revisionLimit)} of revisions based on the approved POC and the agreed `
        + 'project specifications. A round is one set of feedback on a shared build. Fixing defects, or anything that does not match '
        + 'the approved POC, is not a revision. Further rounds cost additional and are billed separately.' },
    { title: 'Project Completion and Contract Closure',
      body: 'Upon completion, delivery and final acceptance of the agreed deliverables, this contract is considered closed.' },
    { title: 'Additional Requests After Contract Closure',
      body: 'Any new features, modifications, enhancements or requests made after contract closure that fall outside the original '
        + 'agreed scope are subject to additional charges, agreed separately before the work starts.' },
  ];
}

/** The contract as first drafted: the POC's scope, its features as deliverables, and the standard clauses. */
export function defaultContractTerms(source: ContractSource): ContractTerms {
  return {
    projectName: source.projectName,
    clientName: source.clientName,
    scope: { pocNumber: source.poc.number, title: source.poc.title, summary: source.poc.summary, features: source.poc.features,
      screens: source.poc.screens, outOfScope: source.poc.outOfScope },
    deliverables: source.poc.features.map(feature => feature.title),
    revisionLimit: source.revisionLimit,
    clauses: defaultContractClauses(source.revisionLimit, source.poc.number),
    notes: '',
  };
}
