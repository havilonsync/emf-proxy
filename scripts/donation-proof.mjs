const [, , baseUrlArg] = process.argv;
const baseUrl = (baseUrlArg || "http://127.0.0.1:3000").replace(/\/$/, "");

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, ok: response.ok, body: json };
}

async function createDonationCheckout(payload) {
  return fetchJson(`${baseUrl}/api/create-donation-checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const oneTime = await createDonationCheckout({
  amount: 25,
  frequency: "one_time",
  donorName: "Proof Tester",
  donorEmail: "proof-tester@example.com",
  displayPublicly: false,
});

const monthly = await createDonationCheckout({
  amount: 10,
  frequency: "monthly",
  donorName: "Proof Tester",
  donorEmail: "proof-tester@example.com",
  displayPublicly: false,
});

console.log(JSON.stringify({ oneTime, monthly }, null, 2));

if (oneTime.ok && oneTime.body?.url) {
  console.log(`\nOne-time checkout URL:\n${oneTime.body.url}`);
}
if (monthly.ok && monthly.body?.url) {
  console.log(`\nMonthly checkout URL:\n${monthly.body.url}`);
}
