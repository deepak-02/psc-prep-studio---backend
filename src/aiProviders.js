// Provider adapters for Platform AI.
// Handles calling Gemini and OpenAI with appropriate payload conversion, error classification, and timeouts.

export class ProviderError extends Error {
  constructor(kind, status, message) {
    super(message);
    this.kind = kind; // "auth" | "rate" | "quota" | "timeout" | "server" | "bad_request"
    this.status = status;
  }
  get permanent() {
    return this.kind === "bad_request";
  }
  get retryable() {
    return this.kind === "timeout" || this.kind === "server";
  }
}

const textOf = (parts) => (parts || []).map((p) => p.text || "").join("");

async function fetchWithTimeout(url, init, timeoutMs) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new ProviderError("timeout", 504, "Provider timed out.");
    }
    throw new ProviderError("server", 502, `Provider unreachable: ${e.message}`);
  }
}

export function classify(status, body = "") {
  if (
    status === 401 ||
    status === 403 ||
    (status === 400 && /api[_ ]?key|API_KEY_INVALID|invalid_api_key|PERMISSION_DENIED/i.test(body))
  ) {
    return new ProviderError("auth", status, "Key rejected or invalid.");
  }
  if (status === 429) {
    return /per.?day|daily|insufficient_quota|billing|exceeded your current quota|RESOURCE_EXHAUSTED.*day/i.test(body)
      ? new ProviderError("quota", 429, "Quota exhausted.")
      : new ProviderError("rate", 429, "Rate limited.");
  }
  if (status === 402) {
    return new ProviderError("quota", 402, "Billing/quota exhausted.");
  }
  if (status === 408 || status === 504) {
    return new ProviderError("timeout", status, "Provider timed out.");
  }
  if (status >= 500) {
    return new ProviderError("server", status, "Provider error.");
  }
  if (status === 404) {
    return new ProviderError("auth", 404, "Model not available for this key.");
  }
  return new ProviderError("bad_request", status, "Provider rejected request.");
}

export async function callGemini(key, model, req, opts = { timeoutMs: 90000, maxOutputTokens: 32768 }) {
  const modelName = encodeURIComponent(model.replace(/^models\//, ""));
  const body = {
    ...req,
    generationConfig: {
      ...req.generationConfig,
      maxOutputTokens: Math.min(
        req.generationConfig?.maxOutputTokens ?? opts.maxOutputTokens,
        opts.maxOutputTokens
      ),
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    opts.timeoutMs
  );

  const raw = await r.text();
  if (!r.ok) throw classify(r.status, raw);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ProviderError("server", 502, "Invalid JSON from provider.");
  }

  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .filter((p) => !p.thought)
    .map((p) => p.text || "")
    .join("");

  if (!text) {
    throw new ProviderError("server", 502, "Empty response from Gemini.");
  }

  return {
    text,
    inputTokens: data.usageMetadata?.promptTokenCount || 0,
    outputTokens:
      (data.usageMetadata?.candidatesTokenCount || 0) +
      (data.usageMetadata?.thoughtsTokenCount || 0),
    finishReason: candidate?.finishReason || "STOP",
  };
}

export async function callOpenAI(key, model, req, opts = { timeoutMs: 90000, maxOutputTokens: 16384, baseUrl: "https://api.openai.com/v1" }) {
  const system = textOf(req.systemInstruction?.parts);
  const isJson = req.generationConfig?.responseMimeType === "application/json";

  const messages = [
    ...(system || isJson
      ? [
          {
            role: "system",
            content: `${system}${
              isJson
                ? "\nRespond with a single valid JSON object only, shaped like {\"questions\": [...]}, no markdown code fences."
                : ""
            }`.trim(),
          },
        ]
      : []),
    ...(req.contents || []).map((c) => ({
      role: c.role === "model" ? "assistant" : "user",
      content: textOf(c.parts),
    })),
  ];

  const payload = {
    model,
    messages,
    max_tokens: Math.min(
      req.generationConfig?.maxOutputTokens ?? opts.maxOutputTokens,
      opts.maxOutputTokens
    ),
    ...(isJson ? { response_format: { type: "json_object" } } : {}),
  };

  const r = await fetchWithTimeout(
    `${opts.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    },
    opts.timeoutMs
  );

  const raw = await r.text();
  if (!r.ok) throw classify(r.status, raw);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ProviderError("server", 502, "Invalid JSON from OpenAI.");
  }

  const choice = data.choices?.[0];
  const text = choice?.message?.content || "";
  if (!text) {
    throw new ProviderError("server", 502, "Empty response from OpenAI.");
  }

  return {
    text,
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    finishReason: choice?.finish_reason === "length" ? "MAX_TOKENS" : "STOP",
  };
}

export async function testKey(provider, key) {
  const url =
    provider === "gemini"
      ? `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`
      : "https://api.openai.com/v1/models";

  const headers = provider === "openai" ? { authorization: `Bearer ${key}` } : {};

  const r = await fetchWithTimeout(url, { headers }, 15000);
  if (!r.ok) {
    const raw = await r.text().catch(() => "");
    throw classify(r.status, raw);
  }
  return true;
}
