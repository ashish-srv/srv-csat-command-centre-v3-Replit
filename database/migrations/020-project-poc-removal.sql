begin;

-- Remove an assignment without cascading through its past sessions/chats.
-- Inactive is still a visible, reversible setting; removed is not a live POC.
alter table public.client_pocs add column if not exists removed_at timestamptz;

-- A removed historical record must not block adding this contact again.
drop index if exists public.client_pocs_project_whatsapp_unique;
create unique index client_pocs_project_whatsapp_unique
  on public.client_pocs (project_id, contact_whatsapp)
  where contact_whatsapp is not null and removed_at is null;

commit;
