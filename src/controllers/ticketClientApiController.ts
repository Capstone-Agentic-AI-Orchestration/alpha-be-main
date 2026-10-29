import type { ClientProjectProposals } from '../services/clientProjectProposals.js';
import { Router, raw, type Request, type Response } from 'express';

import { IS_CLOUD } from '../config/env.js';
import type { TicketClientSessionCheck } from '../services/ticketClientSessionService.js';
import type { TicketMessagePage } from '../services/ticketReadService.js';
import type { TicketDeliveryContent } from '../services/ticketDeliveryService.js';
import { projectTicketDeliveryFile, projectTicketDeliveryManifest, type TicketDeliveryManifest } from '../ticketing/deliveryReadModels.js';
import type { TicketCreationReceipt, TicketOperationReceipt, TicketSubject, TicketTarget } from '../store/ticketCommandStore.js';
import type { TicketQueueCounters } from '../store/ticketQueueStore.js';
import type { ClientTicketQueueItem } from '../ticketing/queueModels.js';
import type { PmTicketQueueItem } from '../ticketing/queueModels.js';
import type { ClientTicketDetail, PublicTicketMessage } from '../ticketing/readModels.js';
import type { TicketStatus } from '../ticketing/workflow.js';
import { TicketReadInvariantError } from '../ticketing/readModels.js';
import type { TicketDocumentsApplication } from './ticketDocumentController.js';
import { parseTicketDocumentMetadata, safeTicketDocuments, secureTicketDocumentResponse, sendTicketDocument } from './ticketDocumentController.js';
import { route } from './asyncRoute.js';
import type { PostgresClientProjectPortal } from '../services/clientProjectPortal.js';
import type { ProjectUat } from '../services/projectUat.js';
import { sendUatEvidence } from './projectUatController.js';
import {
  readTicketClientCookie, ticketClientCookieNames, ticketClientOriginAllowed,
  ticketClientOriginPolicyValid, type TicketClientSessionCookiePolicy,
} from './ticketClientSessionController.js';
import { opaqueTicketRequestValue } from './ticketRequestAuth.js';

interface TicketQueuePage {
  items: Array<ClientTicketQueueItem | PmTicketQueueItem>;
  nextCursor: string | null;
  counters: TicketQueueCounters;
}

/** Application services remain injected; this transport does not create a DB
 * adapter or rely on the PM/desktop GitHub session middleware. */
