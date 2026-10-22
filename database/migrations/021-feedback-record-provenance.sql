-- Add provenance/idempotency for feedback records. No historical rows are
-- deleted, rewritten, classified or scored by this migration.
begin;

alter table public.observations
  add column if not exists source_message_id uuid references public.messages(id) on delete set null,
  add column if not exists source_text text,
  add column if not exists record_key text;

create unique index if not exists observations_session_record_key_uidx
  on public.observations(session_id, record_key);
create index if not exists observations_source_message_idx
  on public.observations(source_message_id);

commit;
