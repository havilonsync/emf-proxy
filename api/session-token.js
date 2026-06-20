import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const { checkoutSession } = req.query;
  if (!checkoutSession || !checkoutSession.startsWith("cs_")) {
    return res.status(400).json({ error: "Missing or invalid checkoutSession parameter" });
  }

  let token;
  try {
    token = await kv.get(`checkout:${checkoutSession}`);
  } catch (err) {
    console.error("[session-token] KV lookup failed:", err.message);
    return res.status(503).json({ error: "Session service unavailable. Please try again." });
  }

  if (!token) {
    return res.status(404).json({
      error: "session_not_found",
      message: "Session not found or expired. If you just completed payment, wait a moment and refresh.",
    });
  }

  return res.status(200).json({ token });
}
