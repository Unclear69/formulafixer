// Vercel serverless function.
// Deploy at api/formula.js.
// Env vars: DEEPSEEK_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js';

const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

function isRateLimited(ip) {
  const now = Date.now();
  const record = hits.get(ip) || { count: 0, start: now };
  if (now - record.start > WINDOW_MS) { record.count = 0; record.start = now; }
  record.count += 1;
  hits.set(ip, record);
  return record.count > MAX_PER_WINDOW;
}

function extractJson(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('no JSON object found');
  return JSON.parse(raw.slice(start, end + 1));
}

function extractJsonArray(raw) {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) throw new Error('no JSON array found');
  return JSON.parse(raw.slice(start, end + 1));
}

async function verifyJwt(token) {
  if (!token) return null;
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user;
  } catch { return null; }
}

async function checkSubscription(userId) {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from('subscriptions')
      .select('status, current_period_end')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return false;
    if (data.status !== 'active') return false;
    if (data.current_period_end && new Date(data.current_period_end) < new Date()) return false;
    return true;
  } catch { return false; }
}

const SYSTEM_PROMPT = `You are a formula processing engine, not a chat assistant. You only ever output one raw JSON object (or JSON array for bulk mode). Nothing else.

Rules, no exceptions:
- No text before or after the JSON.
- No markdown, no code fences, no backticks.
- No greetings, no sign-offs, no meta commentary.
- No caveats, disclaimers, or "note that" additions.
- explanation fields must be at most one short plain sentence, under 20 words, no jargon.
- formula fields must contain only the formula itself, starting with =, nothing else.
- If input is unclear or malformed, still return the JSON schema requested with your best-effort guess, never an apology.

In bulk mode, you receive an array of {cell, formula} objects. Return a JSON array of {cell, formula, explanation, issue} objects, one per input, in the same order.
- "issue" must be null unless you detect a broken formula (syntax error, wrong function name, mismatched parens, etc.) or a column-pattern anomaly (see below).
- If "issue" is non-null, "formula" MUST contain your corrected, working replacement formula — never the broken original. Describe what was wrong/changed in "issue", in the same short plain style as explanations.
- If "issue" is null (formula is fine), "formula" is simply the original, unchanged.

ANOMALY DETECTION (bulk only): When 3+ formulas share the same column letter, compare their structures. If one formula's pattern deviates from the majority, flag it with "issue" describing the mismatch (e.g. "Sums an extra column compared to nearby formulas — likely should be =SUM(I40:I41)."), and set "formula" to the corrected version that matches the column's pattern.`;

function buildUserPrompt(mode, value) {
  if (mode === "explain") return `Explain this formula in plain language. Return JSON: {"explanation": "..."}\nFormula: ${value}`;
  if (mode === "generate") return `Write a single Excel/Google Sheets formula. Return JSON: {"formula": "=...", "explanation": "..."}\nRequest: ${value}`;
  if (mode === "fix") return `Fix this broken formula. Return JSON: {"formula": "=...", "explanation": "..."}\nFormula: ${value}`;
  return '';
}

function buildBulkPrompt(items) {
  return `Analyze these formulas. Return a JSON array, one object per input: {"cell": "...", "formula": "=...", "explanation": "...", "issue": null} or {"cell": "...", "formula": "=...corrected...", "explanation": "...", "issue": "what was wrong and fixed"}.

Check for two kinds of problems:
1. Broken formulas — syntax errors, misspelled function names, mismatched parens/args. Fix them.
2. Column-pattern anomalies — group by column letter; if 3+ formulas share a column, flag any whose structure deviates from the majority, and correct it to match the pattern.

Whenever "issue" is non-null, "formula" must be the corrected, working replacement — never the broken/anomalous original.

Formulas:\n${JSON.stringify(items)}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) { res.status(429).json({ error: "too many requests, slow down" }); return; }

  const body = req.body || {};
  const mode = body.mode;

  // Single modes — no auth required
  if (mode === "explain" || mode === "generate" || mode === "fix") {
    const { value } = body;
    if (!value) { res.status(400).json({ error: "bad request" }); return; }
    try {
      const upstream = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({ model: "deepseek-chat", temperature: 0, max_tokens: 300, response_format: { type: "json_object" }, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: buildUserPrompt(mode, value) }] })
      });
      if (!upstream.ok) { console.error('DeepSeek upstream error', { status: upstream.status }); res.status(502).json({ error: "upstream failed" }); return; }
      const data = await upstream.json();
      const raw = data.choices?.[0]?.message?.content || "{}";
      const parsed = extractJson(raw);
      res.status(200).json(parsed);
    } catch (err) { console.error('Handler error (single)', err); res.status(500).json({ error: "processing failed" }); }
    return;
  }

  // Bulk mode — requires auth + subscription
  if (mode === "bulk") {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const user = await verifyJwt(token);
    if (!user) { res.status(401).json({ error: "authentication required" }); return; }

    const hasSub = await checkSubscription(user.id);
    if (!hasSub) { res.status(402).json({ error: "subscription required" }); return; }

    const { items } = body;
    if (!items || !Array.isArray(items) || !items.length) { res.status(400).json({ error: "bad request" }); return; }

    const capped = items.slice(0, 50);
    // ~150 tokens/item covers cell+formula+explanation+issue for a typical row,
    // including flagged rows where a full corrected formula gets duplicated into
    // both "formula" and described in "issue". 8000 is deepseek-chat's expandable
    // output ceiling (default is 4000) — going higher just returns a 400 from upstream.
    const dynamicTokens = Math.min(8000, Math.max(400, capped.length * 150));

    try {
      const upstream = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({ model: "deepseek-chat", temperature: 0, max_tokens: dynamicTokens, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: buildBulkPrompt(capped) }] })
      });
      if (!upstream.ok) { console.error('DeepSeek upstream error (bulk)', { status: upstream.status }); res.status(502).json({ error: "upstream failed" }); return; }
      const data = await upstream.json();
      const choice = data.choices?.[0];
      if (choice?.finish_reason === 'length') {
        // Response got cut off mid-JSON before it could close — parsing this would
        // either throw or silently return a truncated array. Fail loudly instead,
        // since the real cause (batch too big for the token budget) isn't obvious
        // from a generic parse error.
        console.error('DeepSeek response truncated (bulk)', { itemCount: capped.length, maxTokens: dynamicTokens });
        res.status(502).json({ error: "That batch was too large to process in one pass — try again with fewer formulas." });
        return;
      }
      const raw = choice?.message?.content || "[]";
      const parsed = extractJsonArray(raw);
      res.status(200).json({ items: parsed });
    } catch (err) { console.error('Handler error (bulk)', err); res.status(500).json({ error: "processing failed" }); }
    return;
  }

  res.status(400).json({ error: "unknown mode" });
}
