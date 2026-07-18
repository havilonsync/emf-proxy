import { estTokens, parseDocMetrics } from "./_lib/tokens.js";
import { PRICE_PER_1M } from "./_lib/pricing.js";

export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } },
};

const QUANTUM_ADDON_USD = {
  none:     0.00,
  basic:    0.90,   // midpoint of $0.85–0.95
  standard: 3.85,   // midpoint of $3.50–4.20
  premium:  4.50,
};

const VALID_MODELS  = new Set(Object.keys(PRICE_PER_1M));
const ESTIMATED_OUTPUT_TOKENS = {
  claude: 1000,
  gpt4o: 1000,
  gemini: 3200,
  grok: 1000,
  deepseek: 1000,
};
// Keep checkout estimate safety margin in sync with proxy pre-flight gate.
const ESTIMATE_SAFETY_MULTIPLIER = 1.2;
const STRIPE_MIN = 0.50;  // Stripe minimum charge in USD

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
  const heaviestOutEst = ESTIMATED_OUTPUT_TOKENS[heaviestModel] ?? 1000;
  const outputTokPerRound = models.reduce(
    (sum, m) => sum + (ESTIMATED_OUTPUT_TOKENS[m] ?? 1000),
    0
  ) + (redTeam ? heaviestOutEst : 0);

  let aiCallsUsd     = 0;
  let totalModelCalls = 0;

  for (let r = 1; r <= R; r++) {
    // Each round's input grows because it includes all prior rounds' outputs
    const inputThisRound = inputBase + (r - 1) * outputTokPerRound;

    for (const m of models) {
      const p = PRICE_PER_1M[m];
      const outEst = ESTIMATED_OUTPUT_TOKENS[m] ?? 1000;
      aiCallsUsd += (inputThisRound * p.in + outEst * p.out) / 1_000_000;
      totalModelCalls++;
    }

    if (redTeam) {
      const p = PRICE_PER_1M[heaviestModel];
      aiCallsUsd += (inputThisRound * p.in + heaviestOutEst * p.out) / 1_000_000;
      totalModelCalls++;
    }
  }

  const quantumAddonUsd = QUANTUM_ADDON_USD[quantumTier] ?? 0;
  const rawTotal        = aiCallsUsd + quantumAddonUsd;
  const marginUsd       = rawTotal * (ESTIMATE_SAFETY_MULTIPLIER - 1);
  const estimatedCostUsd = Math.max(
    STRIPE_MIN,
    Math.ceil(rawTotal * ESTIMATE_SAFETY_MULTIPLIER * 100) / 100
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
      avgInputTokEst:  Math.round(inputBase + ((R - 1) / 2) * outputTokPerRound),
      outEstPerCallByModel: models.reduce((acc, m) => {
        acc[m] = ESTIMATED_OUTPUT_TOKENS[m] ?? 1000;
        return acc;
      }, {}),
      outputTokGrowthPerRound: outputTokPerRound,
      docCount,
      docCharCount,
    },
  });
}
