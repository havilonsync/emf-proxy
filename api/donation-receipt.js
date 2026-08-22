import Stripe from "stripe";
import { findByCheckoutSessionId, findBySubscriptionId, findByPaymentId } from "./_lib/donations-db.js";
import { buildReceiptContent } from "./_lib/receipt-content.js";

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const sessionId = String(req.query.session_id || "").trim();
  if (!sessionId.startsWith("cs_"))
    return res.status(400).json({ error: "Missing or invalid session_id" });

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (err) {
    return res.status(404).json({ error: "Session not found" });
  }

  // Never leak MMDE (or any other) checkout session data through this endpoint.
  if (!session.metadata || session.metadata.donation_type !== "general_fund")
    return res.status(404).json({ error: "Session not found" });

  let row;
  try {
    if (session.mode === "subscription") {
      row = session.subscription ? await findBySubscriptionId(session.subscription) : null;
    } else {
      row = await findByCheckoutSessionId(session.id);
      if (!row && session.payment_intent) {
        row = await findByPaymentId(session.payment_intent);
      }
    }
  } catch (err) {
    console.error("[donation-receipt] DB lookup failed:", err.message);
    return res.status(500).json({ error: "Lookup failed" });
  }

  if (!row) {
    // Webhook hasn't processed yet — normal in the seconds right after redirect.
    return res.status(202).json({ status: "pending" });
  }

  const { structured } = buildReceiptContent(row);
  return res.status(200).json({ status: "ready", receipt: structured });
}