export interface TicketClientApiApplication {
  projectProposals?: ClientProjectProposals;
  emailFor?(subject: Extract<TicketSubject,{kind:'client'}>): Promise<string|null>;
  projectPortal?: PostgresClientProjectPortal;
  projectUat?: ProjectUat;
  workflowCapabilities(): { phaseWorkflowEnabled: boolean };
  authenticate(sessionCookie: unknown, csrfCookie?: unknown, csrfHeader?: unknown, requireCsrf?: boolean): Promise<TicketClientSessionCheck>;
  listWorkspaces(subject: TicketSubject): Promise<Array<{ workspaceId: string; displayName: string }>>;
  getIntakeContext(workspaceId: string, subject: TicketSubject): Promise<{
    intakeContextId: string; canCreate: boolean; sharedProjects: Array<{ optionId: string; displayName: string }>;
  }>;
  list(workspaceId: string, subject: TicketSubject, input: unknown): Promise<TicketQueuePage>;
  detail(target: TicketTarget, subject: TicketSubject): Promise<ClientTicketDetail | (ClientTicketDetail & { internal: unknown })>;
  deliveryManifest(target: TicketTarget, subject: TicketSubject, deliveryId: string): Promise<TicketDeliveryManifest>;
  deliveryContent(target: TicketTarget, subject: TicketSubject, deliveryId: string, fileId: string): Promise<TicketDeliveryContent>;
  conversation(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketMessagePage<PublicTicketMessage>>;
  reply(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<Extract<TicketOperationReceipt, { messageId: string }>>;
  documents?: TicketDocumentsApplication;
  execute(target: TicketTarget, subject: TicketSubject, input: unknown): Promise<TicketOperationReceipt>;
  lookup(target: TicketTarget, subject: TicketSubject, operationId: string): Promise<TicketOperationReceipt | null>;
  create(contextId: string, subject: TicketSubject, input: unknown): Promise<TicketCreationReceipt>;
  lookupCreation(contextId: string, subject: TicketSubject, operationId: string): Promise<TicketCreationReceipt | null>;
}

const statuses = new Set<TicketStatus>([
  'received', 'under_review', 'awaiting_client', 'in_progress', 'ready_for_review',
  'on_hold', 'closed', 'declined', 'cancelled',
]);
const clientActions = new Set(['reply', 'agree_scope', 'review_result']);
const terminalStatuses = new Set<TicketStatus>(['closed', 'declined', 'cancelled']);

function date(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function secureResponse(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function safeClientQueueItem(value: ClientTicketQueueItem | PmTicketQueueItem): ClientTicketQueueItem {
  if (!value || typeof value !== 'object' || 'internal' in value || !opaqueTicketRequestValue(value.id)
    || !opaqueTicketRequestValue(value.reference) || !text(value.title, 500) || !value.title.trim()
    || !statuses.has(value.status) || !date(value.createdAt) || !date(value.updatedAt)
    || (value.closedAt !== null && !date(value.closedAt)) || typeof value.readOnly !== 'boolean'
    || typeof value.writesAvailable !== 'boolean'
    || (value.requestedAction !== null && !clientActions.has(value.requestedAction))) {
    throw new TicketReadInvariantError();
  }
  if (value.readOnly !== terminalStatuses.has(value.status)
    || (value.writesAvailable && value.readOnly)
    || (!value.writesAvailable && value.requestedAction !== null)) throw new TicketReadInvariantError();
  return {
    id: value.id, reference: value.reference, title: value.title, status: value.status,
    createdAt: value.createdAt, updatedAt: value.updatedAt, closedAt: value.closedAt,
    readOnly: value.readOnly, writesAvailable: value.writesAvailable, requestedAction: value.requestedAction,
  };
}

function safeClientDetail(value: ClientTicketDetail | (ClientTicketDetail & { internal: unknown })): ClientTicketDetail {
  if (!value || typeof value !== 'object' || 'internal' in value || !opaqueTicketRequestValue(value.id)
    || !opaqueTicketRequestValue(value.reference) || !text(value.title, 500) || !value.title.trim()
    || !text(value.description, 6000) || !text(value.companyLabel, 200) || !statuses.has(value.status)
    || !Number.isSafeInteger(value.version) || value.version < 0 || !date(value.createdAt) || !date(value.updatedAt)
    || (value.closedAt !== null && !date(value.closedAt)) || typeof value.readOnly !== 'boolean'
    || typeof value.writesAvailable !== 'boolean'
    || (value.requestedAction !== null && !clientActions.has(value.requestedAction))
    || (value.sharedProjectName !== null && !text(value.sharedProjectName, 200))) {
    throw new TicketReadInvariantError();
  }
  if (value.readOnly !== terminalStatuses.has(value.status)
    || (value.writesAvailable && value.readOnly)
    || (!value.writesAvailable && value.requestedAction !== null)) throw new TicketReadInvariantError();
  let relatedTicket: ClientTicketDetail['relatedTicket'] = null;
  if (value.relatedTicket !== null) {
    const related = value.relatedTicket;
    if (!related || !opaqueTicketRequestValue(related.id) || !opaqueTicketRequestValue(related.reference)
      || !text(related.title, 500)) throw new TicketReadInvariantError();
    relatedTicket = { id: related.id, reference: related.reference, title: related.title };
  }
  let scope: ClientTicketDetail['scope'] = null;
  if (value.scope !== null) {
    const current = value.scope;
    if (!current || !opaqueTicketRequestValue(current.id) || !text(current.summary, 4000)
      || !date(current.proposedAt) || typeof current.agreed !== 'boolean') throw new TicketReadInvariantError();
    scope = { id: current.id, summary: current.summary, proposedAt: current.proposedAt, agreed: current.agreed };
  }
  let delivery: ClientTicketDetail['delivery'] = null;
  if (value.delivery !== null) {
    const current = value.delivery;
    if (!current || !opaqueTicketRequestValue(current.id) || !opaqueTicketRequestValue(current.scopeVersionId)
      || !text(current.summary, 4000) || !date(current.sharedAt) || typeof current.accepted !== 'boolean') {
      throw new TicketReadInvariantError();
    }
    delivery = {
      id: current.id, scopeVersionId: current.scopeVersionId, summary: current.summary,
      sharedAt: current.sharedAt, accepted: current.accepted,
    };
  }
  let request: ClientTicketDetail['request'] = null;
  if (value.request !== null) {
    const current = value.request;
    if (!current || !['not_sure', 'new_project', 'shared_project'].includes(current.projectPreference)
      || (current.projectLabel !== null && !text(current.projectLabel, 200))
      || (current.requestedDeadline !== null && !/^\d{4}-\d{2}-\d{2}$/.test(current.requestedDeadline))) {
      throw new TicketReadInvariantError();
    }
    request = {
      projectPreference: current.projectPreference, projectLabel: current.projectLabel,
      requestedDeadline: current.requestedDeadline,
    };
  }
  return {
    id: value.id, reference: value.reference, title: value.title, description: value.description,
    companyLabel: value.companyLabel, status: value.status, version: value.version,
    createdAt: value.createdAt, updatedAt: value.updatedAt, closedAt: value.closedAt,
    readOnly: value.readOnly, writesAvailable: value.writesAvailable, requestedAction: value.requestedAction,
    sharedProjectName: value.sharedProjectName,
    ...(value.sharedProjectPreviewUrl ? { sharedProjectPreviewUrl: value.sharedProjectPreviewUrl } : {}),
    relatedTicket, scope, delivery, request,
  };
}

function safeMessages(page: TicketMessagePage<PublicTicketMessage>): TicketMessagePage<PublicTicketMessage> {
  if (!page || !Array.isArray(page.items) || page.items.length > 100
    || (page.nextCursor !== null && !opaqueTicketRequestValue(page.nextCursor))) throw new TicketReadInvariantError();
  const items = page.items.map(message => {
    if (!message || !opaqueTicketRequestValue(message.id) || !['pm', 'client'].includes(message.author)
      || !text(message.body, 4000) || !date(message.createdAt)) throw new TicketReadInvariantError();
    return { id: message.id, author: message.author, body: message.body, createdAt: message.createdAt };
  });
  if (page.nextCursor !== null && items.at(-1)?.id !== page.nextCursor) throw new TicketReadInvariantError();
  return { items, nextCursor: page.nextCursor };
}

function safeCounters(value: TicketQueueCounters): Extract<TicketQueueCounters, { kind: 'client' }> {
  if (!value || value.kind !== 'client' || !Number.isSafeInteger(value.open) || value.open < 0
    || !Number.isSafeInteger(value.needsClient) || value.needsClient < 0 || value.needsClient > value.open) {
    throw new TicketReadInvariantError();
  }
  return { kind: 'client', open: value.open, needsClient: value.needsClient };
}

function safeReceipt(value: TicketOperationReceipt | null, ticketId?: string): object | null {
  if (value === null) return null;
  if (!value || !opaqueTicketRequestValue(value.ticketId) || (ticketId && value.ticketId !== ticketId)
    || !opaqueTicketRequestValue(value.operationId) || !Number.isSafeInteger(value.version)
    || value.version < 0 || !statuses.has(value.status)) throw new TicketReadInvariantError();
  const receipt = { ticketId: value.ticketId, operationId: value.operationId, version: value.version, status: value.status };
  if ('messageId' in value) {
    if (!opaqueTicketRequestValue(value.messageId)) throw new TicketReadInvariantError();
    return { ...receipt, messageId: value.messageId };
  }
  if ('reference' in value) {
    if (!opaqueTicketRequestValue(value.reference)) throw new TicketReadInvariantError();
    return { ...receipt, reference: value.reference };
  }
  return receipt;
}

function serviceQueryInput(query: Request['query']): Record<string, unknown> {
  // Preserve malformed/unknown query shapes for the service schema to reject
  // only AFTER its transaction has rechecked client/workspace/ticket access.
  const input: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(query)) {
    input[key] = key === 'limit' && typeof value === 'string' && /^\d{1,3}$/.test(value)
      ? Number(value) : value;
  }
  return input;
}

/** Separate cookie/CSRF client transport. Mount only after durable app stores,
 * identity verification and rate/origin settings are supplied. */
export function createTicketClientApiRouter(
  application: TicketClientApiApplication,
  policy: TicketClientSessionCookiePolicy,
): Router {
  const router = Router();
  const policyValid = ticketClientOriginPolicyValid(policy?.secure, policy?.allowedOrigins);
  const secure = policy?.secure === true;
  const cookieNames = ticketClientCookieNames(secure);
  const origins = new Set(policyValid ? policy.allowedOrigins : []);

  function available(res: Response): boolean {
    secureResponse(res);
    if (!IS_CLOUD) {
      res.status(503).json({ error: 'Client ticketing is available only through the Alpha web service.' });
      return false;
    }
    if (!policyValid) {
      res.status(503).json({ error: 'Client ticketing is not configured.' });
      return false;
    }
    return true;
  }

  async function authenticate(req: Request, res: Response, requireCsrf: boolean): Promise<Extract<TicketSubject, { kind: 'client' }> | null> {
    let result: TicketClientSessionCheck;
    result = await application.authenticate(
      readTicketClientCookie(req, cookieNames.session),
      requireCsrf ? readTicketClientCookie(req, cookieNames.csrf) : undefined,
      requireCsrf ? req.get('X-CSRF-Token') : undefined,
      requireCsrf,
    );
    if (result.kind === 'csrf_invalid') {
      res.status(403).json({ error: 'This request could not be verified.' });
      return null;
    }
    if (result.kind !== 'authenticated') {
      res.status(401).json({ error: 'Sign in to view your tickets.' });
      return null;
    }
    return result.subject;
  }

  function allowedWriteOrigin(req: Request, res: Response): boolean {
    if (!ticketClientOriginAllowed(req, origins)) {
      res.status(403).json({ error: 'This request origin is not allowed.' });
      return false;
    }
    return true;
  }

  function target(req: Request): TicketTarget | null {
    const workspaceId = req.params.workspaceId ?? '';
    const ticketId = req.params.ticketId ?? '';
    return opaqueTicketRequestValue(workspaceId) && opaqueTicketRequestValue(ticketId)
      ? { workspaceId, ticketId } : null;
  }

  if (application.projectProposals && application.emailFor) {
    const proposals = application.projectProposals;
    const emailFor = application.emailFor;
    router.get('/project-proposals',route(async(req,res)=>{
      if(!available(res)) return;
      const subject=await authenticate(req,res,false);
      if(subject) res.json(await proposals.list(subject));
    }));
    router.post('/project-proposals',route(async(req,res)=>{
      if(!available(res) || !allowedWriteOrigin(req,res)) return;
      const subject=await authenticate(req,res,true);
      if(subject) res.status(201).json(await proposals.submit(subject,await emailFor(subject),req.body));
    }));
  }
  if (application.projectPortal) {
    const projects = application.projectPortal;
    router.get('/projects', route(async (req, res) => {
      if (!available(res)) return;
      const subject = await authenticate(req, res, false);
      if (subject) return res.json(await projects.projects(subject));
    }));
    router.get('/requests', route(async (req, res) => {
      if (!available(res)) return;
      const subject = await authenticate(req, res, false);
      if (subject) return res.json(await projects.requests(subject, req.query));
    }));
    const projectPath = '/projects/:workspaceId/:projectId';
    router.get(projectPath + '/requests', route(async (req, res) => {
      if (!available(res)) return;
      const subject = await authenticate(req, res, false);
      if (subject) return res.json(await projects.requests(subject, req.query,
        { workspaceId: req.params.workspaceId, projectId: req.params.projectId }));
    }));
    router.get(projectPath + '/preview/messages', route(async (req, res) => {
      if (!available(res)) return;
      const subject = await authenticate(req, res, false);
      if (subject) return res.json(await projects.messages(
        { workspaceId: req.params.workspaceId, projectId: req.params.projectId }, subject, req.query));
    }));
    router.post(projectPath + '/preview/messages', route(async (req, res) => {
      if (!available(res) || !allowedWriteOrigin(req, res)) return;
      const subject = await authenticate(req, res, true);
      if (subject) return res.json(await projects.reply(
        { workspaceId: req.params.workspaceId, projectId: req.params.projectId }, subject, req.body));
    }));
    router.get(projectPath + '/preview/messages/operations/:operationId', route(async (req, res) => {
      if (!available(res)) return;
      const subject = await authenticate(req, res, false);
      if (subject) return res.json(await projects.operation(
        { workspaceId: req.params.workspaceId, projectId: req.params.projectId }, subject, req.params.operationId));
    }));
  }

  if(application.projectUat) {
    const app=application.projectUat, path='/projects/:workspaceId/:projectId/uat';
    router.post(path+'/rounds/:roundId/items/:itemId/evidence',raw({type:['image/png','image/jpeg'],limit:'3mb'}),route(async(req,res)=>{
      if(!available(res)||!allowedWriteOrigin(req,res))return;
      const subject=await authenticate(req,res,true);if(!subject)return;
      const metadata=parseTicketDocumentMetadata(req);
      if(!metadata||!Buffer.isBuffer(req.body))return res.status(400).json({code:'invalid_uat_evidence',error:'Choose a PNG or JPEG screenshot.'});
      return res.json(await app.uploadEvidence({workspaceId:req.params.workspaceId,projectId:req.params.projectId},subject,req.params.roundId,req.params.itemId,
        {operationId:metadata.operationId,filename:metadata.filename,contentType:metadata.contentType},req.body));
    }));
    for(const [method,suffix] of [['get','/rounds'],['get','/rounds/:roundId'],['put','/rounds/:roundId/items/:itemId/result'],
      ['post','/rounds/:roundId/submit'],['get','/operations/:operationId'],['get','/rounds/:roundId/evidence/:evidenceId/content']] as const) {
      router[method](path+suffix,route(async(req,res)=>{
        const writing=method!=='get';
        if(!available(res)||(writing&&!allowedWriteOrigin(req,res)))return;
        const subject=await authenticate(req,res,writing);if(!subject)return;
        const target={workspaceId:req.params.workspaceId,projectId:req.params.projectId};
        if(req.params.evidenceId)return sendUatEvidence(res,await app.downloadEvidence(target,subject,req.params.roundId,req.params.evidenceId));
        if(req.params.operationId)return res.json(await app.operation(target,subject,req.params.operationId));
        if(suffix.endsWith('/result'))return res.json(await app.result(target,subject,req.params.roundId,req.params.itemId,req.body));
        if(suffix.endsWith('/submit'))return res.json(await app.submit(target,subject,req.params.roundId,req.body));
        return res.json(req.params.roundId?await app.get(target,subject,req.params.roundId):await app.list(target,subject,req.query));
      }));
    }
  }

  router.get('/workspaces', route(async (req, res) => {
    if (!available(res)) return;
    const subject = await authenticate(req, res, false);
    if (!subject) return;
    const items = await application.listWorkspaces(subject);
    if (!Array.isArray(items) || items.length > 1000) throw new TicketReadInvariantError();
    const ids = new Set<string>();
    const safeItems = items.map(item => {
      if (!item || !opaqueTicketRequestValue(item.workspaceId) || !text(item.displayName, 200)
        || !item.displayName.trim() || item.displayName.trim() !== item.displayName || ids.has(item.workspaceId)) {
        throw new TicketReadInvariantError();
      }
      ids.add(item.workspaceId);
      return { workspaceId: item.workspaceId, displayName: item.displayName };
    });
    return res.json({ items: safeItems });
  }));

  router.get('/workflow-capabilities', route(async (req, res) => {
    if (!available(res)) return;
    const result = application.workflowCapabilities();
    if (!result || typeof result.phaseWorkflowEnabled !== 'boolean') throw new TicketReadInvariantError();
    return res.json(result);
  }));

  router.get('/workspaces/:workspaceId/intake-context', route(async (req, res) => {
    if (!available(res)) return;
    const subject = await authenticate(req, res, false);
    if (!subject) return;
    const workspaceId = req.params.workspaceId ?? '';
    if (!opaqueTicketRequestValue(workspaceId)) return res.status(404).json({ error: 'Ticket intake is unavailable.' });
    const result = await application.getIntakeContext(workspaceId, subject);
    if (!result || !opaqueTicketRequestValue(result.intakeContextId) || typeof result.canCreate !== 'boolean'
      || !Array.isArray(result.sharedProjects) || result.sharedProjects.length > 1000) throw new TicketReadInvariantError();
    const ids = new Set<string>();
    const sharedProjects = result.sharedProjects.map(option => {
      if (!option || !opaqueTicketRequestValue(option.optionId) || !text(option.displayName, 200)
        || !option.displayName.trim() || option.displayName.trim() !== option.displayName || ids.has(option.optionId)) {
        throw new TicketReadInvariantError();
      }
      ids.add(option.optionId);
      return { optionId: option.optionId, displayName: option.displayName };
    });
    return res.json({ intakeContextId: result.intakeContextId, canCreate: result.canCreate, sharedProjects });
  }));

  router.get('/workspaces/:workspaceId/tickets', route(async (req, res) => {
    if (!available(res)) return;
    const subject = await authenticate(req, res, false);
    if (!subject) return;
    const workspaceId = req.params.workspaceId ?? '';
    if (!opaqueTicketRequestValue(workspaceId)) return res.status(404).json({ error: 'Tickets are unavailable.' });
    const page = await application.list(workspaceId, subject, serviceQueryInput(req.query));
    if (!page || !Array.isArray(page.items) || page.items.length > 100
      || (page.nextCursor !== null && !opaqueTicketRequestValue(page.nextCursor))) throw new TicketReadInvariantError();
    const items = page.items.map(safeClientQueueItem);
    if (page.nextCursor !== null && items.at(-1)?.id !== page.nextCursor) throw new TicketReadInvariantError();
    return res.json({ items, nextCursor: page.nextCursor, counters: safeCounters(page.counters) });
  }));

  // Static operation path is deliberately registered independently of ticket IDs.
  router.get('/tickets/operations/:operationId', route(async (req, res) => {
    if (!available(res)) return;
    const subject = await authenticate(req, res, false);
    if (!subject) return;
    const contextId = typeof req.query.intakeContextId === 'string' ? req.query.intakeContextId : '';
    const operationId = req.params.operationId ?? '';
    const receipt = await application.lookupCreation(contextId, subject, operationId);
    if (!receipt) return res.status(404).json({ error: 'Ticket operation not found.' });
    return res.json(safeReceipt(receipt));
  }));

  router.post('/tickets', route(async (req, res) => {
    if (!available(res) || !allowedWriteOrigin(req, res)) return;
    const subject = await authenticate(req, res, true);
    if (!subject) return;
    const body = record(req.body);
    const contextId = typeof body?.intakeContextId === 'string' ? body.intakeContextId : '';
    const input: unknown = body ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'intakeContextId')) : req.body;
    const receipt = await application.create(contextId, subject, input);
    const safe = safeReceipt(receipt);
    if (!safe) throw new TicketReadInvariantError();
    return res.status(200).json(safe);
  }));

  router.get('/workspaces/:workspaceId/tickets/:ticketId/operations/:operationId', route(async (req, res) => {
    if (!available(res)) return;
    const subject = await authenticate(req, res, false);
    if (!subject) return;
    const ticketTarget = target(req);
    const operationId = req.params.operationId ?? '';
    if (!ticketTarget || !opaqueTicketRequestValue(operationId)) {
      return res.status(404).json({ error: 'Ticket operation not found.' });
    }
    const receipt = safeReceipt(await application.lookup(ticketTarget, subject, operationId), ticketTarget.ticketId);
    if (!receipt) return res.status(404).json({ error: 'Ticket operation not found.' });
    return res.json(receipt);
  }));

  router.get('/workspaces/:workspaceId/tickets/:ticketId/messages', route(async (req, res) => {
    if (!available(res)) return;
    const subject = await authenticate(req, res, false);
    if (!subject) return;
    const ticketTarget = target(req);
    if (!ticketTarget) return res.status(404).json({ error: 'Ticket not found.' });
    return res.json(safeMessages(await application.conversation(ticketTarget, subject, serviceQueryInput(req.query))));
  }));

  if (application.documents) {
    router.get('/workspaces/:workspaceId/tickets/:ticketId/documents', route(async (req, res) => {
      secureTicketDocumentResponse(res);
      if (!available(res)) return;
      const subject = await authenticate(req, res, false);
      if (!subject) return;
      const ticketTarget = target(req);
      if (!ticketTarget) return res.status(404).json({ error: 'Ticket not found.' });
      return res.json({ items: safeTicketDocuments(await application.documents!.list(ticketTarget, subject)) });
    }));

    router.post('/workspaces/:workspaceId/tickets/:ticketId/documents', route(async (req, res) => {
      secureTicketDocumentResponse(res);
      if (!available(res) || !allowedWriteOrigin(req, res)) return;
      const subject = await authenticate(req, res, true);
      if (!subject) return;
      const ticketTarget = target(req);
      const metadata = parseTicketDocumentMetadata(req);
      if (!ticketTarget) return res.status(404).json({ error: 'Ticket not found.' });
      if (!metadata || !Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Choose a supported document.' });
      const saved = await application.documents!.upload(ticketTarget, subject, { ...metadata, bytes: req.body });
      return res.json(safeTicketDocuments([saved])[0]);
    }));

    router.get('/workspaces/:workspaceId/tickets/:ticketId/documents/:documentId/content', route(async (req, res) => {
      secureTicketDocumentResponse(res);
      if (!available(res)) return;
      const subject = await authenticate(req, res, false);
      if (!subject) return;
      const ticketTarget = target(req);
      const documentId = req.params.documentId ?? '';
      if (!ticketTarget || !opaqueTicketRequestValue(documentId)) return res.status(404).json({ error: 'Document not found.' });
      sendTicketDocument(res, await application.documents!.download(ticketTarget, subject, documentId));
    }));
  }

  router.get('/workspaces/:workspaceId/tickets/:ticketId/deliveries/:deliveryId', route(async (req, res) => {
    if (!available(res)) return;
    const subject = await authenticate(req, res, false);
    if (!subject) return;
    const ticketTarget = target(req);
    const deliveryId = req.params.deliveryId ?? '';
    if (!ticketTarget || !opaqueTicketRequestValue(deliveryId)) return res.status(404).json({ error: 'Shared result not found.' });
    const result = projectTicketDeliveryManifest(await application.deliveryManifest(ticketTarget, subject, deliveryId));
    if (result.deliveryId !== deliveryId) throw new TicketReadInvariantError();
    return res.json(result);
  }));

  router.get('/workspaces/:workspaceId/tickets/:ticketId/deliveries/:deliveryId/files/:fileId', route(async (req, res) => {
    if (!available(res)) return;
    const subject = await authenticate(req, res, false);
    if (!subject) return;
    const ticketTarget = target(req);
    const deliveryId = req.params.deliveryId ?? '';
    const fileId = req.params.fileId ?? '';
    if (!ticketTarget || !opaqueTicketRequestValue(deliveryId) || !opaqueTicketRequestValue(fileId)) {
      return res.status(404).json({ error: 'Shared result not found.' });
    }
    const result = await application.deliveryContent(ticketTarget, subject, deliveryId, fileId);
    const safe = projectTicketDeliveryFile(result?.file);
    if (safe.id !== fileId || !(result.bytes instanceof Uint8Array) || result.bytes.byteLength !== safe.byteLength) {
      throw new TicketReadInvariantError();
    }
    // Always attachment; never serve HTML/SVG/agent output on the authenticated
    // app origin. No object URL, redirect, public token, conditional cache or range.
    const encodedName = encodeURIComponent(safe.filename).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="delivery-file"; filename*=UTF-8''${encodedName}`);
    res.setHeader('Content-Length', safe.byteLength);
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    return res.status(200).end(Buffer.from(result.bytes));
  }));

  router.get('/workspaces/:workspaceId/tickets/:ticketId', route(async (req, res) => {
    if (!available(res)) return;
    const subject = await authenticate(req, res, false);
    if (!subject) return;
    const ticketTarget = target(req);
    if (!ticketTarget) return res.status(404).json({ error: 'Ticket not found.' });
    return res.json(safeClientDetail(await application.detail(ticketTarget, subject)));
  }));

  router.post('/workspaces/:workspaceId/tickets/:ticketId/messages', route(async (req, res) => {
    if (!available(res) || !allowedWriteOrigin(req, res)) return;
    const subject = await authenticate(req, res, true);
    if (!subject) return;
    const ticketTarget = target(req);
    if (!ticketTarget) return res.status(404).json({ error: 'Ticket not found.' });
    const receipt = safeReceipt(await application.reply(ticketTarget, subject, req.body), ticketTarget.ticketId);
    if (!receipt || !('messageId' in receipt)) throw new TicketReadInvariantError();
    return res.json(receipt);
  }));

  router.post('/workspaces/:workspaceId/tickets/:ticketId/commands', route(async (req, res) => {
    if (!available(res) || !allowedWriteOrigin(req, res)) return;
    const subject = await authenticate(req, res, true);
    if (!subject) return;
    const ticketTarget = target(req);
    if (!ticketTarget) return res.status(404).json({ error: 'Ticket not found.' });
    const receipt = safeReceipt(await application.execute(ticketTarget, subject, req.body), ticketTarget.ticketId);
    if (!receipt) throw new TicketReadInvariantError();
    return res.json(receipt);
  }));

  return router;
}
