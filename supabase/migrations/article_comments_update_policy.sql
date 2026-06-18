CREATE POLICY "article_comments_update_own" ON article_comments
  FOR UPDATE USING (author_uuid = auth.uid())
  WITH CHECK (author_uuid = auth.uid());
