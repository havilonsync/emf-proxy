import Stripe from "stripe";
import { kv } from "@vercel/kv";
import { randomBytes } from "crypto";

// Body parser must be off — stripe.webhooks.constructEvent() requires the raw
// request bytes to verify the signature. Parsed JSON won't match the HMAC.
export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data",  c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end",   () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error("[webhook] failed to read body:", err.message);
    return res.status(400).json({ error: "Could not read request body" });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("[webhook] signature verification failed:", err.message);
    return res.status(400).json({ error: `Webhook signature invalid: ${err.message}` });
  }

  // Acknowledge event types we don't handle — Stripe retries on non-2xx
  if (event.type !== "checkout.session.completed")
    return res.status(200).json({ received: true });

  const session = event.data.object;
  const meta    = session.metadata;

  const token   = randomBytes(8).toString("hex");  // 16-char opaque token
  const paidUsd = session.amount_total / 100;      // Stripe stores cents

  const record = {
    checkoutSessionId:  session.id,
    paymentIntentId:    session.payment_intent,  // needed for refunds
    paidAmountUsd:      paidUsd,
    remainingBudgetUsd: paidUsd,
    models:             meta.models.split(","),
    rounds:             parseInt(meta.rounds,       10),
    redTeam:            meta.redTeam === "true",
    quantumTier:        meta.quantumTier,
    docCount:           parseInt(meta.docCount,     10),
    docCharCount:       parseInt(meta.docCharCount, 10),
    createdAt:          new Date().toISOString(),
    completedAt:        null,
    actualCostUsd:      0,
  };

  const TTL = 604800; // 7 days in seconds

  try {
    await Promise.all([
      // Primary record — looked up by token on every /api/proxy call
      kv.set(`session:${token}`, JSON.stringify(record), { ex: TTL }),
      // Reverse lookup — frontend exchanges cs_xxx for the opaque token on return from Stripe
      kv.set(`checkout:${session.id}`, token, { ex: TTL }),
    ]);
  } catch (err) {
    console.error("[webhook] KV write failed:", err.message);
    // Return 500 so Stripe retries delivery — don't acknowledge a failed write
    return res.status(500).json({ error: "Session storage failed" });
  }

  console.log(
    `[webhook] session created token=${token} ` +
    `paid=$${paidUsd} cs=${session.id} models=${meta.models}`
  );

  // ── Ledger event ────────────────────────────────────────────────────────────
  // Minimal structured record with enough fields to migrate into a shared
  // EM Foundation billing ledger later (CR-Lite, CIRE, etc. will each write
  // their own tool-keyed entries). Not in the critical path — failure is
  // non-fatal since the session is already committed above.
  const ledgerEvent = {
    ts:                new Date().toISOString(),
    tool:              "MMDE",
    event:             "session.created",
    token,
    paidUsd,
    checkoutSessionId: session.id,
    paymentIntentId:   session.payment_intent,
  };
  console.log("[ledger]", JSON.stringify(ledgerEvent));
  kv.lpush("ledger:MMDE", JSON.stringify(ledgerEvent)).catch(err =>
    console.error("[ledger] KV write failed (non-fatal):", err.message)
  );

  return res.status(200).json({ received: true });
}
