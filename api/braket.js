import { BraketClient, CreateQuantumTaskCommand } from "@aws-sdk/client-braket";

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } },
};

const client = new BraketClient({
  region: process.env.AWS_BRAKET_REGION,
  credentials: {
    accessKeyId: process.env.AWS_BRAKET_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_BRAKET_SECRET_ACCESS_KEY,
  },
});

const DEFAULT_CIRCUIT = "OPENQASM 3;\nqubit[2] q;\nbit[2] c;\nh q[0];\ncnot q[0], q[1];\nc = measure q;";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { circuit, device, shots = 100 } = req.body || {};
    const deviceArn = device || "arn:aws:braket:::device/quantum-simulator/amazon/sv1";
    const source = circuit || DEFAULT_CIRCUIT;

    const action = JSON.stringify({
      braketSchemaHeader: { name: "braket.ir.openqasm.program", version: "1" },
      source,
      inputs: {},
    });

    const command = new CreateQuantumTaskCommand({
      deviceArn,
      action,
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
