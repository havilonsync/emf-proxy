import { estTokens, parseDocMetrics } from "./_lib/tokens.js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
};

// ── Diagnostic logger ────────────────────────────────────────────────────────
// Logs a structured line to Vercel Functions log for every model call.
// View at: vercel.com → emf-proxy → Logs → filter by [proxy]
function logCall({ provider, promptTokenEst, docCount, docCharCount, attempt, responseCode, responseTimeMs, error }) {
  const status = error ? "FAIL" : "OK";
  console.log(
    `[proxy] provider=${provider} | status=${status}` +
    ` | prompt_tok_est=${promptTokenEst}` +
    ` | doc_count=${docCount}` +
    ` | doc_chars=${docCharCount}` +
    ` | attempt=${attempt}` +
    ` | http=${responseCode}` +
    ` | time_ms=${responseTimeMs}` +
    (error ? ` | error="${error}"` : "")
  );
}

// ── Gemini retry wrapper ─────────────────────────────────────────────────────
async function fetchGeminiWithRetry(url, options, maxRetries, promptTokenEst, docCount, docCharCount) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const t0 = Date.now();
    const r = await fetch(url, options);
    const d = await r.json();
    const responseTimeMs = Date.now() - t0;

    if (
      r.status === 503 ||
      (d.error && (
        d.error.status === "UNAVAILABLE" ||
        (d.error.message && d.error.message.toLowerCase().includes("overload")) ||
        (d.error.message && d.error.message.toLowerCase().includes("high demand"))
      ))
    ) {
      const errMsg = d.error?.message || "Service temporarily unavailable";
      logCall({ provider: "Gemini", promptTokenEst, docCount, docCharCount, attempt, responseCode: r.status, responseTimeMs, error: errMsg });
      lastError = new Error(`Gemini ${r.status}: ${errMsg}`);
      if (attempt < maxRetries) {
        const waitMs = attempt * 4000; // 4s, 8s, 12s
        console.warn(`[proxy] Gemini 503 on attempt ${attempt}/${maxRetries} — retrying in ${waitMs}ms`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      throw lastError;
    }

    if (!r.ok || d.error) {
      const errMsg = d.error?.message || r.statusText;
      logCall({ provider: "Gemini", promptTokenEst, docCount, docCharCount, attempt, responseCode: r.status, responseTimeMs, error: errMsg });
      throw new Error(`Gemini ${r.status}: ${errMsg}`);
    }

    // Success
    logCall({ provider: "Gemini", promptTokenEst, docCount, docCharCount, attempt, responseCode: r.status, responseTimeMs });
    return { r, d };
  }
  throw lastError;
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch(e) {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }

  const { model, system, user } = body || {};
  if (!model || !user) {
    return res.status(400).json({ error: "Missing model or user in request body" });
  }

  // Compute shared metrics used in all log lines
  const systemStr = system || "";
  const userStr = user || "";
  const promptTokenEst = estTokens(systemStr) + estTokens(userStr);
  const { docCount, docCharCount } = parseDocMetrics(systemStr);

  try {
    let result;

    // ── Claude ───────────────────────────────────────────────────────────────
    if (model === "claude") {
      const t0 = Date.now();
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system: systemStr,
          messages: [{ role: "user", content: userStr }],
        }),
      });
      const d = await r.json();
      const responseTimeMs = Date.now() - t0;
      if (!r.ok || d.error) {
        const errMsg = d.error?.message || r.statusText;
        logCall({ provider: "Claude", promptTokenEst, docCount, docCharCount, attempt: 1, responseCode: r.status, responseTimeMs, error: errMsg });
        throw new Error(`Claude ${r.status}: ${errMsg}`);
      }
      logCall({ provider: "Claude", promptTokenEst, docCount, docCharCount, attempt: 1, responseCode: r.status, responseTimeMs });
      result = {
        text: d.content.map(b => b.type === "text" ? b.text : "").join(""),
        tokIn: d.usage?.input_tokens || 0,
        tokOut: d.usage?.output_tokens || 0,
      };

    // ── GPT-4o ───────────────────────────────────────────────────────────────
    } else if (model === "gpt4o") {
      if (!process.env.OPENAI_KEY) throw new Error("GPT-4o: OPENAI_KEY not configured");
      const t0 = Date.now();
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-5.4-mini",
          max_completion_tokens: 1000,
          messages: [
            ...(systemStr ? [{ role: "system", content: systemStr }] : []),
            { role: "user", content: userStr },
          ],
        }),
      });
      const d = await r.json();
      const responseTimeMs = Date.now() - t0;
      if (!r.ok || d.error) {
        const errMsg = d.error?.message || r.statusText;
        logCall({ provider: "GPT-4o", promptTokenEst, docCount, docCharCount, attempt: 1, responseCode: r.status, responseTimeMs, error: errMsg });
        throw new Error(`GPT-4o ${r.status}: ${errMsg}`);
      }
      logCall({ provider: "GPT-4o", promptTokenEst, docCount, docCharCount, attempt: 1, responseCode: r.status, responseTimeMs });
      result = {
        text: d.choices[0].message.content,
        tokIn: d.usage?.prompt_tokens || 0,
        tokOut: d.usage?.completion_tokens || 0,
      };

    // ── Gemini ───────────────────────────────────────────────────────────────
    } else if (model === "gemini") {
      if (!process.env.GEMINI_KEY) throw new Error("Gemini: GEMINI_KEY not configured");
      const geminiBody = {
        contents: [{ role: "user", parts: [{ text: userStr }] }],
        generationConfig: { maxOutputTokens: 8192 },
      };
      if (systemStr) geminiBody.systemInstruction = { parts: [{ text: systemStr }] };

      const { d } = await fetchGeminiWithRetry(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": process.env.GEMINI_KEY,
          },
          body: JSON.stringify(geminiBody),
        },
        3,
        promptTokenEst,
        docCount,
        docCharCount
      );

      const cand = d.candidates?.[0];
      if (!cand) throw new Error(`Gemini: no candidates returned (blockReason: ${d.promptFeedback?.blockReason || "none"})`);
      result = {
        text: (cand.content?.parts || []).map(p => p.text || "").join(""),
        finishReason: cand.finishReason || "unknown",
        tokIn: d.usageMetadata?.promptTokenCount || 0,
        tokOut: d.usageMetadata?.candidatesTokenCount || 0,
      };

    // ── Grok ─────────────────────────────────────────────────────────────────
    } else if (model === "grok") {
      if (!process.env.GROK_KEY) throw new Error("Grok: GROK_KEY not configured");
      const t0 = Date.now();
      const r = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.GROK_KEY}`,
        },
        body: JSON.stringify({
          model: "grok-4.3",
          max_tokens: 1000,
          messages: [
            ...(systemStr ? [{ role: "system", content: systemStr }] : []),
            { role: "user", content: userStr },
          ],
        }),
      });
      const d = await r.json();
      const responseTimeMs = Date.now() - t0;
      if (!r.ok || d.error) {
        const errMsg = d.error?.message || r.statusText;
        logCall({ provider: "Grok", promptTokenEst, docCount, docCharCount, attempt: 1, responseCode: r.status, responseTimeMs, error: errMsg });
        throw new Error(`Grok ${r.status}: ${errMsg}`);
      }
      logCall({ provider: "Grok", promptTokenEst, docCount, docCharCount, attempt: 1, responseCode: r.status, responseTimeMs });
      result = {
        text: d.choices[0].message.content,
        tokIn: d.usage?.prompt_tokens || 0,
        tokOut: d.usage?.completion_tokens || 0,
      };

    // ── DeepSeek ─────────────────────────────────────────────────────────────
    } else if (model === "deepseek") {
      const t0 = Date.now();
      const r = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.DEEPSEEK_KEY}`,
        },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          max_tokens: 1000,
          messages: [
            { role: "system", content: systemStr },
            { role: "user", content: userStr },
          ],
        }),
      });
      const d = await r.json();
      const responseTimeMs = Date.now() - t0;
      if (!r.ok || d.error) {
        const errMsg = d.error?.message || r.statusText;
        logCall({ provider: "DeepSeek", promptTokenEst, docCount, docCharCount, attempt: 1, responseCode: r.status, responseTimeMs, error: errMsg });
        throw new Error(`DeepSeek ${r.status}: ${errMsg}`);
      }
      logCall({ provider: "DeepSeek", promptTokenEst, docCount, docCharCount, attempt: 1, responseCode: r.status, responseTimeMs });
      result = {
        text: d.choices[0].message.content,
        tokIn: d.usage?.prompt_tokens || 0,
        tokOut: d.usage?.completion_tokens || 0,
      };

    } else {
      return res.status(400).json({ error: `Unknown model: ${model}` });
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error("[proxy error]", err.message || String(err));
    return res.status(500).json({ error: err.message || String(err) });
  }
}
