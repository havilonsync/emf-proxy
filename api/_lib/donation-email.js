import { Resend } from "resend";
import { buildReceiptContent } from "./receipt-content.js";

const FROM_EMAIL = process.env.DONATION_RECEIPT_FROM_EMAIL || "EM Foundation for AI Research <receipts@emfoundation.net>";

// Resend's constructor throws synchronously if the API key is missing/empty.
// Constructing it lazily (inside the function, not at module scope) means a
// missing key surfaces as a normal catchable error from sendReceiptEmail —
// exactly what the webhook's existing try/catch around email-sending expects
// — instead of crashing every import of this module (which, at module scope,
// would take down the whole webhook handler, including unrelated MMDE events,
// the instant RESEND_API_KEY is unset).
function getResendClient() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  return new Resend(process.env.RESEND_API_KEY);
}

// donationRow: the row returned from donations-db.js (snake_case columns)
export async function sendReceiptEmail(donationRow) {
  const { subject, text, html } = buildReceiptContent(donationRow);
  const resend = getResendClient();

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: donationRow.donor_email,
    subject,
    text,
    html,
  });

  if (error) {
    throw new Error(`Resend send failed: ${error.message || JSON.stringify(error)}`);
  }

  return data;
}
