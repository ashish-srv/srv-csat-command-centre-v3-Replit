-- Adds an optional birthday to client contacts. Safe to run more than once.
alter table public.client_pocs
  add column if not exists birth_date date;
