// What a page (or, later, a person) may do under its plan. The ONLY place the API asks.
//
// The answer comes from the database (add_entitlements_safe.sql): an exception if there is
// one, else the subject's plan, else the default plan. Today there is one plan, 'free', with
// everything on — so these checks pass; they exist so that changing what is free later is a
// change of rows, not of code. Feature keys are the rows of the `features` table.
// Everything runs in the member's own session.

export interface Subject {
  type: 'company' | 'user'
  id: number | string
}

export interface Entitlement {
  enabled: boolean
  /** null = no limit */
  limit: number | null
  /** 'override' | 'plan:<key>' | 'default:<key>' | 'none' */
  source: string
}

export async function getEntitlement(supabase: any, subject: Subject, feature: string): Promise<Entitlement> {
  const { data, error } = await supabase.rpc('entitlement_value', {
    p_subject_type: subject.type,
    p_subject_id: String(subject.id),
    p_feature: feature,
  })
  // An answer we couldn't get is a "no": never hand out a feature by accident.
  if (error || !data?.length) {
    console.error('entitlement_value failed', { subject, feature, error: error?.message })
    return { enabled: false, limit: null, source: 'error' }
  }
  return { enabled: data[0].enabled === true, limit: data[0].limit_value ?? null, source: data[0].source }
}

/** Is the feature on for this subject? */
export async function can(supabase: any, subject: Subject, feature: string): Promise<boolean> {
  return (await getEntitlement(supabase, subject, feature)).enabled
}

/**
 * Count one use of a metered feature (e.g. invitations per month). Returns how many are left
 * (null = no limit), or { refused } when the feature is off or the limit is reached —
 * in which case nothing was counted.
 */
export async function consume(
  supabase: any,
  subject: Subject,
  feature: string,
  amount = 1,
): Promise<{ left: number | null } | { refused: string }> {
  const { data, error } = await supabase.rpc('entitlement_consume', {
    p_subject_type: subject.type,
    p_subject_id: String(subject.id),
    p_feature: feature,
    p_amount: amount,
  })
  if (error) return { refused: error.message }
  return { left: data ?? null }
}
