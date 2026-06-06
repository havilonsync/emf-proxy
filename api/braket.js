import { BraketClient, CreateQuantumTaskCommand } from "@aws-sdk/client-braket";

const client = new BraketClient({
  region: process.env.AWS_BRAKET_REGION,
  credentials: {
    accessKeyId: process.env.AWS_BRAKET_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_BRAKET_SECRET_ACCESS_KEY,
  },
});

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { circuit, device, shots = 100 } = req.body || {};
    const deviceArn = device || "arn:aws:braket:::device/quantum-simulator/amazon/sv1";

    const command = new CreateQuantumTaskCommand({
      deviceArn,
      openQasm: {
        braketSchemaHeader: { name: "braket.ir.openqasm.program", version: "1" },
        source: circuit || `OPENQASM 3.0; qubit[2] q; bit[2] c; h q[0]; cnot q[0], q[1]; c = measure q;`,
      },
      outputS3Bucket: "amazon-braket-emfoundation",
      outputS3KeyPrefix: "results",
      shots,
    });

    const result = await client.send(command);
    return res.status(200).json({ taskId: result.quantumTaskArn, status: result.status });
  } catch (err) {
    console.error("[braket error]", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
