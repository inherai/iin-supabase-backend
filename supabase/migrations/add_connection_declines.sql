-- ============================================================
-- connection_declines — memory of declined connection requests
-- ============================================================
-- Declining a request deletes the connections row (unchanged), which used to
-- leave no trace: the requester saw "Connect" again and could re-send forever.
-- This table remembers the decline so the API can:
--   * keep showing the requester her request as pending (she is never told)
--   * silently swallow re-sends: 6 months after a first decline, forever after a second
-- Read and written only by the API with the service role — the requester must
-- never be able to query it, so RLS is on with no policies.

CREATE TABLE IF NOT EXISTS public.connection_declines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id          uuid NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  receiver_id           uuid NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  decline_count         integer NOT NULL DEFAULT 1,
  declined_at           timestamptz NOT NULL DEFAULT now(),
  -- What the requester keeps seeing in her "sent requests" list
  requested_at          timestamptz NOT NULL DEFAULT now(),
  message               text,
  -- The requester withdrew the request she believes is still pending
  hidden_from_requester boolean NOT NULL DEFAULT false,
  UNIQUE (requester_id, receiver_id)
);

CREATE INDEX IF NOT EXISTS connection_declines_receiver_idx
  ON public.connection_declines (receiver_id);

ALTER TABLE public.connection_declines ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.connection_declines FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.connection_declines TO service_role;
