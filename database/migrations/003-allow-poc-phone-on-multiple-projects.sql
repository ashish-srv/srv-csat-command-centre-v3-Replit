-- Allow one client contact to participate in several projects.
-- Run once in the Supabase SQL editor before adding the same WhatsApp number
-- to a second project. The app still rejects reuse across different clients.

begin;

do $$
declare
  object_name text;
begin
  -- Remove an older table-level UNIQUE(contact_whatsapp), whatever its name.
  for object_name in
    select conname
    from pg_constraint
    where conrelid = 'public.client_pocs'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ~* 'unique\s*\(\s*contact_whatsapp\s*\)'
  loop
    execute format('alter table public.client_pocs drop constraint %I', object_name);
  end loop;

  -- Also handle a standalone unique index created outside a constraint.
  for object_name in
    select indexname
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'client_pocs'
      and indexdef ~* '^create unique index'
      and indexdef ~* '\(\s*contact_whatsapp\s*\)'
      and indexdef !~* 'project_id'
  loop
    execute format('drop index if exists public.%I', object_name);
  end loop;
end $$;

create unique index if not exists client_pocs_project_whatsapp_unique
  on public.client_pocs (project_id, contact_whatsapp)
  where contact_whatsapp is not null;

commit;
