// Single source of truth for tax-receipt wording. Imported by both the
// email sender (donation-email.js) and the read-only receipt endpoint
// (donation-receipt.js) so the emailed and displayed content can never drift.
//
// Two lines below are IRS-compliance-critical and must not be paraphrased:
//   - the exact org name + EIN
//   - the "no goods or services" statement

const ORG_LINE = "EM Foundation for AI Research Inc., EIN 42-3000086";
const NO_GOODS_OR_SERVICES_STATEMENT = "No goods or services were provided in exchange for this contribution.";

function formatAmount(amountUsd) {
  return `$${Number(amountUsd).toFixed(2)}`;
}

function formatDate(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

// row: { donor_name, amount_usd, paid_at, frequency, id }
export function buildReceiptContent(row) {
  const isRecurring = row.frequency === "monthly";
  const amountStr = formatAmount(row.amount_usd);
  const dateStr = formatDate(row.paid_at);
  const donorName = row.donor_name;

  const recurringClause = isRecurring
    ? "This receipt covers only the payment made on this date. It is not a summary of your total giving for the tax year — if you make additional monthly contributions, each one will generate its own separate receipt."
    : null;

  const subject = `Your donation receipt — ${amountStr} to EM Foundation for AI Research`;

  const textLines = [
    `Dear ${donorName},`,
    "",
    `Thank you for your generous ${isRecurring ? "monthly " : ""}contribution of ${amountStr} on ${dateStr} to the EM Foundation for AI Research.`,
    "",
    ORG_LINE,
    "",
    NO_GOODS_OR_SERVICES_STATEMENT,
    ...(recurringClause ? ["", recurringClause] : []),
    "",
    "Please retain this receipt for your tax records.",
    "",
    "With gratitude,",
    "EM Foundation for AI Research Inc.",
  ];

  const text = textLines.join("\n");

  const html = `
    <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; color: #1a1a1a;">
      <p>Dear ${escapeHtml(donorName)},</p>
      <p>Thank you for your generous ${isRecurring ? "monthly " : ""}contribution of
        <strong>${escapeHtml(amountStr)}</strong> on ${escapeHtml(dateStr)} to the EM Foundation for AI Research.</p>
      <p><strong>${escapeHtml(ORG_LINE)}</strong></p>
      <p>${escapeHtml(NO_GOODS_OR_SERVICES_STATEMENT)}</p>
      ${recurringClause ? `<p style="color:#555;">${escapeHtml(recurringClause)}</p>` : ""}
      <p>Please retain this receipt for your tax records.</p>
      <p>With gratitude,<br/>EM Foundation for AI Research Inc.</p>
    </div>
  `.trim();

  return {
    subject,
    text,
    html,
    structured: {
      donationId: row.id,
      donorName,
      amountUsd: Number(row.amount_usd),
      amountStr,
      dateStr,
      isRecurring,
      frequency: row.frequency,
      orgLine: ORG_LINE,
      statement: NO_GOODS_OR_SERVICES_STATEMENT,
      recurringClause,
    },
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
