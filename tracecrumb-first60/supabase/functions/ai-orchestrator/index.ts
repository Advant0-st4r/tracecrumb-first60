import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const branchEnvPrefix: Record<string, string> = {
  first60: "TRACECRUMB_FIRST60",
  resume: "TRACECRUMB_RESUME",
  handoff: "TRACECRUMB_HANDOFF",
  continuity: "TRACECRUMB_CONTINUITY",
  shared: "TRACECRUMB_SHARED",
};

const systemPrompts: Record<string, string> = {
  first60: `You are TraceCrumb First-60. Produce strict JSON only. Objective: prevent wrong first diagnostic calls during incidents. Infer the highest-leverage first diagnostic branch from symptoms, signals, service context, similar incidents, and recent change/dependency clues. Be concrete, low-drama, loss-aware. Required keys: summary, suggested_branch, priority_checks, loss_prevention_reason, confidence, metrics_to_record.`,
  resume: `You are TraceCrumb Resume. Produce strict JSON only. Objective: restore interrupted cognitive state with minimum re-ramp cost. Build a context restoration bundle. Required keys: intent_layer, state_layer, open_threads, dependencies, recent_decisions, risk_layer, suggested_next_action, confidence, metrics_to_record.`,
  handoff: `You are TraceCrumb Handoff. Produce strict JSON only. Objective: preserve operational continuity across actors. Build a handoff packet that prevents re-contact and missing-intent errors. Required keys: state, intent, constraints, open_unknowns, dependencies, risk_forecast, continuation_path, continuity_risks, confidence, metrics_to_record.`,
  continuity: `You are TraceCrumb Continuity. Produce strict JSON only. Objective: replace fragile synchronous coordination with persistent artifacts and compute continuity risk. Required keys: artifact_type, async_artifact, meeting_substitution_verdict, eci_score_estimate, risks, next_actions, confidence, metrics_to_record.`,
  shared: `You are TraceCrumb. Produce strict JSON only. Create operational continuity artifacts tied to measurable loss reduction.`,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function keyFor(branch: string, provider: "OPENAI" | "GEMINI") {
  const prefix = branchEnvPrefix[branch] ?? branchEnvPrefix.shared;
  return Deno.env.get(`${prefix}_${provider}_API_KEY`) || Deno.env.get(`${provider}_API_KEY`) || "";
}

function extractJson(text: string) {
  const cleaned = text.trim().replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const slice = cleaned.slice(first, last + 1);
    try { return JSON.parse(slice); } catch (_) {}
  }
  return { summary: cleaned.slice(0, 2000), confidence: 0.35 };
}

async function callOpenAI(branch: string, action: string, payload: unknown) {
  const apiKey = keyFor(branch, "OPENAI");
  if (!apiKey) return null;
  const model = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "authorization": `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompts[branch] ?? systemPrompts.shared },
        { role: "user", content: JSON.stringify({ action, payload }) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "{}";
  return { provider: "openai", result: extractJson(content) };
}

async function callGemini(branch: string, action: string, payload: unknown) {
  const apiKey = keyFor(branch, "GEMINI");
  if (!apiKey) return null;
  const model = Deno.env.get("GEMINI_MODEL") || "gemini-1.5-flash";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      contents: [{
        role: "user",
        parts: [{ text: `${systemPrompts[branch] ?? systemPrompts.shared}\n\nAction: ${action}\nPayload JSON:\n${JSON.stringify(payload)}` }],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("\n") ?? "{}";
  return { provider: "gemini", result: extractJson(text) };
}

function lines(value: unknown): string[] {
  return String(value ?? "")
    .split(/\n|,|;/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function heuristic(branch: string, payload: any) {
  if (branch === "first60") {
    const symptom = payload?.symptom_text || payload?.symptom || payload?.title || "incident signals";
    return {
      provider: "heuristic",
      result: {
        summary: `Incident fingerprint created from: ${String(symptom).slice(0, 180)}`,
        suggested_branch: "Validate recent change, dependency health, and blast radius before assuming local service failure.",
        priority_checks: [
          "Check last deploy/config change in affected service",
          "Check upstream dependency health",
          "Compare fingerprint against last 30 incidents",
          "Verify customer impact before widening response",
        ],
        loss_prevention_reason: "This prevents the common loss pattern where responders debug the visible failing service before validating the triggering dependency or recent change.",
        confidence: 0.52,
        metrics_to_record: ["first_action_taken", "accepted_recommendation", "time_to_resolution_minutes", "root_cause_category"],
      },
    };
  }
  if (branch === "resume") {
    return {
      provider: "heuristic",
      result: {
        intent_layer: payload?.objective || "Resume the active work block with minimal context reconstruction.",
        state_layer: payload?.active_state || "Current state not fully specified; use source context to resume.",
        open_threads: lines(payload?.open_threads || payload?.source_context).slice(0, 5),
        dependencies: lines(payload?.dependencies || payload?.source_context).slice(0, 5),
        recent_decisions: lines(payload?.recent_decisions).slice(0, 5),
        risk_layer: ["Missing decision rationale", "Stale dependency state", "Unclear next action"],
        suggested_next_action: "Open the latest task/PR, verify blocker status, then execute the smallest action that produces a visible state change.",
        confidence: 0.5,
        metrics_to_record: ["minutes_to_first_output", "context_search_time", "restore_error_count"],
      },
    };
  }
  if (branch === "handoff") {
    return {
      provider: "heuristic",
      result: {
        state: payload?.state || "Current operational state captured from sender notes.",
        intent: payload?.intent || "Preserve the receiver's ability to continue without re-contact.",
        constraints: lines(payload?.constraints),
        open_unknowns: lines(payload?.open_unknowns),
        dependencies: lines(payload?.dependencies),
        risk_forecast: lines(payload?.risks).concat(["Receiver may miss rationale if decision context is absent"]).slice(0, 6),
        continuation_path: payload?.continuation_path || "Receiver should validate blockers first, then continue the lowest-risk next action.",
        continuity_risks: ["Missing intent", "Missing uncertainty", "Missing dependency owner"],
        confidence: 0.5,
        metrics_to_record: ["recontact_required", "recovery_minutes", "continuity_score", "error_introduced"],
      },
    };
  }
  return {
    provider: "heuristic",
    result: {
      artifact_type: "async_coordination_artifact",
      async_artifact: {
        current_state: payload?.current_state || "Workflow state needs canonical update.",
        decisions_needed: lines(payload?.decisions_needed),
        blockers: lines(payload?.blockers),
        owners: lines(payload?.owners),
        next_update_required: "Only escalate to meeting if blockers or decision conflict remain unresolved.",
      },
      meeting_substitution_verdict: "partial",
      eci_score_estimate: 0.55,
      risks: ["Decision ambiguity", "Dependency fragility", "Weak async update discipline"],
      next_actions: ["Publish state artifact", "Collect async responses", "Escalate only unresolved decision/conflict items"],
      confidence: 0.5,
      metrics_to_record: ["meeting_minutes_removed", "coordination_latency", "escalation_frequency", "eci_score"],
    },
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "POST required" }, 405);

  try {
    const body = await req.json();
    const branch = String(body.branch || "shared");
    const action = String(body.action || "generate");
    const payload = body.payload || {};

    let lastError = "";
    for (const fn of [callOpenAI, callGemini]) {
      try {
        const out = await fn(branch, action, payload);
        if (out) return jsonResponse({ ok: true, ...out });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    const fallback = heuristic(branch, payload);
    return jsonResponse({ ok: true, fallback: true, lastError, ...fallback });
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
