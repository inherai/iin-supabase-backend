# iin-supabase-backend

Supabase Edge Functions for iin application.

## Structure

```
supabase/
└── functions/
    └── api/
        ├── index.ts           # Main entry point
        ├── middleware.ts      # Middleware functions
        ├── deno.json         # Deno configuration
        └── routes/
            ├── summary.ts    # Summary routes
            ├── posts.ts      # Posts routes
            ├── jobs.ts       # Jobs routes
            ├── profile.ts    # Profile routes
            ├── me.ts         # User routes
            ├── like.ts       # Like routes
            └── search-ai.ts  # AI search routes
```

## Deployment

Push to `main` branch to trigger automatic deployment via GitHub Actions.

## Local Development

```bash
supabase functions serve api
```

## Required Secrets

- `SUPABASE_PROJECT_ID` - Your Supabase project reference ID
- `SUPABASE_ACCESS_TOKEN` - Your Supabase access token