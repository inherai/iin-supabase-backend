-- ============================================================
-- Held invitations: addresses with a misspelled domain (gamil.com, gmail.co, outlock.com, ...).
-- Found 2026-11-22: some of these domains accept any mail, so the invitation (with its link) reached a
-- stranger; the rest bounced. For each such invitation, queued or already emailed:
--   * the corrected address is free  → the invitation moves to it with a NEW token (the old link stops
--     working) and goes back to the queue, so the email timer sends it to the right address;
--   * the corrected address is already a member / already invited / on the do-not-email list
--     → queued: not sent (send_skipped = 'typo_duplicate'); emailed: the invitation is closed (expired).
-- Rows are copied to held_invite_typo_fix_backup first. Undo: rollback_fix_held_invites_typos.sql
-- The import now corrects these on the way in (frontend src/utils/extractEmails.ts).
-- ============================================================
BEGIN;

CREATE TEMP TABLE typo_fix ON COMMIT DROP AS
WITH m(bad, good) AS (VALUES
  ('gamil.com','gmail.com'), ('gnail.com','gmail.com'), ('gmil.com','gmail.com'), ('gmaol.com','gmail.com'),
  ('gmai.com','gmail.com'), ('2gmail.com','gmail.com'), ('gmal.com','gmail.com'), ('gmaul.com','gmail.com'),
  ('gimail.com','gmail.com'), ('gamail.com','gmail.com'), ('gmsil.com','gmail.com'), ('gmaail.com','gmail.com'),
  ('gma0il.com','gmail.com'), ('gmaile.com','gmail.com'), ('gmial.com','gmail.com'), ('gmali.com','gmail.com'),
  ('gmaill.com','gmail.com'), ('gmaik.com','gmail.com'), ('gmail.co','gmail.com'), ('gmail.cm','gmail.com'),
  ('gmail.om','gmail.com'), ('gmail.con','gmail.com'), ('gmail.co.il','gmail.com'),
  ('outlock.com','outlook.com'), ('outlok.com','outlook.com'), ('hotmial.com','hotmail.com'),
  ('8547900org.il','8547900.org.il')
), t AS (
  SELECT i.id, split_part(lower(trim(i.recipient_email)), '@', 1) || '@' || m.good AS fixed,
         i.email_sent_at IS NOT NULL AS emailed, i.created_at
  FROM invites i JOIN m ON m.bad = split_part(lower(trim(i.recipient_email)), '@', 2)
  WHERE i.hold_for_review AND i.status = 'pending'
)
SELECT t.id, t.fixed, t.emailed,
       (EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = t.fixed)
        OR EXISTS (SELECT 1 FROM invites v WHERE lower(trim(v.recipient_email)) = t.fixed AND v.status IN ('pending', 'accepted'))
        OR EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email = t.fixed)
        -- two misspellings of the same address: only the first one moves
        OR row_number() OVER (PARTITION BY t.fixed ORDER BY t.created_at, t.id) > 1) AS taken
FROM t;

CREATE TABLE IF NOT EXISTS public.held_invite_typo_fix_backup AS
  SELECT i.*, now() AS backed_up_at FROM invites i WHERE false;
ALTER TABLE public.held_invite_typo_fix_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.held_invite_typo_fix_backup FROM anon, authenticated;
INSERT INTO public.held_invite_typo_fix_backup
  SELECT i.*, now() FROM invites i JOIN typo_fix f ON f.id = i.id;

-- Corrected address is free: move the invitation there, new token, back to the queue
UPDATE invites i SET
  recipient_email  = f.fixed,
  token            = replace(gen_random_uuid()::text, '-', ''),
  email_sent_at    = NULL,
  reminder_sent_at = NULL,
  views_count      = 0,
  last_viewed_at   = NULL,
  expires_at       = greatest(i.expires_at, now() + interval '21 days')
FROM typo_fix f WHERE f.id = i.id AND NOT f.taken;

-- Corrected address is taken: don't send / close the invitation that went to the wrong address
UPDATE invites i SET send_skipped = 'typo_duplicate'
FROM typo_fix f WHERE f.id = i.id AND f.taken AND NOT f.emailed;

UPDATE invites i SET status = 'expired', expires_at = now()
FROM typo_fix f WHERE f.id = i.id AND f.taken AND f.emailed;

-- Check: nothing pending is left at a misspelled domain
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM invites i JOIN typo_fix f ON f.id = i.id
  WHERE i.status = 'pending' AND i.send_skipped IS NULL AND lower(i.recipient_email) <> f.fixed;
  IF n > 0 THEN RAISE EXCEPTION '% invitations still at a misspelled domain', n; END IF;
  RAISE NOTICE 'moved: %, skipped (queued): %, closed (emailed): %',
    (SELECT count(*) FROM typo_fix WHERE NOT taken),
    (SELECT count(*) FROM typo_fix WHERE taken AND NOT emailed),
    (SELECT count(*) FROM typo_fix WHERE taken AND emailed);
END $$;

COMMIT;
