import { estTokens, parseDocMetrics } from "./_lib/tokens.js";

export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } },
};

// Verified 2026-06-19 from primary sources:
//   Claude:   claude.com/platform/api
//   OpenAI:   developers.openai.com/api/docs/models
//   Gemini:   ai.google.dev/gemini-api/docs/pricing
//   xAI:      docs.x.ai/docs/models
//   DeepSeek: api-docs.deepseek.com/quick_start/pricing
const PRICE_PER_1M = {
  claude:   { in: 3.00,  out: 15.00 },
  gpt4o:    { in: 0.75,  out:  4.50 },
  gemini:   { in: 1.50,  out:  9.00 },
  grok:     { in: 1.25,  out:  2.50 },
  deepseek: { in: 0.14,  out:  0.28 },
};

const QUANTUM_ADDON_USD = {
  none:     0.00,
  basic:    0.90,   // midpoint of $0.85–0.95
  standard: 3.85,   // midpoint of $3.50–4.20
  premium:  4.50,
};

const VALID_MODELS  = new Set(Object.keys(PRICE_PER_1M));
const OUT_EST       = 800;   // estimated output tokens per call (80% of 1000 cap)
const MARGIN        = 1.15;  // 15% safety buffer covers chars/4 estimator roughness
const STRIPE_MIN    = 0.50;  // Stripe minimum charge in USD

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }

  const { models, rounds, redTeam, system, user, quantumTier } = body || {};

  if (!Array.isArray(models) || models.length === 0)
    return res.status(400).json({ error: "models must be a non-empty array" });

  const unknownModels = models.filter(m => !VALID_MODELS.has(m));
  if (unknownModels.length > 0)
    return res.status(400).json({ error: `Unknown model(s): ${unknownModels.join(", ")}` });

  const R = parseInt(rounds, 10);
  if (!R || R < 1 || R > 20)
    return res.status(400).json({ error: "rounds must be an integer between 1 and 20" });

  const systemStr = system || "";
  const userStr   = user   || "";
  const N         = models.length;

  const inputBase              = estTokens(systemStr) + estTokens(userStr);
  const { docCount, docCharCount } = parseDocMetrics(systemStr);

  // For red team: use the model with the highest output rate (most conservative cost estimate)
  const heaviestModel = models.reduce((best, m) =>
    PRICE_PER_1M[m].out > PRICE_PER_1M[best].out ? m : best
  );

  let aiCallsUsd     = 0;
  let totalModelCalls = 0;

  for (let r = 1; r <= R; r++) {
    // Each round's input grows because it includes all prior rounds' outputs
    const inputThisRound = inputBase + (r - 1) * N * OUT_EST;

    for (const m of models) {
      const p = PRICE_PER_1M[m];
      aiCallsUsd += (inputThisRound * p.in + OUT_EST * p.out) / 1_000_000;
      totalModelCalls++;
    }

    if (redTeam) {
      const p = PRICE_PER_1M[heaviestModel];
      aiCallsUsd += (inputThisRound * p.in + OUT_EST * p.out) / 1_000_000;
      totalModelCalls++;
    }
  }

  const quantumAddonUsd = QUANTUM_ADDON_USD[quantumTier] ?? 0;
  const rawTotal        = aiCallsUsd + quantumAddonUsd;
  const marginUsd       = rawTotal * (MARGIN - 1);
  const estimatedCostUsd = Math.max(
    STRIPE_MIN,
    Math.ceil(rawTotal * MARGIN * 100) / 100
  );

  return res.status(200).json({
    estimatedCostUsd,
    breakdown: {
      aiCallsUsd:      +aiCallsUsd.toFixed(4),
      quantumAddonUsd: +quantumAddonUsd.toFixed(2),
      marginUsd:       +marginUsd.toFixed(4),
      totalRounds:     R,
      totalModelCalls,
      baseInputTokEst: inputBase,
      avgInputTokEst:  Math.round(inputBase + ((R - 1) / 2) * N * OUT_EST),
      outEstPerCall:   OUT_EST,
      docCount,
      docCharCount,
    },
  });
}
