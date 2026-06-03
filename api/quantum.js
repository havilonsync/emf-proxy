export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } },
};

const IBM_QUANTUM_BASE = "https://us-east.quantum-computing.ibm.com";
const IAM_TOKEN_URL = "https://iam.cloud.ibm.com/identity/token";

async function getIAMToken(apiKey) {
  const resp = await fetch(IAM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ibm:params:oauth:grant-type:apikey",
      apikey: apiKey,
    }).toString(),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`IAM auth failed (${resp.status}): ${data.errorMessage || data.errorCode || resp.statusText}`);
  }
  return data.access_token;
}

// Qiskit Runtime REST API JSON serialization for circuits
function qasm3(source) {
  return { __type__: "QuantumCircuit", __value__: source };
}

// hypothesis-expansion: 4-qubit GHZ state (entanglement across all qubits)
// simulation: 2-qubit Bell state (minimal working circuit)
const CIRCUITS = {
  "hypothesis-expansion": qasm3(
    `OPENQASM 3.0;
include "stdgates.inc";
qubit[4] q;
bit[4] c;
h q[0];
cx q[0], q[1];
cx q[0], q[2];
cx q[0], q[3];
c = measure q;`
  ),
  simulation: qasm3(
    `OPENQASM 3.0;
include "stdgates.inc";
qubit[2] q;
bit[2] c;
h q[0];
cx q[0], q[1];
c = measure q;`
  ),
};

const VALID_BACKENDS = ["ibm_kingston", "ibm_fez", "ibm_marrakesh"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { IBM_QUANTUM_TOKEN, IBM_QUANTUM_CRN } = process.env;
  if (!IBM_QUANTUM_TOKEN || !IBM_QUANTUM_CRN) {
    return res.status(500).json({ error: "IBM_QUANTUM_TOKEN or IBM_QUANTUM_CRN not configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }

  const { circuit_type = "simulation", backend = "ibm_kingston", shots = 1024 } = body || {};

  if (!CIRCUITS[circuit_type]) {
    return res.status(400).json({
      error: `Unknown circuit_type '${circuit_type}'. Valid: hypothesis-expansion, simulation`,
    });
  }
  if (!VALID_BACKENDS.includes(backend)) {
    return res.status(400).json({
      error: `Unknown backend '${backend}'. Valid: ${VALID_BACKENDS.join(", ")}`,
    });
  }

  try {
    const accessToken = await getIAMToken(IBM_QUANTUM_TOKEN);

    // params must be a JSON string per the Qiskit Runtime REST API spec
    const params = JSON.stringify({
      pubs: [[CIRCUITS[circuit_type], {}, shots]],
      version: 2,
    });

    const jobResp = await fetch(`${IBM_QUANTUM_BASE}/v1/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "Service-CRN": IBM_QUANTUM_CRN,
      },
      body: JSON.stringify({
        program_id: "sampler",
        backend,
        params,
      }),
    });

    const jobData = await jobResp.json();
    if (!jobResp.ok) {
      throw new Error(`Job submission failed (${jobResp.status}): ${JSON.stringify(jobData)}`);
    }

    return res.status(200).json({
      job_id: jobData.id,
      status: jobData.status,
      backend: jobData.backend || backend,
      circuit_type,
      created: jobData.created,
    });

  } catch (err) {
    console.error("[quantum error]", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
