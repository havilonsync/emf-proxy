import Stripe from "stripe";

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const VALID_MODELS  = new Set(["claude", "gpt4o", "gemini", "grok", "deepseek"]);
const VALID_QUANTUM = new Set(["none", "basic", "standard", "premium"]);
const STRIPE_MIN    = 0.50;

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

  const {
    estimatedCostUsd, models, rounds, redTeam,
    quantumTier, docCount, docCharCount,
  } = body || {};

  // Defense-in-depth floor — /api/estimate already enforces $0.50 but a
  // tampered frontend request could bypass it.
  if (typeof estimatedCostUsd !== "number" || estimatedCostUsd < STRIPE_MIN)
    return res.status(400).json({ error: `estimatedCostUsd must be >= $${STRIPE_MIN}` });

  if (!Array.isArray(models) || models.length === 0 || models.some(m => !VALID_MODELS.has(m)))
    return res.status(400).json({ error: "Invalid models array" });

  const R = parseInt(rounds, 10);
  if (!R || R < 1 || R > 20)
    return res.status(400).json({ error: "rounds must be between 1 and 20" });

  const tier = quantumTier || "none";
  if (!VALID_QUANTUM.has(tier))
    return res.status(400).json({ error: "Invalid quantumTier" });

  const description = [
    models.join(", "),
    `${R} round${R !== 1 ? "s" : ""}`,
    redTeam         ? "Red Team"        : null,
    tier !== "none" ? `Quantum ${tier}` : null,
  ].filter(Boolean).join(" · ");

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: Math.round(estimatedCostUsd * 100),
          product_data: {
            name: "EM Deliberation Session",
            description,
          },
        },
        quantity: 1,
      }],
      success_url: `${process.env.APP_URL}/deliberation.html?session={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.APP_URL}/deliberation.html`,
      metadata: {
        estimatedCostUsd: String(estimatedCostUsd),
        models:           models.join(","),
        rounds:           String(R),
        redTeam:          String(!!redTeam),
        quantumTier:      tier,
        docCount:         String(docCount     ?? 0),
        docCharCount:     String(docCharCount ?? 0),
      },
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("[create-checkout error]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
