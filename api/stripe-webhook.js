import Stripe from "stripe";
import { kv } from "@vercel/kv";
import { randomBytes } from "crypto";
import { insertDonationIfNew, markReceiptSent, markReceiptError } from "./_lib/donations-db.js";
import { sendReceiptEmail } from "./_lib/donation-email.js";

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
  const HANDLED_TYPES = new Set(["checkout.session.completed", "invoice.payment_succeeded"]);
  if (!HANDLED_TYPES.has(event.type))
    return res.status(200).json({ received: true });

  // Recurring donation renewal charges (and the first charge of a subscription)
  // arrive as invoice.payment_succeeded, not checkout.session.completed.
  if (event.type === "invoice.payment_succeeded")
    return handleDonationInvoicePaid(event.data.object, res);

  const session = event.data.object;
  const meta    = session.metadata;

  // Donations set their own distinct metadata marker so this flow can never
  // collide with MMDE's session logic below. Checked first, independently.
  if (meta && meta.donation_type === "general_fund")
    return handleDonationCheckoutCompleted(session, res);

  // Only process checkout sessions that match the MMDE payload shape.
  // Anything else is unrelated to emf-proxy and should no-op cleanly.
  if (
    !meta ||
    meta.models === undefined ||
    meta.rounds === undefined ||
    meta.redTeam === undefined ||
    meta.quantumTier === undefined ||
    meta.docCount === undefined ||
    meta.docCharCount === undefined ||
    !session.payment_intent ||
    typeof session.amount_total !== "number" ||
    session.amount_total <= 0
  ) {
    return res.status(200).json({ received: true });
  }

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

// ── Donations (general_fund) ────────────────────────────────────────────────

async function handleDonationCheckoutCompleted(session, res) {
  if (session.mode === "subscription") {
    // This event only marks the subscription's creation, not a charge — the
    // actual first (and every subsequent) payment arrives as its own
    // invoice.payment_succeeded event, handled by handleDonationInvoicePaid.
    // Recording a row here too would race/duplicate that event.
    try {
      await stripe.subscriptions.update(session.subscription, {
        metadata: { ...session.metadata, checkout_session_id: session.id },
      });
    } catch (err) {
      console.error("[webhook] donation subscription metadata backfill failed (non-fatal):", err.message);
    }
    console.log(`[webhook] donation subscription created sub=${session.subscription} session=${session.id}`);
    return res.status(200).json({ received: true });
  }

  // mode === "payment" — one-time donation; this session IS the charge.
  if (session.payment_status !== "paid" || !session.payment_intent) {
    console.error(`[webhook] donation checkout completed but not paid — session=${session.id}`);
    return res.status(200).json({ received: true });
  }

  const meta = session.metadata;
  const row = {
    donor_name:                 meta.donorName,
    donor_email:                meta.donorEmail,
    amount_usd:                 (session.amount_total / 100).toFixed(2),
    frequency:                  "one_time",
    is_recurring:               false,
    display_publicly:           meta.displayPublicly === "true",
    stripe_payment_id:          session.payment_intent,
    stripe_subscription_id:     null,
    stripe_checkout_session_id: session.id,
    stripe_customer_id:         session.customer || null,
    paid_at:                    new Date().toISOString(),
  };

  return recordDonationAndEmail(row, res);
}

async function handleDonationInvoicePaid(invoice, res) {
  // As of this account's current API version, invoices no longer carry a
  // top-level `subscription` field or embedded metadata — both moved under
  // invoice.parent.subscription_details (confirmed against a real invoice
  // from this account). Older API versions may still populate the flat
  // fields, so both shapes are checked, newest first.
  const subscriptionDetails = invoice.parent?.subscription_details;
  const subscriptionId = invoice.subscription || subscriptionDetails?.subscription;

  if (!subscriptionId)
    return res.status(200).json({ received: true });

  let meta = subscriptionDetails?.metadata;
  if (!meta) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      meta = subscription.metadata;
    } catch (err) {
      console.error("[webhook] failed to retrieve subscription for invoice:", err.message);
      return res.status(200).json({ received: true });
    }
  }

  if (!meta || meta.donation_type !== "general_fund")
    return res.status(200).json({ received: true });

  const row = {
    donor_name:                 meta.donorName,
    donor_email:                meta.donorEmail,
    amount_usd:                 (invoice.amount_paid / 100).toFixed(2),
    frequency:                  "monthly",
    is_recurring:               true,
    display_publicly:           meta.displayPublicly === "true",
    stripe_payment_id:          invoice.payment_intent || invoice.id,
    stripe_subscription_id:     subscriptionId,
    stripe_checkout_session_id: meta.checkout_session_id || null,
    stripe_customer_id:         invoice.customer || null,
    paid_at:                    new Date().toISOString(),
  };

  return recordDonationAndEmail(row, res);
}

// Shared by both donation paths above. Idempotent: stripe_payment_id has a
// unique constraint, so a Stripe redelivery never double-records. Email
// gating is on receipt_email_sent_at (not "was this insert new") so that if
// a prior invocation wrote the DB row but crashed before emailing, a later
// retry still sends the receipt exactly once.
async function recordDonationAndEmail(row, res) {
  let dbRow;
  try {
    const result = await insertDonationIfNew(row);
    dbRow = result.row;
  } catch (err) {
    console.error("[webhook] donation DB write failed:", err.message);
    // Return 500 so Stripe retries delivery — don't acknowledge a failed write
    return res.status(500).json({ error: "Donation storage failed" });
  }

  if (!dbRow.receipt_email_sent_at) {
    try {
      await sendReceiptEmail(dbRow);
      await markReceiptSent(dbRow.id);
    } catch (err) {
      console.error("[webhook] receipt email failed (non-fatal):", err.message);
      await markReceiptError(dbRow.id, err.message).catch(() => {});
    }
  }

  console.log(
    `[webhook] donation recorded id=${dbRow.id} amount=$${dbRow.amount_usd} ` +
    `frequency=${dbRow.frequency} payment=${dbRow.stripe_payment_id}`
  );

  return res.status(200).json({ received: true });
}
