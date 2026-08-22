CREATE TABLE IF NOT EXISTS donations (
  id                          BIGSERIAL PRIMARY KEY,
  donor_name                  TEXT        NOT NULL,
  donor_email                 TEXT        NOT NULL,
  amount_usd                  NUMERIC(10,2) NOT NULL CHECK (amount_usd >= 0.50),
  frequency                   TEXT        NOT NULL CHECK (frequency IN ('one_time','monthly')),
  is_recurring                BOOLEAN     NOT NULL,
  display_publicly            BOOLEAN     NOT NULL DEFAULT FALSE,

  stripe_payment_id           TEXT        NOT NULL,   -- PaymentIntent id (one-time) or invoice.payment_intent/invoice.id (recurring charge)
  stripe_subscription_id      TEXT,                    -- NULL for one-time
  stripe_checkout_session_id  TEXT,                    -- always set for one-time; best-effort for recurring
  stripe_customer_id          TEXT,

  -- Unused placeholder columns for a future donor-perk/merch feature. No fulfillment logic is built now.
  wants_merch_perk            BOOLEAN,
  shipping_address            JSONB,

  paid_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  refund_status                TEXT NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none','partial','full','disputed')),
  refunded_at                  TIMESTAMPTZ,

  receipt_email_sent_at        TIMESTAMPTZ,
  receipt_email_error          TEXT,

  CONSTRAINT donations_stripe_payment_id_unique UNIQUE (stripe_payment_id)
);

CREATE INDEX IF NOT EXISTS idx_donations_checkout_session_id ON donations(stripe_checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_donations_subscription_id     ON donations(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_donations_donor_email          ON donations(donor_email);
