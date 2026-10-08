-- Read-only application catalog comparison; no row data or managed schema definitions.
with objects as (
select 'table' kind,n.nspname||'.'||c.relname name,jsonb_build_object('rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity) definition
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname in ('public','alpha','alpha_private') and c.relkind in ('r','p')
union all
select 'column',n.nspname||'.'||c.relname||'.'||a.attname,jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated)
from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
where n.nspname in ('public','alpha','alpha_private') and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped
union all
select 'constraint',n.nspname||'.'||c.relname||'.'||con.conname,to_jsonb(pg_get_constraintdef(con.oid))
from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','alpha','alpha_private') and con.contype <> 'n'
union all
select 'index',schemaname||'.'||tablename||'.'||indexname,to_jsonb(indexdef) from pg_indexes where schemaname in ('public','alpha','alpha_private')
union all
select 'policy',schemaname||'.'||tablename||'.'||policyname,jsonb_build_object('permissive',permissive,'roles',roles,'command',cmd,'using',qual,'check',with_check)
from pg_policies where schemaname in ('public','alpha','alpha_private') or (schemaname='realtime' and policyname in ('listen to runs you can see','publish to your own runs','listen to your workspace board'))
union all
select 'function',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl)
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('alpha','alpha_private') and p.prokind='f'
union all
select 'trigger',n.nspname||'.'||c.relname||'.'||t.tgname,to_jsonb(pg_get_triggerdef(t.oid))
from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','alpha','alpha_private') and not t.tgisinternal
)
select kind,name,md5(definition::text) as fingerprint from objects order by kind,name;
