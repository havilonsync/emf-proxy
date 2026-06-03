export default async function handler(req, res) {
  // Allow requests from emfoundation.net
  res.setHeader("Access-Control-Allow-Origin", "https://emfoundation.net");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { model, system, user } = req.body;

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
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      const d = await r.json();
      if (d.error) throw new Error(`Claude: ${d.error.message}`);
      result = {
        text: d.content.map(b => b.type === "text" ? b.text : "").join(""),
        tokIn: d.usage?.input_tokens || 0,
        tokOut: d.usage?.output_tokens || 0,
      };

    } else if (model === "gpt4o") {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 1000,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      const d = await r.json();
      if (d.error) throw new Error(`GPT-4o: ${d.error.message}`);
      result = {
        text: d.choices[0].message.content,
        tokIn: d.usage?.prompt_tokens || 0,
        tokOut: d.usage?.completion_tokens || 0,
      };

    } else if (model === "gemini") {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: `${system}\n\n${user}` }] }],
            generationConfig: { maxOutputTokens: 1000 },
          }),
        }
      );
      const d = await r.json();
      if (d.error) throw new Error(`Gemini: ${d.error.message}`);
      result = {
        text: d.candidates[0].content.parts[0].text,
        tokIn: d.usageMetadata?.promptTokenCount || 0,
        tokOut: d.usageMetadata?.candidatesTokenCount || 0,
      };

    } else if (model === "grok") {
      const r = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.GROK_KEY}`,
        },
        body: JSON.stringify({
          model: "grok-2-1212",
          max_tokens: 1000,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      const d = await r.json();
      if (d.error) throw new Error(`Grok: ${d.error.message}`);
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
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      const d = await r.json();
      if (d.error) throw new Error(`DeepSeek: ${d.error.message}`);
      result = {
        text: d.choices[0].message.content,
        tokIn: d.usage?.prompt_tokens || 0,
        tokOut: d.usage?.completion_tokens || 0,
      };

    } else {
      return res.status(400).json({ error: "Unknown model" });
    }

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
