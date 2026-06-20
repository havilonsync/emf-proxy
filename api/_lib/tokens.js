// Rough token estimator — 1 token ≈ 4 chars for English text
export function estTokens(str) {
  return Math.ceil((str || "").length / 4);
}

// Extract doc metrics from the system prompt.
// Injected doc block format: "--- DOCUMENT: filename.pdf (12345 chars) ---"
export function parseDocMetrics(system) {
  const docCount = (system.match(/--- DOCUMENT:/g) || []).length;
  const charMatches = [...system.matchAll(/\((\d+) chars\)/g)];
  const docCharCount = charMatches.reduce((sum, m) => sum + parseInt(m[1], 10), 0);
  return { docCount, docCharCount };
}
