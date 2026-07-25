// openai-compat-adapter.mjs — a RuntimeAdapter over any OpenAI-compatible
// /chat/completions endpoint (RUNTIME-ACCOUNTS-V4).
//
// Every other runtime in Garrison wraps a CLI; OpenRouter and Hugging Face are
// plain HTTP, so "spawn" here is just a session object and the work happens in
// awaitResponse. The adapter contract is unchanged, which is the point: the
// generic runtime-bridge (validation, single retry, empty-output guard,
// artifact write, decision log) drives it exactly like the CLI adapters.

const DEFAULT_TIMEOUT_MS = 180_000;

export class OpenAICompatAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.id           runtime id ("openrouter" / "huggingface")
   * @param {string} opts.baseUrl      e.g. https://openrouter.ai/api/v1
   * @param {string} opts.keyEnv       env var holding the bearer token
   * @param {string} [opts.label]      provider name for error messages
   * @param {Record<string,string>} [opts.headers] extra provider headers
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor(opts = {}) {
    this.id = opts.id ?? "openai-compat";
    this.label = opts.label ?? this.id;
    this.baseUrl = (opts.baseUrl ?? "").replace(/\/$/, "");
    this.keyEnv = opts.keyEnv ?? "OPENAI_API_KEY";
    this.extraHeaders = opts.headers ?? {};
    this._fetch = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async spawn(config = {}) {
    const env = config.env ?? process.env;
    const key = env[this.keyEnv];
    if (!key) {
      // Fail loudly and name the exact env var: a delegation that silently ran
      // unauthenticated would surface as a confusing 401 deep in the response.
      throw new Error(
        `${this.label} needs ${this.keyEnv} in the environment - pin an account to this runtime on the Accounts page`
      );
    }
    return { key, model: config.model, prompt: null, env };
  }

  async awaitReady() {
    // HTTP has no readiness handshake; the request itself is the check.
  }

  async sendTurn(session, prompt) {
    session.prompt = prompt;
  }

  async awaitResponse(session) {
    if (!session.prompt) throw new Error("no prompt was sent");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this._fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.key}`,
          ...this.extraHeaders
        },
        body: JSON.stringify({
          model: session.model,
          messages: [{ role: "user", content: session.prompt }]
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`${this.label} answered ${response.status}: ${raw.slice(0, 300)}`);
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(`${this.label} returned non-JSON: ${raw.slice(0, 200)}`);
    }
    // Some providers report a failure INSIDE a 200 body.
    if (body?.error) {
      throw new Error(`${this.label} error: ${body.error.message ?? JSON.stringify(body.error).slice(0, 200)}`);
    }
    const text = body?.choices?.[0]?.message?.content ?? "";
    const usedTokens = body?.usage?.total_tokens;
    return {
      text: typeof text === "string" ? text : JSON.stringify(text),
      ...(typeof usedTokens === "number" ? { usedTokens } : {})
    };
  }

  async teardown() {
    // Nothing to tear down - the request is the session.
  }
}
