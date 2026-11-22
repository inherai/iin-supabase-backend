// The OpenAI models the API calls, in one place. OpenAI retires models on a schedule
// (gpt-4o-mini shuts down 2027-01-14; the search-preview models shut down 2026-07-23),
// so a replacement is a change here, not a hunt through the routes.
// process-job-ai is a separate function and names its own model.

export const CHAT_MODEL = 'gpt-6-luna'

/**
 * Spread into every chat.completions call. The tasks are translation, extraction and short
 * summaries, which need no reasoning: effort 'none' keeps the old latency and cost, and keeps
 * `temperature` valid (OpenAI: remove it only when effort is not 'none').
 * openai@4's types predate effort 'none' — the API accepts it — hence the cast.
 */
export const CHAT_PARAMS = { model: CHAT_MODEL, reasoning_effort: 'none' as any }

/** Chat Completions model that searches the web (admin: a company's details from the web). */
export const WEB_SEARCH_MODEL = 'gpt-5-search-api'
