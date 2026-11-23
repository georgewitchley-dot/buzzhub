-- SQLite-compatible SQL functions, so queries ported from the Node server keep their shape.
-- Timestamps are UTC text 'YYYY-MM-DD HH:MM:SS' everywhere, exactly as SQLite stores them.

-- datetime(ts [, modifier [, modifier]]) -> 'YYYY-MM-DD HH:MM:SS'
-- ts: 'now' or a timestamp text. Modifiers: '+/-N seconds|minutes|hours|days|months|years',
-- 'start of day', 'start of month'. Returns NULL for NULL/bad input, like SQLite.
CREATE OR REPLACE FUNCTION sqlite_ts(ts text) RETURNS timestamp LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF ts IS NULL OR ts = '' THEN RETURN NULL; END IF;
  IF lower(ts) = 'now' THEN RETURN now() AT TIME ZONE 'UTC'; END IF;
  RETURN replace(ts, 'T', ' ')::timestamp;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION sqlite_mod(t timestamp, m text) RETURNS timestamp LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE parts text[]; n double precision; u text;
BEGIN
  IF t IS NULL OR m IS NULL THEN RETURN t; END IF;
  m := lower(trim(m));
  IF m = 'start of day' THEN RETURN date_trunc('day', t); END IF;
  IF m = 'start of month' THEN RETURN date_trunc('month', t); END IF;
  IF m = 'start of year' THEN RETURN date_trunc('year', t); END IF;
  parts := regexp_match(m, '^([+-]?[0-9]*\.?[0-9]+)\s*([a-z]+)$');
  IF parts IS NULL THEN RETURN NULL; END IF;
  n := parts[1]::double precision; u := rtrim(parts[2], 's');
  RETURN CASE u
    WHEN 'second' THEN t + make_interval(secs => n)
    WHEN 'minute' THEN t + make_interval(secs => n * 60)
    WHEN 'hour' THEN t + make_interval(secs => n * 3600)
    WHEN 'day' THEN t + make_interval(secs => n * 86400)
    WHEN 'month' THEN t + make_interval(months => n::int)
    WHEN 'year' THEN t + make_interval(years => n::int)
    ELSE NULL END;
END $$;

CREATE OR REPLACE FUNCTION datetime(ts text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(sqlite_ts(ts), 'YYYY-MM-DD HH24:MI:SS') $$;
CREATE OR REPLACE FUNCTION datetime(ts text, m1 text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(sqlite_mod(sqlite_ts(ts), m1), 'YYYY-MM-DD HH24:MI:SS') $$;
CREATE OR REPLACE FUNCTION datetime(ts text, m1 text, m2 text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(sqlite_mod(sqlite_mod(sqlite_ts(ts), m1), m2), 'YYYY-MM-DD HH24:MI:SS') $$;

-- date(...) is spelled sqlite_date(...) because "date" is a type name in Postgres.
CREATE OR REPLACE FUNCTION sqlite_date(ts text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(sqlite_ts(ts), 'YYYY-MM-DD') $$;
CREATE OR REPLACE FUNCTION sqlite_date(ts text, m1 text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(sqlite_mod(sqlite_ts(ts), m1), 'YYYY-MM-DD') $$;

CREATE OR REPLACE FUNCTION julianday(ts text) RETURNS double precision LANGUAGE sql STABLE AS $$
  SELECT extract(epoch FROM sqlite_ts(ts) AT TIME ZONE 'UTC') / 86400.0 + 2440587.5 $$;

-- strftime with the format codes the app uses (%Y %m %d %H %M %S %w %j %s).
CREATE OR REPLACE FUNCTION strftime(fmt text, ts text) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE t timestamp := sqlite_ts(ts); out text := fmt;
BEGIN
  IF t IS NULL THEN RETURN NULL; END IF;
  out := replace(out, '%Y', to_char(t, 'YYYY')); out := replace(out, '%m', to_char(t, 'MM'));
  out := replace(out, '%d', to_char(t, 'DD')); out := replace(out, '%H', to_char(t, 'HH24'));
  out := replace(out, '%M', to_char(t, 'MI')); out := replace(out, '%S', to_char(t, 'SS'));
  out := replace(out, '%w', extract(dow FROM t)::int::text); out := replace(out, '%j', to_char(t, 'DDD'));
  out := replace(out, '%s', floor(extract(epoch FROM t AT TIME ZONE 'UTC'))::bigint::text);
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION instr(s text, sub text) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT strpos(s, sub)::bigint $$;
CREATE OR REPLACE FUNCTION round(x double precision, d integer) RETURNS double precision LANGUAGE sql IMMUTABLE AS $$ SELECT round(x::numeric, d)::double precision $$;

-- GROUP_CONCAT(x) and GROUP_CONCAT(x, sep)
CREATE OR REPLACE FUNCTION sqlite_gc_step(acc text, v anyelement) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL THEN acc WHEN acc IS NULL THEN v::text ELSE acc || ',' || v::text END $$;
CREATE OR REPLACE FUNCTION sqlite_gc_step2(acc text, v anyelement, sep text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL THEN acc WHEN acc IS NULL THEN v::text ELSE acc || sep || v::text END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'group_concat' AND n.nspname = current_schema() AND p.pronargs = 1) THEN
    CREATE AGGREGATE group_concat(anyelement) (SFUNC = sqlite_gc_step, STYPE = text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'group_concat' AND n.nspname = current_schema() AND p.pronargs = 2) THEN
    CREATE AGGREGATE group_concat(anyelement, text) (SFUNC = sqlite_gc_step2, STYPE = text);
  END IF;
  -- SUM(x IS NULL) and friends: SQLite booleans are 0/1 numbers
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'sum' AND n.nspname = current_schema() AND p.proargtypes::text = (SELECT oid::text FROM pg_type WHERE typname = 'bool')) THEN
    CREATE FUNCTION sqlite_bool_sum(acc bigint, v boolean) RETURNS bigint LANGUAGE sql IMMUTABLE AS 'SELECT COALESCE(acc, 0) + CASE WHEN v THEN 1 ELSE 0 END';
    CREATE AGGREGATE sum(boolean) (SFUNC = sqlite_bool_sum, STYPE = bigint);
  END IF;
END $$;
