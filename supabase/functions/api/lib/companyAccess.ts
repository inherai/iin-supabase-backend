// Who may act for a company page. The ONLY place the API asks that question.
//
// A page has managers (company_admins), each with a role. Everything here runs in the
// member's own session: she can read her own rows in company_admins, and the same rule is
// enforced again by row-level security on whatever she then writes (has_company_role()).
// companies.owner_uuid is the old single-owner field; nothing should read it any more.
import { can, type Subject } from './entitlements.ts'

export type CompanyRole = 'owner' | 'content' | 'recruiter' | 'analyst'

/** Edit the page and publish in its name. */
export const CONTENT_ROLES: CompanyRole[] = ['owner', 'content']
/** Jobs and applicants. */
export const RECRUITING_ROLES: CompanyRole[] = ['owner', 'recruiter']

/** The member's role on a page, or null when she doesn't manage it. */
export async function getCompanyRole(supabase: any, userId: string, companyId: number): Promise<CompanyRole | null> {
  const { data } = await supabase
    .from('company_admins')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()
  return (data?.role as CompanyRole) ?? null
}

export async function hasCompanyRole(
  supabase: any,
  userId: string,
  companyId: number,
  roles: CompanyRole[],
): Promise<boolean> {
  const role = await getCompanyRole(supabase, userId, companyId)
  return role !== null && roles.includes(role)
}

/** Ids of the pages the member manages in one of the given roles. */
export async function listManagedCompanyIds(supabase: any, userId: string, roles: CompanyRole[]): Promise<number[]> {
  const { data } = await supabase
    .from('company_admins')
    .select('company_id')
    .eq('user_id', userId)
    .in('role', roles)
  return (data || []).map((row: any) => row.company_id)
}

export type ActAsResult = { ok: true } | { ok: false; status: 403 | 404; error: string }

/**
 * May the member do this in the page's name? Checks, in order: the page exists, she holds
 * one of the roles, the page isn't suspended, and the page's plan includes the feature.
 */
export async function checkActAsCompany(
  supabase: any,
  userId: string,
  companyId: number,
  roles: CompanyRole[],
  feature: string,
): Promise<ActAsResult> {
  const { data: company } = await supabase
    .from('companies')
    .select('id, page_status')
    .eq('id', companyId)
    .maybeSingle()
  if (!company) return { ok: false, status: 404, error: 'Company not found' }

  if (!await hasCompanyRole(supabase, userId, companyId, roles)) {
    return { ok: false, status: 403, error: "You don't have permission to post on behalf of this company" }
  }
  if (company.page_status === 'suspended') {
    return { ok: false, status: 403, error: 'This page is suspended' }
  }
  const subject: Subject = { type: 'company', id: companyId }
  if (!await can(supabase, subject, feature)) {
    return { ok: false, status: 403, error: "This page's plan doesn't include this" }
  }
  return { ok: true }
}
