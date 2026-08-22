import Stripe from "stripe";
import { findByCheckoutSessionId, findBySubscriptionId, findByPaymentId } from "./_lib/donations-db.js";
import { buildReceiptContent } from "./_lib/receipt-content.js";

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// session_id is the only access gate on this endpoint (see CORS comment
// below) and never expires on Stripe's side, so this endpoint enforces its
// own expiry against the charge's actual paid_at — not the checkout
// session's created time, which for a recurring donation reflects only the
// original signup and would make every renewal's receipt link expire
// almost immediately even though each renewal has its own fresh paid_at.
const RECEIPT_LINK_EXPIRY_MS = 48 * 60 * 60 * 1000; // 48 hours

// Unlike create-donation-checkout (returns only a Stripe redirect URL) and
// stripe-webhook (server-to-server, no CORS header at all), this endpoint
// returns the donor's name gated only by knowledge of the checkout session
// id. Wildcard CORS would let any origin that obtains a session id read
// that PII cross-origin, so this is locked to the actual frontend origin(s).
const ALLOWED_ORIGINS = new Set([
  "https://emfoundation.net",
  "https://www.emfoundation.net",
]);

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
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

  if (Date.now() - new Date(row.paid_at).getTime() > RECEIPT_LINK_EXPIRY_MS) {
    return res.status(410).json({ status: "expired" });
  }

  const { structured } = buildReceiptContent(row);
  return res.status(200).json({ status: "ready", receipt: structured });
}
