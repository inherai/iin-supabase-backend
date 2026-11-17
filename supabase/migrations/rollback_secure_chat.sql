-- Undo secure_chat_safe.sql, back to the state captured in snapshot_before_secure_chat.json
-- (2026-11-17). Deploy the previous API first if the new one is live. No row is touched.
BEGIN;
DROP POLICY IF EXISTS "A member sends in her own name to someone she may message" ON public.messages;

-- conversations
REVOKE ALL ON public.conversations FROM anon, authenticated;
GRANT ALL ON public.conversations TO anon, authenticated, service_role;
DROP POLICY IF EXISTS "Users can delete their own conversations" ON public.conversations;
CREATE POLICY "Users can delete their own conversations" ON public.conversations AS PERMISSIVE FOR DELETE TO public USING (((auth.uid() = user1_id) OR (auth.uid() = user2_id)));
DROP POLICY IF EXISTS "Users can insert conversations" ON public.conversations;
CREATE POLICY "Users can insert conversations" ON public.conversations AS PERMISSIVE FOR INSERT TO public WITH CHECK (((auth.uid() = user1_id) OR (auth.uid() = user2_id)));
DROP POLICY IF EXISTS "Users can view their own conversations" ON public.conversations;
CREATE POLICY "Users can view their own conversations" ON public.conversations AS PERMISSIVE FOR SELECT TO public USING (((auth.uid() = user1_id) OR (auth.uid() = user2_id)));

-- messages
REVOKE ALL ON public.messages FROM anon, authenticated;
GRANT ALL ON public.messages TO anon, authenticated, service_role;
DROP POLICY IF EXISTS "Users can mark messages as read" ON public.messages;
CREATE POLICY "Users can mark messages as read" ON public.messages AS PERMISSIVE FOR UPDATE TO authenticated USING (((sender_id <> auth.uid()) AND (EXISTS ( SELECT 1
   FROM conversations c
  WHERE ((c.id = messages.conversation_id) AND ((c.user1_id = auth.uid()) OR (c.user2_id = auth.uid()))))))) WITH CHECK (((sender_id <> auth.uid()) AND (EXISTS ( SELECT 1
   FROM conversations c
  WHERE ((c.id = messages.conversation_id) AND ((c.user1_id = auth.uid()) OR (c.user2_id = auth.uid())))))));
DROP POLICY IF EXISTS "Users can read messages from their conversations" ON public.messages;
CREATE POLICY "Users can read messages from their conversations" ON public.messages AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM conversations c
  WHERE ((c.id = messages.conversation_id) AND ((c.user1_id = auth.uid()) OR (c.user2_id = auth.uid()))))));
DROP POLICY IF EXISTS "enforce_active_connection_on_insert" ON public.messages;
CREATE POLICY "enforce_active_connection_on_insert" ON public.messages AS PERMISSIVE FOR INSERT TO public WITH CHECK ((EXISTS ( SELECT 1
   FROM (conversations c
     JOIN connections conn ON ((((conn.requester_id = c.user1_id) AND (conn.receiver_id = c.user2_id)) OR ((conn.requester_id = c.user2_id) AND (conn.receiver_id = c.user1_id)))))
  WHERE ((c.id = messages.conversation_id) AND (conn.status = 'accepted'::text)))));

DROP FUNCTION IF EXISTS public.messageable_partners(uuid[]);
DROP FUNCTION IF EXISTS public.can_message(uuid, uuid);
COMMIT;
