import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { TransactionalSql } from '../store/database.js';
import { createProjectUatBuilds } from './projectUatBuilds.js';

const fake=vi.hoisted(()=>({project:{resources:[] as any[]},vercel:{findProjectByName:vi.fn(),latestDeployment:vi.fn()},render:{findServiceByName:vi.fn(),latestDeploy:vi.fn()}}));
vi.mock('../store/postgresProjectStore.js',()=>({PostgresProjectStore:class{async get(){return fake.project;}}}));
vi.mock('./hosting/hostingService.js',async original=>({...await original<object>(),vercelClient:()=>fake.vercel,renderClient:()=>fake.render}));
vi.mock('./hosting/embeddability.js',()=>({UrlEmbeddabilityProbe:class{async check(){return {embeddable:true,reason:null};}}}));
const target={workspaceId:'workspace-a',projectId:'project-a'};
const deploy=()=>({uid:'deployment-a',url:'deployment-a.vercel.app',state:'READY',meta:{githubCommitRef:'uat',githubCommitSha:'a'.repeat(40)}});
beforeEach(()=>{
  vi.clearAllMocks();fake.project.resources=[{type:'github_repo',pathOrUrl:'https://github.com/org/frontend',stack:'react'}];
  fake.vercel.findProjectByName.mockResolvedValue({id:'host',link:{type:'github',org:'org',repo:'frontend'}});
  fake.vercel.latestDeployment.mockResolvedValue(deploy());
  fake.render.findServiceByName.mockResolvedValue({id:'api',branch:'uat',repo:'https://github.com/org/backend',serviceDetails:{url:'https://api-uat.onrender.com'}});
  fake.render.latestDeploy.mockResolvedValue({id:'api-deploy',status:'live',commit:{id:'b'.repeat(40)}});
});
const app=()=>createProjectUatBuilds({} as TransactionalSql);
describe('provider-verified project UAT provenance',()=>{
  it('offers only project frontend targets and records immutable frontend plus API deployments',async()=>{
    fake.project.resources.push({type:'github_repo',pathOrUrl:'https://github.com/org/backend',stack:'nodejs'});
    expect(await app().targets(target)).toEqual([{repository:'org/frontend'}]);
    const build=await app().resolve(target,'org/frontend');
    expect(build.frontend).toMatchObject({branch:'uat',commitSha:'a'.repeat(40),deploymentId:'deployment-a',url:'https://deployment-a.vercel.app'});
    expect(build.backends[0]).toMatchObject({repository:'org/backend',branch:'uat',commitSha:'b'.repeat(40)});
    expect(fake.vercel.latestDeployment).toHaveBeenCalledWith('host',{branch:'uat'});
    await expect(app().resolve(target,'foreign/repo')).rejects.toMatchObject({status:404});
  });
  it('rejects production, building, missing SHA and mismatched provider repository links',async()=>{
    fake.vercel.latestDeployment.mockResolvedValue({...deploy(),meta:{...deploy().meta,githubCommitRef:'main'}});
    await expect(app().resolve(target,'org/frontend')).rejects.toMatchObject({code:'uat_deployment_not_ready'});
    fake.vercel.latestDeployment.mockResolvedValue({...deploy(),state:'BUILDING'});
    await expect(app().resolve(target,'org/frontend')).rejects.toMatchObject({code:'uat_deployment_not_ready'});
    fake.vercel.latestDeployment.mockResolvedValue({...deploy(),meta:{githubCommitRef:'uat'}});
    await expect(app().resolve(target,'org/frontend')).rejects.toMatchObject({code:'uat_provenance_missing'});
    fake.vercel.findProjectByName.mockResolvedValue({id:'other',link:{type:'github',org:'other',repo:'frontend'}});
    await expect(app().resolve(target,'org/frontend')).rejects.toMatchObject({code:'uat_repository_mismatch'});
  });
  it('rejects unsafe provider URLs and incorrect API branches',async()=>{
    fake.vercel.latestDeployment.mockResolvedValue({...deploy(),url:'127.0.0.1'});
    await expect(app().resolve(target,'org/frontend')).rejects.toMatchObject({code:'uat_preview_unavailable'});
    fake.vercel.latestDeployment.mockResolvedValue(deploy());
    fake.project.resources.push({type:'github_repo',pathOrUrl:'org/backend',stack:'nodejs'});
    fake.render.findServiceByName.mockResolvedValue({id:'api',branch:'main',repo:'org/backend'});
    await expect(app().resolve(target,'org/frontend')).rejects.toMatchObject({code:'uat_backend_unverified'});
  });
  it('does not expose provider failures or credentials in public errors',async()=>{
    fake.vercel.latestDeployment.mockRejectedValue(new Error('provider token=private-value'));
    await expect(app().resolve(target,'org/frontend')).rejects.toMatchObject({code:'uat_provider_unavailable',status:503});
    await expect(app().resolve(target,'org/frontend')).rejects.not.toHaveProperty('message',expect.stringContaining('private-value'));
  });
});
