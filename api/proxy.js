export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb",
    },
  },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;

  // If body is a string, parse it
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch(e) {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }

  const { model, system, user } = body || {};

  if (!model || !user) {
    return res.status(400).json({ error: "Missing model or user in request body" });
  }

  try {
    let result;

    if (model === "claude") {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system: system || "",
          messages: [{ role: "user", content: user }],
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(`Claude ${r.status}: ${d.error?.message || r.statusText}`);
      result = {
        text: d.content.map(b => b.type === "text" ? b.text : "").join(""),
        tokIn: d.usage?.input_tokens || 0,
        tokOut: d.usage?.output_tokens || 0,
      };

    } else if (model === "gpt4o") {
      if (!process.env.OPENAI_KEY) throw new Error("GPT-4o: OPENAI_KEY not configured");
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-5.4-mini",
          max_completion_tokens: 1000,
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: user },
          ],
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(`GPT-4o ${r.status}: ${d.error?.message || r.statusText}`);
      result = {
        text: d.choices[0].message.content,
        tokIn: d.usage?.prompt_tokens || 0,
        tokOut: d.usage?.completion_tokens || 0,
      };

    } else if (model === "gemini") {
      if (!process.env.GEMINI_KEY) throw new Error("Gemini: GEMINI_KEY not configured");
      const geminiBody = {
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 4096 },
      };
      if (system) geminiBody.systemInstruction = { parts: [{ text: system }] };
      const r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": `${process.env.GEMINI_KEY}`,
          },
          body: JSON.stringify(geminiBody),
        }
      );
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(`Gemini ${r.status}: ${d.error?.message || r.statusText}`);
      result = {
        text: d.candidates[0].content.parts[0].text,
        tokIn: d.usageMetadata?.promptTokenCount || 0,
        tokOut: d.usageMetadata?.candidatesTokenCount || 0,
      };

    } else if (model === "grok") {
      if (!process.env.GROK_KEY) throw new Error("Grok: GROK_KEY not configured");
      const r = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.GROK_KEY}`,
        },
        body: JSON.stringify({
          model: "grok-3",
          max_tokens: 1000,
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: user },
          ],
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(`Grok ${r.status}: ${d.error?.message || r.statusText}`);
      result = {
        text: d.choices[0].message.content,
        tokIn: d.usage?.prompt_tokens || 0,
        tokOut: d.usage?.completion_tokens || 0,
      };

    } else if (model === "deepseek") {
      const r = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.DEEPSEEK_KEY}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          max_tokens: 1000,
          messages: [
            { role: "system", content: system || "" },
            { role: "user", content: user },
          ],
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(`DeepSeek ${r.status}: ${d.error?.message || r.statusText}`);
      result = {
        text: d.choices[0].message.content,
        tokIn: d.usage?.prompt_tokens || 0,
        tokOut: d.usage?.completion_tokens || 0,
      };

    } else {
      return res.status(400).json({ error: `Unknown model: ${model}` });
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error("[proxy error]", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
