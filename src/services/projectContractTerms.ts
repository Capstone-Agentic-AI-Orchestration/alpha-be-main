import type { ContractClause, ContractTerms } from '../store/clientProjectStageStore.js';

/**
 * Alphaexplora's standard development contract. The PM writes its scope and
 * deliverables, and may edit the clauses and notes before issuing it; once
 * issued, the text is fixed and its hash is what the client and the PM sign.
 *
 * The features themselves live as tasks on the project's board, so the first
 * draft starts with no deliverables rather than a second feature list.
 */

export interface ContractSource {
  projectName: string;
  clientName: string;
  revisionLimit: number;
}

const rounds = (limit: number) => {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const word = words[limit] ?? String(limit);
  return `${word} (${limit}) round${limit === 1 ? '' : 's'}`;
};

export function defaultContractClauses(revisionLimit: number): ContractClause[] {
  return [
    { title: 'Proof of Concept (POC) Stage',
      body: 'During the POC stage both parties discussed the proposed design, features and overall concept until they met the '
        + "client's expectations. This contract sets out the scope agreed at the end of that stage." },
    { title: 'Contract Signing',
      body: 'Both parties sign this development contract, confirming the agreed project scope, specifications, deliverables and '
        + 'terms set out here.' },
    { title: 'Product Development Stage',
      body: `The developed product includes a maximum of ${rounds(revisionLimit)} of revisions based on the agreed scope and project `
        + 'specifications. A round is one set of feedback on a shared build. Fixing defects, or anything that does not match the agreed '
        + 'scope, is not a revision. Further rounds cost additional and are billed separately.' },
    { title: 'Project Completion and Contract Closure',
      body: 'Upon completion, delivery and final acceptance of the agreed deliverables, this contract is considered closed.' },
    { title: 'Additional Requests After Contract Closure',
      body: 'Any new features, modifications, enhancements or requests made after contract closure that fall outside the original '
        + 'agreed scope are subject to additional charges, agreed separately before the work starts.' },
  ];
}

/** The contract as first drafted: the project's name as its scope title, no deliverables yet, and the standard clauses. */
export function defaultContractTerms(source: ContractSource): ContractTerms {
  return {
    projectName: source.projectName,
    clientName: source.clientName,
    scope: { title: source.projectName, summary: '' },
    deliverables: [],
    revisionLimit: source.revisionLimit,
    clauses: defaultContractClauses(source.revisionLimit),
    notes: '',
  };
}
