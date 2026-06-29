# TraceCrumb First-60 — Lovable / Vibecoder Refinement Brief

## Objective

Refine the frontend/backend only where it improves first-value completion and deployment signal quality.

## Do Not Change

- Wedge: Wrong-first-call loss prevention
- Primary audience: SREs, DevOps engineers, platform engineers, incident commanders, on-call leads
- Core ask: Run one old incident and answer: would this have changed your first diagnostic branch?
- Supabase auth + DB model.
- OpenAI/Gemini fallback function pattern.

## Required Frontend Refinements

1. Add a no-auth demo mode with one seeded example.
2. Make the first CTA impossible to miss.
3. Make output copyable/exportable in one click.
4. Add a post-result question matching the behavioral ask.
5. Add source-channel tracking from URL params into the saved event/log.
6. Keep all copy pain-first and branch-specific.

## Required Backend Refinements

1. Store every generated artifact/result with `source_channel`.
2. Store outcome feedback from the behavioral ask.
3. Add basic analytics view: trials, own-case tests, reuses, team/integration asks.
4. Preserve AI provider, fallback status, and raw response for debugging.
5. Do not add complex integrations until manual signals prove the branch.

## Design Style

Functional, sharp, low-friction. Avoid SaaS bloat. The user should know what to paste, what they get, and why it matters in under 5 seconds.

## Acceptance Criteria

- A new user can reach first value in ≤5 minutes.
- A user can copy/share the result.
- The MVP logs enough behavior to judge deployment signal.
- The UI never explains TraceCrumb as a whole before delivering branch value.
