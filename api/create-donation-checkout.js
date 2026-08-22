import Stripe from "stripe";

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const STRIPE_MIN = 0.50;
const AMOUNT_MAX = 100000; // defensive upper bound, not a Stripe requirement
const VALID_FREQUENCIES = new Set(["one_time", "monthly"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DONOR_NAME_MAX_LEN = 200;

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

  const { amount, frequency, donorName, donorEmail, displayPublicly } = body || {};

  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < STRIPE_MIN || amount > AMOUNT_MAX)
    return res.status(400).json({ error: `amount must be a number between $${STRIPE_MIN} and $${AMOUNT_MAX}` });

  if (!VALID_FREQUENCIES.has(frequency))
    return res.status(400).json({ error: "frequency must be 'one_time' or 'monthly'" });

  const name = typeof donorName === "string" ? donorName.trim() : "";
  if (!name || name.length > DONOR_NAME_MAX_LEN)
    return res.status(400).json({ error: `donorName is required and must be <= ${DONOR_NAME_MAX_LEN} characters` });

  const email = typeof donorEmail === "string" ? donorEmail.trim() : "";
  if (!EMAIL_RE.test(email))
    return res.status(400).json({ error: "donorEmail must be a valid email address" });

  if (typeof displayPublicly !== "boolean")
    return res.status(400).json({ error: "displayPublicly must be a boolean" });

  const metadata = {
    donation_type: "general_fund",
    amount: String(amount),
    frequency,
    donorName: name,
    donorEmail: email,
    displayPublicly: String(displayPublicly),
  };

  const params = {
    payment_method_types: ["card"],
    success_url: `${process.env.APP_URL}/donate/thank-you.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}/donate/`,
    metadata,
  };

  if (frequency === "one_time") {
    params.mode = "payment";
    params.line_items = [{
      price_data: {
        currency: "usd",
        unit_amount: Math.round(amount * 100),
        product_data: {
          name: "Donation to EM Foundation for AI Research",
        },
      },
      quantity: 1,
    }];
  } else {
    params.mode = "subscription";
    params.line_items = [{
      price_data: {
        currency: "usd",
        unit_amount: Math.round(amount * 100),
        recurring: { interval: "month" },
        product_data: {
          name: "Monthly Donation to EM Foundation for AI Research",
        },
      },
      quantity: 1,
    }];
    // Propagates onto the created Subscription, and from there onto every
    // Invoice — needed so renewal charges (invoice.payment_succeeded) can
    // recover donor identity without the original Checkout Session.
    params.subscription_data = { metadata };
  }

  try {
    const session = await stripe.checkout.sessions.create(params);
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[create-donation-checkout error]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
