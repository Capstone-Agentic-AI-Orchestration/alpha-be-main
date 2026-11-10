alter table chat_messages
  add column if not exists skill_ids jsonb not null default '[]'::jsonb;
