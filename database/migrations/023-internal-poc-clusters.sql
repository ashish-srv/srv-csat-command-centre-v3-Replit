-- Additive: retain the primary cluster for older imports and integrations.
ALTER TABLE internal_pocs ADD COLUMN IF NOT EXISTS cluster_ids uuid[] NOT NULL DEFAULT '{}';
UPDATE internal_pocs SET cluster_ids = ARRAY[cluster_id]
WHERE cluster_id IS NOT NULL AND cardinality(cluster_ids) = 0;

CREATE OR REPLACE FUNCTION sync_internal_poc_clusters() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF cardinality(NEW.cluster_ids) = 0 AND NEW.cluster_id IS NOT NULL THEN
      NEW.cluster_ids := ARRAY[NEW.cluster_id];
    END IF;
  ELSIF NEW.cluster_ids IS NOT DISTINCT FROM OLD.cluster_ids AND NEW.cluster_id IS DISTINCT FROM OLD.cluster_id THEN
    -- Legacy single-cluster edits replace only the primary membership.
    NEW.cluster_ids := array_remove(NEW.cluster_ids, OLD.cluster_id);
    IF NEW.cluster_id IS NOT NULL THEN NEW.cluster_ids := ARRAY[NEW.cluster_id] || NEW.cluster_ids; END IF;
  END IF;
  SELECT COALESCE(array_agg(id ORDER BY first_seen), '{}'::uuid[]) INTO NEW.cluster_ids
  FROM (SELECT id, min(ord) AS first_seen FROM unnest(NEW.cluster_ids) WITH ORDINALITY AS x(id, ord) WHERE id IS NOT NULL GROUP BY id) AS ids;
  IF EXISTS (SELECT 1 FROM unnest(NEW.cluster_ids) AS membership(id) LEFT JOIN clusters c ON c.id = membership.id WHERE c.id IS NULL) THEN
    RAISE EXCEPTION 'Select valid clusters for this Internal POC';
  END IF;
  NEW.cluster_id := NEW.cluster_ids[1];
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS internal_poc_clusters_sync ON internal_pocs;
CREATE TRIGGER internal_poc_clusters_sync BEFORE INSERT OR UPDATE OF cluster_id, cluster_ids ON internal_pocs
FOR EACH ROW EXECUTE FUNCTION sync_internal_poc_clusters();

CREATE OR REPLACE FUNCTION remove_internal_poc_cluster_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE internal_pocs SET cluster_ids = array_remove(cluster_ids, OLD.id)
  WHERE OLD.id = ANY(cluster_ids);
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS cluster_internal_membership_cleanup ON clusters;
CREATE TRIGGER cluster_internal_membership_cleanup BEFORE DELETE ON clusters
FOR EACH ROW EXECUTE FUNCTION remove_internal_poc_cluster_membership();
