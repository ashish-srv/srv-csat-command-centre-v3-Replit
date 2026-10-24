-- Explicit assignments: an Admin without clusters has no project access.
-- Existing Super Admins remain unrestricted. No existing data is removed.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS cluster_access jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS external_login_allowed boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_users_cluster_access_array' AND conrelid = 'app_users'::regclass) THEN
    ALTER TABLE app_users ADD CONSTRAINT app_users_cluster_access_array CHECK (jsonb_typeof(cluster_access) = 'array');
  END IF;
END $$;
