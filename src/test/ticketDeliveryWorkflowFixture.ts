/** TEST-ONLY serialized rollback fixture. Never import from runtime code or
 * substitute this for real run verification, storage/scanning, SQL locks or RLS.
 */
import { createHash } from 'node:crypto';

import { createTicketCommandService } from '../services/ticketCommandService.js';
import { createTicketDeliveryAssessmentService } from '../services/ticketDeliveryAssessmentService.js';
import { createTicketDeliveryRegistrationService } from '../services/ticketDeliveryRegistrationService.js';
import { createTicketDeliveryService } from '../services/ticketDeliveryService.js';
import { DatabaseCommitError } from '../store/database.js';
import type { SavedTicketOperation, TicketChangeSignal, TicketCommandAudit, TicketCommandStore, TicketCommandTransaction, TicketSubject, TicketWriteMode } from '../store/ticketCommandStore.js';
import type { TicketDeliveryAssessmentStore, TicketDeliveryAssessmentTransaction } from '../store/ticketDeliveryAssessmentStore.js';
import type { LockedTicketArtifacts, SavedTicketDeliveryRegistration, TicketArtifactSubject, TicketDeliveryRegistrationAudit, TicketDeliveryRegistrationStore, TicketDeliveryRegistrationTransaction } from '../store/ticketDeliveryRegistrationStore.js';
import type { TicketDeliveryObjectReader, TicketDeliveryReadPolicy, TicketDeliverySnapshot, TicketDeliveryStore, TicketDeliveryTransaction } from '../store/ticketDeliveryStore.js';
import type { SavedTicketReadiness } from '../store/ticketTechnicalReadinessStore.js';
import { ticketReadyManifest } from '../ticketing/technicalReadiness.js';
import { newTicketWorkflow, type TicketActor, type TicketFacts, type TicketWorkflow } from '../ticketing/workflow.js';

export const deliveryTarget = { workspaceId: 'workspace-a', ticketId: 'ticket-a' };
export const deliveryPm: TicketSubject = { kind: 'internal', userId: 'pm-a', authentication: { kind: 'session', sessionId: 'pm-session' } };
export const deliveryClient: TicketSubject = { kind: 'client', userId: 'client-a', sessionId: 'client-session' };
export const deliveryArtifact: TicketArtifactSubject = { kind: 'verified_delivery_artifacts', verificationId: 'artifact-verification' };
export const deliveryPolicy: TicketDeliveryReadPolicy = { maxFiles: 5, maxFileBytes: 1024, maxTotalBytes: 4096, objectReadTimeoutMs: 100 };
export const deliveryBody = Buffer.from('Exact reviewed result');
export const deliveryTimestamp = '2026-10-08T08:00:00.000Z';
export const registrationInput = { schemaVersion: 1, operationId: 'register-result', expectedVersion: 5, publicSummary: 'The reviewed result for the agreed work.' };

