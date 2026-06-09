-- messages.sender_id is NOT NULL + FK NO ACTION, which blocks auth.admin.deleteUser().
-- Drop NOT NULL so sender_id can be nullified when a user is deleted (chat history stays,
-- sender becomes anonymous). Change FK to SET NULL so the DB handles it automatically.
ALTER TABLE public.messages ALTER COLUMN sender_id DROP NOT NULL;

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_sender_id_fkey;

ALTER TABLE public.messages
    ADD CONSTRAINT messages_sender_id_fkey
    FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE SET NULL;
