// People-search filters shared by the inner-circle tabs (connections + suggestions).
// Query params: q, functions (comma-separated job-function keys), company (company key),
// company_scope ('current' | 'any'), recruiters ('1'), mutual ('1').
// Returns the RPC arguments, or null when none of the filters is present.
export function parsePeopleSearchParams(c: any) {
  const q = (c.req.query("q") || "").trim();
  const functions = (c.req.query("functions") || "")
    .split(",")
    .map((f: string) => f.trim())
    .filter((f: string) => /^[a-z_]{1,40}$/.test(f));
  const companyKey = (c.req.query("company") || "").trim();
  const companyScope = c.req.query("company_scope") === "any" ? "any" : "current";
  const recruitersOnly = c.req.query("recruiters") === "1";
  const mutualOnly = c.req.query("mutual") === "1";

  if (!q && functions.length === 0 && !companyKey && !recruitersOnly && !mutualOnly) return null;

  return {
    p_query: q.slice(0, 200) || null,
    p_functions: functions.length > 0 ? functions : null,
    p_company_key: companyKey.slice(0, 200) || null,
    p_company_scope: companyScope,
    p_recruiters_only: recruitersOnly,
    p_mutual_only: mutualOnly,
  };
}