type Transaction = TicketCommandTransaction & TicketDeliveryRegistrationTransaction & TicketDeliveryAssessmentTransaction & TicketDeliveryTransaction;
export function ticketDeliveryWorkflowFixture() {
  let data = {
    state: { ...newTicketWorkflow(deliveryTarget.ticketId, deliveryTarget.workspaceId, deliveryClient.userId),
      version: 5, status: 'in_progress', projectId: 'project-a', scopeVersionId: 'scope-a',
      agreedScopeVersionId: 'scope-a', authorizedScopeVersionId: 'scope-a', requiredIssueIds: ['issue-a', 'issue-b'],
      actionOwner: 'pm', nextAction: 'assess_result' } as TicketWorkflow,
    deliveries: new Map<string, TicketDeliverySnapshot>(),
    registrations: new Map<string, SavedTicketDeliveryRegistration>(),
    operations: new Map<string, SavedTicketOperation>(),
    audits: [] as (TicketCommandAudit | TicketDeliveryRegistrationAudit)[],
    signals: [] as TicketChangeSignal[],
  };
  const facts: TicketFacts = {
    clientAccessActive: true, project: { id: 'project-a', workspaceId: deliveryTarget.workspaceId, creatorActive: true, nonProductionSafe: true },
    issues: ['a', 'b'].map(suffix => ({ id: `issue-${suffix}`, revisionId: `revision-${suffix}`, ...deliveryTarget,
      projectId: 'project-a', scopeVersionId: 'scope-a', status: 'done', requiredReviewsPassed: true,
      hasActiveRun: false })),
  };
  const readiness: SavedTicketReadiness = {
    key: { ...deliveryTarget, kind: 'technical_work_ready', actorId: 'dev-a', runId: 'run-a', completionId: 'completion-a', operationId: 'ready-operation' },
    fingerprint: 'a'.repeat(64), manifest: ticketReadyManifest(data.state, facts),
    receipt: { ticketId: deliveryTarget.ticketId, operationId: 'ready-operation', version: 5, status: 'in_progress' },
  };
  const source: LockedTicketArtifacts['source'] = {
    ...deliveryTarget, authorized: true, userId: 'dev-a', runId: 'run-a', completionId: 'completion-a',
    issueId: 'issue-a', issueRevisionId: 'revision-a', bundleId: 'private-bundle-a',
  };
  const sha256 = createHash('sha256').update(deliveryBody).digest('hex');
  const artifactManifest: TicketDeliverySnapshot['manifest'] = {
    ...deliveryTarget, id: source.bundleId, scopeVersionId: 'scope-a', issueRevisionIds: ['revision-a', 'revision-b'], immutable: true,
    files: [{ ...deliveryTarget, id: 'file-a', pinnedAssetId: source.bundleId, filename: 'result.txt', mediaType: 'text/plain',
      byteLength: deliveryBody.length, sha256, immutable: true, clientVisible: true,
      object: { key: 'PRIVATE-object-key', version: 'PRIVATE-object-generation' },
      scan: { verdict: 'clean', sha256, policyVersion: 'scan-policy-1', completedAt: deliveryTimestamp } }],
  };
  const control = {
    access: true, artifactAccess: true, pmActive: true, clientActive: true, developer: false,
    source, artifactManifest, facts, readiness, mode: 'enabled' as TicketWriteMode | undefined,
    failAt: '', cas: true, commitUnknown: false, inTransaction: false, calls: [] as string[],
    duringRead: () => {}, storageError: false, storageBody: deliveryBody as Uint8Array,
    badId: undefined as string | undefined,
  };
  let queue = Promise.resolve();
  function key(value: unknown) { return JSON.stringify(value); }
  async function transaction<T>(work: (tx: Transaction) => Promise<T>) {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const draft = structuredClone(data);
    control.inTransaction = true;
    function step(name: string) { control.calls.push(name); if (control.failAt === name) throw new Error(`Injected ${name} failure`); }
    function candidate(id: string) {
      const snapshot = draft.deliveries.get(id);
      return snapshot ? { snapshot: structuredClone(snapshot), facts: structuredClone(control.facts), readiness: structuredClone(control.readiness) } : null;
    }
    const tx: Transaction = {
      async lockAuthorizedTicket(target, subject) {
        step('authorize');
        if (!control.access || target.workspaceId !== draft.state.workspaceId || target.ticketId !== draft.state.id) return null;
        let actor: TicketActor;
        if (subject.kind === 'client') {
          if (subject.userId !== deliveryClient.userId || subject.sessionId !== 'client-session') return null;
          actor = { kind: 'client', userId: subject.userId, ...deliveryTarget, grantActive: control.clientActive };
        } else {
          if (subject.userId !== deliveryPm.userId || subject.authentication.kind !== 'session' || subject.authentication.sessionId !== 'pm-session') return null;
          actor = control.developer ? { kind: 'developer', userId: subject.userId, workspaceId: target.workspaceId }
            : { kind: 'pm', userId: subject.userId, workspaceId: target.workspaceId, membershipActive: control.pmActive, canManageTickets: true };
        }
        return { state: structuredClone(draft.state), actor, mode: control.mode };
      },
      async lockAuthorizedArtifacts(target, subject) {
        step('artifact-authorize');
        if (!control.artifactAccess || target.workspaceId !== draft.state.workspaceId || target.ticketId !== draft.state.id
          || subject.kind !== deliveryArtifact.kind || subject.verificationId !== deliveryArtifact.verificationId) return null;
        return { state: structuredClone(draft.state), source: structuredClone(control.source), mode: control.mode };
      },
      async findOperation(operationKey: any): Promise<any> {
        step('find'); return structuredClone((operationKey.kind === 'delivery_registration' ? draft.registrations : draft.operations).get(key(operationKey)) ?? null);
      },
      async loadEvidence() { step('evidence'); return { facts: structuredClone(control.facts), readiness: structuredClone(control.readiness), manifest: structuredClone(control.artifactManifest) }; },
      async findRegisteredBundle(ticket) {
        step('bundle'); return structuredClone([...draft.registrations.values()].find(saved => saved.key.bundleId === ticket.source.bundleId) ?? null);
      },
      async insertDelivery(_ticket, version, snapshot) {
        step('insert');
        if (!control.cas || version !== draft.state.version) return false;
        if (draft.deliveries.has(snapshot.delivery.id)) throw new Error('Duplicate delivery ID');
        draft.deliveries.set(snapshot.delivery.id, structuredClone(snapshot)); return true;
      },
      async appendAudit(audit: TicketCommandAudit | TicketDeliveryRegistrationAudit) { step('audit'); draft.audits.push(structuredClone(audit)); },
      async insertOperation(saved: SavedTicketOperation | SavedTicketDeliveryRegistration) {
        step('operation');
        if ('readyManifest' in saved) {
          if (draft.registrations.has(key(saved.key))) throw new Error('Duplicate registration outcome');
          draft.registrations.set(key(saved.key), structuredClone(saved));
        } else {
          if (draft.operations.has(key(saved.key))) throw new Error('Duplicate command outcome');
          draft.operations.set(key(saved.key), structuredClone(saved));
        }
      },
      async loadCandidate(_ticket, id) { step('candidate'); return candidate(id); },
      async loadAssessmentCandidate(_ticket, id) { step('assessment-candidate'); return candidate(id); },
      async loadCandidates(_ticket, page) {
        step('candidates');
        if (page.after && !candidate(page.after)) throw new Error('Unknown scoped cursor');
        return [...draft.deliveries.keys()].sort().filter(id => !page.after || id > page.after).slice(0, page.limit + 1).map(id => candidate(id)!);
      },
      async loadDelivery(_ticket, id) { step('delivery'); return structuredClone(draft.deliveries.get(id) ?? null); },
      async loadFacts(_ticket, command) {
        step('facts');
        const result = structuredClone(control.facts);
        if ('deliveryId' in command.command) {
          const row = draft.deliveries.get(command.command.deliveryId)?.delivery;
          if (row) result.delivery = { id: row.id, scopeVersionId: row.scopeVersionId, pinnedAssetId: row.pinnedAssetId,
            immutable: row.immutable, issueRevisionIds: row.issueRevisionIds };
        }
        return result;
      },
      async saveWorkflow(_target, version, state) {
        step('save'); if (!control.cas || version !== draft.state.version) return false;
        draft.state = structuredClone(state);
        if (state.delivery?.shared) draft.deliveries.get(state.delivery.id)!.delivery.sharedAt = deliveryTimestamp;
        return true;
      },
      async enqueueChange(signal) { step('signal'); draft.signals.push(structuredClone(signal)); },
      async insertWorkBindings() { throw new Error('Unexpected Issue creation/binding'); },
      async reopenIssues() { throw new Error('Unexpected runner/Issue restart'); },
    };
    try {
      const result = await work(tx);
      data = draft;
      if (control.commitUnknown) { control.commitUnknown = false; throw new DatabaseCommitError(new Error('Injected lost COMMIT')); }
      return result;
    } finally { control.inTransaction = false; release(); }
  }
  const registrationStore: TicketDeliveryRegistrationStore = { transaction };
  const assessmentStore: TicketDeliveryAssessmentStore = { transaction };
  const commandStore: TicketCommandStore = { transaction };
  const deliveryStore: TicketDeliveryStore = { transaction };
  const objects: TicketDeliveryObjectReader = { async read() {
    if (control.inTransaction) throw new Error('Storage inside metadata transaction');
    control.calls.push('storage'); control.duringRead();
    if (control.storageError) throw new Error('PRIVATE-storage-error');
    return control.storageBody;
  } };
  let counter = 0;
  const registration = createTicketDeliveryRegistrationService(registrationStore, deliveryPolicy, () => new Date(deliveryTimestamp), () => control.badId ?? `delivery-${++counter}`);
  const assessment = createTicketDeliveryAssessmentService(assessmentStore, objects, deliveryPolicy);
  const commands = createTicketCommandService(commandStore, () => new Date(deliveryTimestamp), undefined, deliveryPolicy);
  const deliveries = createTicketDeliveryService(deliveryStore, objects, deliveryPolicy);
  return { control, registration, assessment, commands, deliveries, assessmentStore, objects,
    get data() { return data; }, register: (input: unknown = registrationInput) => registration.register(deliveryTarget, deliveryArtifact, input) };
}
