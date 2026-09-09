-- Apply once in the Supabase SQL editor before deploying the matching code.
-- PostgreSQL permits multiple NULL values in a unique index, so system/web
-- messages without a Meta wamid remain unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_message_id_unique
  ON public.messages (provider_message_id);

ALTER TABLE public.automation_events
  ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS automation_events_dedupe_key_unique
  ON public.automation_events (dedupe_key);

-- A session may produce at most one issue for a given service. The API also
-- checks first, but this index closes the race between concurrent retries.
CREATE UNIQUE INDEX IF NOT EXISTS issues_session_service_unique
  ON public.issues (session_id, service_key);
