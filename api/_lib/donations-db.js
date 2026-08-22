import pg from "pg";

// Module-scope singleton so warm Lambda invocations reuse the connection.
// max: 1 — each serverless instance is effectively single-concurrency;
// keeping the pool small avoids exhausting Neon's connection cap.
const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL, max: 1 });

const INSERT_COLUMNS = [
  "donor_name", "donor_email", "amount_usd", "frequency", "is_recurring",
  "display_publicly", "stripe_payment_id", "stripe_subscription_id",
  "stripe_checkout_session_id", "stripe_customer_id", "paid_at",
];

// Inserts a donation row, or returns the existing row if stripe_payment_id
// already exists (Stripe redelivers webhooks — this is the idempotency guard).
export async function insertDonationIfNew(row) {
  const values = INSERT_COLUMNS.map(col => row[col] ?? null);
  const placeholders = INSERT_COLUMNS.map((_, i) => `$${i + 1}`).join(", ");

  const insertResult = await pool.query(
    `INSERT INTO donations (${INSERT_COLUMNS.join(", ")})
     VALUES (${placeholders})
     ON CONFLICT (stripe_payment_id) DO NOTHING
     RETURNING *`,
    values
  );

  if (insertResult.rows[0]) {
    return { row: insertResult.rows[0], wasNew: true };
  }

  const existing = await pool.query(
    `SELECT * FROM donations WHERE stripe_payment_id = $1`,
    [row.stripe_payment_id]
  );
  return { row: existing.rows[0], wasNew: false };
}

export async function markReceiptSent(id) {
  await pool.query(
    `UPDATE donations SET receipt_email_sent_at = now(), receipt_email_error = NULL WHERE id = $1`,
    [id]
  );
}

export async function markReceiptError(id, message) {
  await pool.query(
    `UPDATE donations SET receipt_email_error = $2 WHERE id = $1`,
    [id, String(message).slice(0, 2000)]
  );
}

export async function findByCheckoutSessionId(sessionId) {
  const { rows } = await pool.query(
    `SELECT * FROM donations WHERE stripe_checkout_session_id = $1 ORDER BY id DESC LIMIT 1`,
    [sessionId]
  );
  return rows[0] || null;
}

export async function findBySubscriptionId(subscriptionId) {
  const { rows } = await pool.query(
    `SELECT * FROM donations WHERE stripe_subscription_id = $1 ORDER BY id DESC LIMIT 1`,
    [subscriptionId]
  );
  return rows[0] || null;
}

export async function findByPaymentId(paymentId) {
  const { rows } = await pool.query(
    `SELECT * FROM donations WHERE stripe_payment_id = $1 LIMIT 1`,
    [paymentId]
  );
  return rows[0] || null;
}
