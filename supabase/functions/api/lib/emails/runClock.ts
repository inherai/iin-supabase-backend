// A soft deadline for one timer run. Supabase stops a function at 2 s of CPU time; the work here
// is mostly waiting on the DB / Resend, so wall time is a safe stand-in. Jobs stop taking new
// recipients once it passes, and the next run (10 minutes later) carries on.
let deadline = Infinity

export const startRunClock = (ms: number) => { deadline = Date.now() + ms }
export const outOfTime = () => Date.now() > deadline
