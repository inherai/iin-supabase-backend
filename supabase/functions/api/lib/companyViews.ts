// A member's look at a page or at one of its jobs, for the page's numbers.
// Runs in her own session; the database keeps one row per member per day, refuses rows in
// anyone else's name and doesn't count the page's own managers. Nobody reads the rows back:
// managers see totals only (company_page_stats).

export async function recordCompanyView(
  supabase: any,
  userId: string,
  companyId: number,
  jobId: number | null = null,
): Promise<void> {
  const { error } = await supabase
    .from('company_views')
    .insert({ company_id: companyId, job_id: jobId, viewer_id: userId })
  // a second look on the same day (23505) or a manager's own look (42501) is not counted — both fine
  if (error && error.code !== '23505' && error.code !== '42501') {
    console.warn('[companyViews] could not record a view:', error.message)
  }
}
