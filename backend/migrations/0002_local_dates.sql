-- Business-local dates. The time zone comes from the location's "timezone" setting,
-- which the server puts in buzzhub.tz at the start of every transaction.
CREATE OR REPLACE FUNCTION localdate(ts text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN ts IS NULL OR ts = '' THEN NULL ELSE
    to_char((ts::timestamp AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(NULLIF(current_setting('buzzhub.tz', true), ''), 'America/New_York'), 'YYYY-MM-DD') END
$$;
CREATE OR REPLACE FUNCTION localtoday() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(now() AT TIME ZONE COALESCE(NULLIF(current_setting('buzzhub.tz', true), ''), 'America/New_York'), 'YYYY-MM-DD')
$$;
