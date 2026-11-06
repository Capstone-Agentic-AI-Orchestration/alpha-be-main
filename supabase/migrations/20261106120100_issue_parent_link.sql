-- Keep Alpha's suggested work packages attached to their parent task.
alter table public.issues
  add column parent_issue_id text references public.issues(id) on delete set null,
  add constraint issues_parent_not_self
    check (parent_issue_id is null or parent_issue_id <> id);

comment on column public.issues.parent_issue_id is 'Parent task for a planned work package.';
