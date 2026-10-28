create table alpha_private.client_uat_evidence (
  workspace_id text not null, project_id text not null, client_user_id text not null, round_id text not null, item_id text not null,
  id text not null, operation_id text not null, fingerprint text not null,
  filename text not null check(length(filename) between 1 and 200),
  content_type text not null check(content_type in ('image/png','image/jpeg')),
  byte_length integer not null check(byte_length between 1 and 3145728), sha256 text not null,
  storage_path text not null, status text not null default 'pending' check(status in ('pending','available')),
  created_at timestamptz not null default now(),
  primary key(workspace_id,project_id,client_user_id,round_id,id),
  unique(workspace_id,project_id,client_user_id,operation_id),
  foreign key(workspace_id,project_id,client_user_id,round_id,item_id) references alpha_private.client_uat_items(workspace_id,project_id,client_user_id,round_id,id) on delete cascade
);
alter table alpha_private.client_uat_evidence enable row level security;
revoke all on alpha_private.client_uat_evidence from public,anon,authenticated;
grant select,insert,update on alpha_private.client_uat_evidence to service_role;
-- Objects reuse the existing private alpha-ticket-documents bucket, in an isolated uat hash namespace.
-- No additional browser Storage policy or public bucket is created.
