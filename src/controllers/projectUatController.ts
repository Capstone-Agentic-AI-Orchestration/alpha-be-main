import { Router } from 'express';
import type { ProjectUat } from '../services/projectUat.js';
import { route } from './asyncRoute.js';
import { pmTicketSubject, relayPmTicketRequest } from './ticketRequestAuth.js';
import type { Response } from 'express';

export function sendUatEvidence(res:Response,result:{filename:string;contentType:string;bytes:Uint8Array}) {
  const filename=encodeURIComponent(result.filename).replace(/[!'()*]/g,value=>`%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="screenshot"; filename*=UTF-8''${filename}`);
  res.setHeader('Content-Length',result.bytes.length);res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Referrer-Policy','no-referrer');res.status(200).end(Buffer.from(result.bytes));
}

/** Project-specific PM transport. Desktop writes use the existing authenticated cloud relay. */
export function createPmProjectUatRouter(app:ProjectUat,relay=relayPmTicketRequest) {
  const router=Router(); const path='/projects/:projectId/uat';
  for(const [method,suffix] of [['get','/targets'],['get','/preview'],['get','/rounds'],['post','/rounds'],
    ['get','/rounds/:roundId'],['put','/rounds/:roundId'],['post','/rounds/:roundId/commands'],['get','/operations/:operationId'],
    ['post','/rounds/:roundId/items/:itemId/triage'],['get','/rounds/:roundId/evidence/:evidenceId/content']] as const) {
    router[method](path+suffix,route(async(req,res)=>{
      res.setHeader('Cache-Control','no-store, private'); res.setHeader('X-Content-Type-Options','nosniff');
      if(await relay(req,res,suffix.endsWith('/content')?{responseType:'bytes'}:{}))return;
      const subject=pmTicketSubject(req,res);if(!subject)return;
      const target={workspaceId:req.workspace!.workspaceId,projectId:req.params.projectId};
      if(req.params.evidenceId)return sendUatEvidence(res,await app.downloadEvidence(target,subject,req.params.roundId,req.params.evidenceId));
      if(suffix.endsWith('/triage'))return res.json(await app.triage(target,subject,req.params.roundId,req.params.itemId,req.body));
      if(suffix==='/targets')return res.json(await app.targets(target,subject));
      if(suffix==='/preview')return res.json(await app.preview(target,subject,req.query.repository));
      if(req.params.operationId)return res.json(await app.operation(target,subject,req.params.operationId));
      if(suffix.endsWith('/commands'))return res.json(await app.command(target,subject,req.params.roundId,req.body));
      if(req.params.roundId)return res.json(method==='put'?await app.edit(target,subject,req.params.roundId,req.body):await app.get(target,subject,req.params.roundId));
      return res.json(method==='get'?await app.list(target,subject,req.query):await app.create(target,subject,req.body));
    }));
  }
  return router;
}
