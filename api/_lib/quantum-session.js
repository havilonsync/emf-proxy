import { kv } from "@vercel/kv";

const QUANTUM_ESTIMATE_USD = {
  none: 0.0,
  ibm_hyp: 0.85,
  aws_hyp: 0.95,
  goog_hyp: 0.9,
  ibm_full: 3.5,
  aws_full: 4.2,
  goog_full: 3.8,
  all: 4.5,
};

function httpError(status, error, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.payload = { error, message, ...extra };
  return err;
}

export function getSessionToken(req) {
  return (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

export async function requirePaidSession(req) {
  const token = getSessionToken(req);
  if (!token) {
    throw httpError(
      401,
      "missing_session_token",
      "A session token is required. Purchase a session to continue."
    );
  }

  let rawRecord;
  try {
    rawRecord = await kv.get(`session:${token}`);
  } catch (err) {
    throw httpError(503, "session_unavailable", "Session service unavailable. Please try again.", {
      cause: err.message,
    });
  }

  if (!rawRecord) {
    throw httpError(
      401,
      "invalid_session_token",
      "Session token not found or expired."
    );
  }

  const record = typeof rawRecord === "string" ? JSON.parse(rawRecord) : rawRecord;
  return { token, record };
}

export function getQuantumEstimateUsd(record) {
  return QUANTUM_ESTIMATE_USD[record.quantumTier] ?? 0;
}

export async function reserveQuantumBudget(token, record, estimatedCostUsd) {
  if (record.remainingBudgetUsd < estimatedCostUsd) {
    throw httpError(
      402,
      "budget_exhausted",
      "Your session budget is exhausted. Purchase a new session to continue.",
      { remainingBudgetUsd: +record.remainingBudgetUsd.toFixed(6) }
    );
  }

  const nextRecord = {
    ...record,
    remainingBudgetUsd: +(record.remainingBudgetUsd - estimatedCostUsd).toFixed(6),
  };

  try {
    await kv.set(`session:${token}`, JSON.stringify(nextRecord), { keepTtl: true });
  } catch (err) {
    throw httpError(503, "session_unavailable", "Session service unavailable. Please try again.", {
      cause: err.message,
    });
  }

  return nextRecord;
}

export async function settleQuantumBudget(token, record, estimatedCostUsd, actualCostUsd, ledgerData = {}) {
  const nextRecord = {
    ...record,
    remainingBudgetUsd: +(record.remainingBudgetUsd + (estimatedCostUsd - actualCostUsd)).toFixed(6),
    actualCostUsd: +((record.actualCostUsd || 0) + actualCostUsd).toFixed(6),
    quantumActualCostUsd: +((record.quantumActualCostUsd || 0) + actualCostUsd).toFixed(6),
    lastQuantumChargeUsd: +actualCostUsd.toFixed(6),
    lastQuantumLedgerAt: new Date().toISOString(),
  };

  await kv.set(`session:${token}`, JSON.stringify(nextRecord), { keepTtl: true }).catch(err =>
    console.error("[quantum] budget settle failed (non-fatal):", err.message)
  );

  const ledgerEvent = {
    ts: new Date().toISOString(),
    tool: "MMDE",
    event: "quantum.settled",
    token,
    estimatedCostUsd: +estimatedCostUsd.toFixed(6),
    actualCostUsd: +actualCostUsd.toFixed(6),
    ...ledgerData,
  };

  console.log("[ledger]", JSON.stringify(ledgerEvent));
  kv.lpush("ledger:MMDE", JSON.stringify(ledgerEvent)).catch(err =>
    console.error("[ledger] KV write failed (non-fatal):", err.message)
  );

  return nextRecord;
}

export async function refundQuantumBudget(token, record, estimatedCostUsd, ledgerData = {}) {
  const nextRecord = {
    ...record,
    remainingBudgetUsd: +(record.remainingBudgetUsd + estimatedCostUsd).toFixed(6),
  };

  await kv.set(`session:${token}`, JSON.stringify(nextRecord), { keepTtl: true }).catch(() => {});

  const ledgerEvent = {
    ts: new Date().toISOString(),
    tool: "MMDE",
    event: "quantum.refunded",
    token,
    estimatedCostUsd: +estimatedCostUsd.toFixed(6),
    ...ledgerData,
  };

  console.log("[ledger]", JSON.stringify(ledgerEvent));
  kv.lpush("ledger:MMDE", JSON.stringify(ledgerEvent)).catch(err =>
    console.error("[ledger] KV write failed (non-fatal):", err.message)
  );

  return nextRecord;
}

export function sendHandlerError(res, prefix, err) {
  if (err?.status && err?.payload) {
    return res.status(err.status).json(err.payload);
  }

  console.error(prefix, err);
  return res.status(500).json({ error: err.message || String(err) });
}
