// Re-attempts receipt emails for donations whose email never went out
// (e.g. the webhook's DB write succeeded but Resend failed or timed out).
// Safe to run repeatedly — only touches rows where receipt_email_sent_at IS NULL.
import pg from "pg";
import { sendReceiptEmail } from "../api/_lib/donation-email.js";

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL, max: 1 });

const { rows } = await pool.query(
  `SELECT * FROM donations WHERE receipt_email_sent_at IS NULL ORDER BY id`
);

console.log(`Found ${rows.length} donation(s) with no receipt sent yet.`);

for (const row of rows) {
  try {
    await sendReceiptEmail(row);
    await pool.query(
      `UPDATE donations SET receipt_email_sent_at = now(), receipt_email_error = NULL WHERE id = $1`,
      [row.id]
    );
    console.log(`  id=${row.id} -> sent`);
  } catch (err) {
    await pool.query(
      `UPDATE donations SET receipt_email_error = $2 WHERE id = $1`,
      [row.id, String(err.message).slice(0, 2000)]
    );
    console.error(`  id=${row.id} -> FAILED: ${err.message}`);
  }
}

await pool.end();
