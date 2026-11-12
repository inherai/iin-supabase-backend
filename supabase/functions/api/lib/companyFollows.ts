// Following a company page. One table holds follows (article_company_follows — the name is
// historical); companies.followers_count is kept in step by a database trigger.
// Runs in the member's own session: she can only add or remove her own follow.

export async function setCompanyFollow(
  supabase: any,
  userId: string,
  companyId: number,
  follow: boolean,
): Promise<{ error: { message: string; code?: string } | null }> {
  if (follow) {
    // "Do nothing" when she already follows: an upsert that updates the existing row is refused
    // by the database (members may add and remove their follow, not update it).
    const { error } = await supabase
      .from('article_company_follows')
      .upsert({ follower_uuid: userId, company_id: companyId }, { onConflict: 'follower_uuid,company_id', ignoreDuplicates: true })
    return { error }
  }
  const { error } = await supabase
    .from('article_company_follows')
    .delete()
    .eq('follower_uuid', userId)
    .eq('company_id', companyId)
  return { error }
}

export async function isFollowingCompany(supabase: any, userId: string, companyId: number): Promise<boolean> {
  const { data } = await supabase
    .from('article_company_follows')
    .select('company_id')
    .eq('company_id', companyId)
    .eq('follower_uuid', userId)
    .maybeSingle()
  return !!data
}
