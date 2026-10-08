-- Read-only effective privileges for provider roles; no client rows.
select 'schema' kind,n.nspname name,r.rolname role,
jsonb_build_object('usage',has_schema_privilege(r.rolname,n.oid,'USAGE'),'create',has_schema_privilege(r.rolname,n.oid,'CREATE')) permissions
from pg_namespace n cross join pg_roles r where n.nspname in ('public','alpha','alpha_private') and r.rolname in ('anon','authenticated','service_role')
union all
select 'table',n.nspname||'.'||c.relname,r.rolname,
jsonb_build_object('select',has_table_privilege(r.rolname,c.oid,'SELECT'),'insert',has_table_privilege(r.rolname,c.oid,'INSERT'),'update',has_table_privilege(r.rolname,c.oid,'UPDATE'),'delete',has_table_privilege(r.rolname,c.oid,'DELETE'),'truncate',has_table_privilege(r.rolname,c.oid,'TRUNCATE'),'references',has_table_privilege(r.rolname,c.oid,'REFERENCES'),'trigger',has_table_privilege(r.rolname,c.oid,'TRIGGER'))
from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r
where n.nspname in ('public','alpha','alpha_private') and c.relkind in ('r','p') and r.rolname in ('anon','authenticated','service_role')
order by 1,2,3;
