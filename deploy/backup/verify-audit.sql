-- Recomputes every institution's audit hash chain. Run as a superuser, so row-level security does not hide any institution.
SELECT institution_id, count(*) AS events, bool_and(linked AND intact) AS ok
FROM (
  SELECT institution_id,
    (prev_hash = COALESCE(lag(hash) OVER w, repeat('0', 64))) AS linked,
    (hash = encode(digest(prev_hash || institution_id::text || seq::text || actor_type || COALESCE(actor_id, '') || action || COALESCE(object_type, '') || COALESCE(object_id, '') || payload::text, 'sha256'), 'hex')) AS intact
  FROM audit_events WINDOW w AS (PARTITION BY institution_id ORDER BY seq)
) c GROUP BY institution_id ORDER BY institution_id;
