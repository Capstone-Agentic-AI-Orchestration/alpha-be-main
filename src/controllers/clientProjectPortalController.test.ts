import { describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';
import type { PostgresClientProjectPortal } from '../services/clientProjectPortal.js';
import { createTicketClientApiRouter, type TicketClientApiApplication } from './ticketClientApiController.js';
import { createPmClientProjectRouter } from './clientProjectPortalController.js';

vi.mock('../config/env.js', async original => ({ ...await original<object>(), IS_CLOUD: true }));
const subject = { kind:'client',userId:'client-a',sessionId:'a'.repeat(64) };
const receipt = {messageId:'message',operationId:'operation'};
function fixture() {
  const projectPortal = {projects:vi.fn(async(..._args:unknown[])=>({items:[]})),requests:vi.fn(async(..._args:unknown[])=>({items:[],nextCursor:null,counters:{kind:'client',open:0,needsClient:0}})),
    messages:vi.fn(async(..._args:unknown[])=>({items:[],nextCursor:null})),reply:vi.fn(async(..._args:unknown[])=>receipt),operation:vi.fn(async(..._args:unknown[])=>receipt),setPreview:vi.fn(async(..._args:unknown[])=>({preview:null})),
    clients:vi.fn(async(..._args:unknown[])=>({items:[{clientId:'client-a',displayName:'Client A'}]}))};
  const authenticate = vi.fn(async (session:unknown,csrf:unknown,header:unknown,write:boolean) =>
    session!=='session' ? {kind:'expired'} : write && (csrf!=='csrf'||header!=='csrf') ? {kind:'csrf_invalid'} : {kind:'authenticated',subject});
  const client = createTicketClientApiRouter({projectPortal,authenticate} as unknown as TicketClientApiApplication,
    {secure:true,allowedOrigins:['https://alpha.example']});
  const relay = vi.fn(async(_req:any,_res:any)=>false);
  const pm = createPmClientProjectRouter(projectPortal as unknown as PostgresClientProjectPortal,relay);
  return {projectPortal,authenticate,client,pm,relay};
}
function invoke(router:Router,method:string,path:string,overrides:Record<string,any>={}) {
  const layer=(router as any).stack.find((l:any)=>l.route?.path===path&&l.route.methods[method.toLowerCase()]);
  if(!layer)throw new Error(`Missing ${method} ${path}`);
  const headers={cookie:'__Secure-alpha_client_session=session; alpha_client_csrf=csrf',origin:'https://alpha.example','x-csrf-token':'csrf',...overrides.headers};
  const req={method,params:{workspaceId:'workspace-a',projectId:'project-a',...(path.includes(':operationId')?{operationId:'operation'}:{})},query:{},body:{schemaVersion:1,operationId:'operation',body:'Hello'},
    ...overrides,headers,get:(name:string)=>headers[name.toLowerCase()]};
  return new Promise<{status:number;body:any;headers:Record<string,string>}>((resolve,reject)=>{
    let status=200;const responseHeaders:Record<string,string>={};
    const res={setHeader:(n:string,v:string)=>{responseHeaders[n.toLowerCase()]=v;},status:(s:number)=>{status=s;return res;},
      json:(body:any)=>{resolve({status,body,headers:responseHeaders});return res;}};
    layer.route.stack[0].handle(req,res,reject);
  });
}
const base='/projects/:workspaceId/:projectId';
describe('client project HTTP authentication and CSRF boundaries',()=>{
  it('authenticates every collection, project request, thread and operation read',async()=>{
    const f=fixture();
    for(const path of ['/projects','/requests',base+'/requests',base+'/preview/messages',base+'/preview/messages/operations/:operationId']){
      expect(await invoke(f.client,'GET',path,{headers:{cookie:''}})).toMatchObject({status:401});
      const result=await invoke(f.client,'GET',path);
      expect(result.status).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store, private');
    }
    expect(f.projectPortal.operation).toHaveBeenCalledWith({workspaceId:'workspace-a',projectId:'project-a'},subject,'operation');
  });
  it('requires allowed origin plus CSRF before feedback writes',async()=>{
    const f=fixture();const path=base+'/preview/messages';
    expect(await invoke(f.client,'POST',path,{headers:{origin:'https://evil.example'}})).toMatchObject({status:403});
    expect(await invoke(f.client,'POST',path,{headers:{'x-csrf-token':''}})).toMatchObject({status:403});
    expect(await invoke(f.client,'POST',path,{headers:{cookie:''}})).toMatchObject({status:401});
    expect(f.projectPortal.reply).not.toHaveBeenCalled();
    expect(await invoke(f.client,'POST',path)).toMatchObject({status:200,body:receipt});
    expect(f.authenticate).toHaveBeenLastCalledWith('session','csrf','csrf',true);
  });
  it('passes query filters to the validated service and does not trust a body client identity',async()=>{
    const f=fixture();
    await invoke(f.client,'GET','/requests',{query:{search:'needle',limit:'5',filter:'open'}});
    expect(f.projectPortal.requests).toHaveBeenCalledWith(subject,{search:'needle',limit:'5',filter:'open'});
    await invoke(f.client,'POST',base+'/preview/messages',{body:{schemaVersion:1,operationId:'operation',body:'Hello',clientId:'other'}});
    expect(f.projectPortal.reply.mock.calls[0][1]).toEqual(subject);
    // Strict body validation is tested against real Postgres in the service suite.
  });
});
describe('PM project feedback boundary',()=>{
  const path='/projects/:projectId/client-preview';
  const workspace={workspaceId:'selected-workspace',userId:'pm',role:'pm'};
  const session={ticketAuthentication:{kind:'verified_github_bearer',verificationId:'verified'}};
  it('requires a PM context and binds management to the selected workspace',async()=>{
    const f=fixture();
    expect(await invoke(f.pm,'PUT',path)).toMatchObject({status:401});
    expect(await invoke(f.pm,'PUT',path,{workspace:{...workspace,role:'dev'},session})).toMatchObject({status:403});
    expect(f.projectPortal.setPreview).not.toHaveBeenCalled();
    await invoke(f.pm,'PUT',path,{workspace,session,body:{preview:null},query:{workspaceId:'untrusted'}});
    expect(f.projectPortal.setPreview).toHaveBeenCalledWith({workspaceId:'selected-workspace',projectId:'project-a'},
      {kind:'internal',userId:'pm',authentication:session.ticketAuthentication},{preview:null});
  });
  it('forwards the explicit client thread selector for reads, replies and reconciliation',async()=>{
    const f=fixture();
    await invoke(f.pm,'GET',path+'/messages',{workspace,session,query:{clientId:'client-a',limit:'2'}});
    expect(f.projectPortal.messages).toHaveBeenCalledWith({workspaceId:'selected-workspace',projectId:'project-a'},expect.anything(),{limit:'2'},'client-a');
    await invoke(f.pm,'POST',path+'/messages',{workspace,session,query:{clientId:'client-a'}});
    expect(f.projectPortal.reply).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.anything(),'client-a');
    expect(await invoke(f.pm,'GET',path+'/messages/operations/:operationId',{workspace,session,query:{clientId:'client-a'}}))
      .toMatchObject({status:200,body:receipt});
    expect(f.projectPortal.operation).toHaveBeenCalledWith(expect.anything(),expect.anything(),'operation','client-a');
  });
  it('exposes the authorized client selector under the selected workspace',async()=>{
    const f=fixture();
    expect(await invoke(f.pm,'GET',path+'/clients')).toMatchObject({status:401});
    expect(await invoke(f.pm,'GET',path+'/clients',{workspace,session})).toMatchObject({status:200,body:{items:[{clientId:'client-a',displayName:'Client A'}]}});
    expect(f.projectPortal.clients).toHaveBeenCalledWith({workspaceId:'selected-workspace',projectId:'project-a'},expect.objectContaining({kind:'internal',userId:'pm'}));
  });
  it('relays desktop calls before local persistence',async()=>{
    const f=fixture();
    f.relay.mockImplementation(async (_req:any,res:any)=>{res.status(503).json({error:'Cloud unavailable'});return true;});
    expect(await invoke(f.pm,'POST',path+'/messages',{workspace,session})).toMatchObject({status:503});
    expect(f.projectPortal.reply).not.toHaveBeenCalled();
  });
});
