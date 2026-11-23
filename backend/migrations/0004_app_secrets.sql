-- Server-wide secrets (JWT key when JWT_SECRET is unset, VAPID keys for phone alerts).
CREATE TABLE IF NOT EXISTS public.app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
