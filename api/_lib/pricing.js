// Verified 2026-06-19 from primary sources:
//   Claude:   claude.com/platform/api
//   OpenAI:   developers.openai.com/api/docs/models
//   Gemini:   ai.google.dev/gemini-api/docs/pricing
//   xAI:      docs.x.ai/docs/models
//   DeepSeek: api-docs.deepseek.com/quick_start/pricing
export const PRICE_PER_1M = {
  claude:   { in: 3.00,  out: 15.00 },
  gpt4o:    { in: 0.75,  out:  4.50 },
  gemini:   { in: 1.50,  out:  9.00 },
  grok:     { in: 1.25,  out:  2.50 },
  deepseek: { in: 0.14,  out:  0.28 },
};
