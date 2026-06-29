# TraceCrumb First-60

Know where to look first in a P1 using your own incident memory.

## Core loss-aversion wedge

- Pain: SRE/DevOps responders improvise from memory during the first 60 seconds of an incident.
- Loss prevented: Wrong first branch, duplicated debugging, longer MTTR, weaker postmortems.
- Proof metric: First-action success rate + time-to-resolution minutes.

## What is included

- Vite + React deployable MVP
- Supabase Auth integration
- Supabase Postgres/RLS schema: `supabase/schema.sql`
- Shared Edge Function: `supabase/functions/ai-orchestrator/index.ts`
- Branch-specific OpenAI and Gemini API fallback env vars
- Heuristic fallback when neither provider is configured or available

## Deploy sequence

1. Create a Supabase project.
2. In Supabase SQL editor, run `supabase/schema.sql` once.
3. Enable Email/Password auth in Supabase Auth settings.
4. Deploy the Edge Function:

```bash
supabase functions deploy ai-orchestrator
```

5. Set secrets for this branch. Do not put API keys in the frontend.

```bash
supabase secrets set TRACECRUMB_FIRST60_OPENAI_API_KEY="sk-..."
supabase secrets set TRACECRUMB_FIRST60_GEMINI_API_KEY="..."
```

Optional global fallback secrets:

```bash
supabase secrets set OPENAI_API_KEY="sk-..."
supabase secrets set GEMINI_API_KEY="..."
```

6. Copy `.env.example` to `.env.local` and fill Supabase browser values.

```bash
npm install
npm run dev
```

## Distribution motion

Drop the First-60 artifact into live SRE/DevOps pain threads; convert when teams ask to run it against their own incident history.

## Non-negotiable validation gate

Do not scale distribution unless the target user confirms the loss is real and the proof metric moves.
