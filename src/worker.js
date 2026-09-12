const EXA_ENDPOINT = "https://demos.exa.ai/chatbot-demo/api/chat/stream";
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const DOC_MAX_CHARS = 60000;
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_DEFAULT_MODEL = "gpt-5.6-luna";
const AUTH_TOKEN_TTL_SECONDS = 50 * 60;
const LOCAL_OAUTH_CALLBACK = "http://localhost:1455/auth/callback";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function base64Url(bytes) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value).length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? textEncoder.encode(value) : value));
}

async function authKey(env) {
  const secret = String(env?.WEBIOME_AUTH_SECRET || "").trim();
  if (!secret) throw new Error("WEBIOME_AUTH_SECRET is not configured");
  const keyBytes = await sha256(secret);
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(payload, env, ttlSeconds = AUTH_TOKEN_TTL_SECONDS) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await authKey(env), textEncoder.encode(JSON.stringify(body)));
  return `${base64Url(iv)}.${base64Url(cipher)}`;
}

async function unseal(token, env) {
  const [ivPart, cipherPart] = String(token || "").split(".");
  if (!ivPart || !cipherPart) throw new Error("Invalid sealed token");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(ivPart) }, await authKey(env), fromBase64Url(cipherPart));
  const payload = JSON.parse(textDecoder.decode(plain));
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) throw new Error("Sealed token expired");
  return payload;
}

function randomToken(bytes = 32) {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function codeChallenge(verifier) {
  return base64Url(await sha256(verifier));
}

function jsonResponse(value, init = {}) {
  return Response.json(value, { ...init, headers: { ...cors(), ...(init.headers || {}) } });
}

class ExaStreamReader {
  constructor(response) {
    this.reader = response.body.getReader();
    this.decoder = new TextDecoder();
    this.pending = "";
    this.text = "";
  }

  async readText() {
    while (true) {
      const { done, value } = await this.reader.read();
      this.pending += this.decoder.decode(value, { stream: !done });
      const lines = this.pending.split("\n");
      this.pending = done ? "" : lines.pop() || "";
      for (const line of lines) {
        if (this.consume(line)) {
          await this.reader.cancel();
          return this.text;
        }
      }
      if (done) break;
    }
    if (this.pending) this.consume(this.pending);
    return this.text.trim();
  }

  consume(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return false;
    try {
      const event = JSON.parse(payload);
      if (typeof event.content !== "string") return false;
      this.text += event.content;
      const marker = this.text.search(/```followups\b/i);
      if (marker >= 0) {
        this.text = this.text.slice(0, marker).trimEnd();
        return true;
      }
    } catch {}
    return false;
  }
}

class WebiomePlanner {
  constructor(request, provider = new ExaProvider()) {
    this.request = request;
    this.model = request.model || {};
    this.context = request.context || {};
    this.tools = Array.isArray(this.context.tools) ? this.context.tools : [];
    this.provider = provider;
  }

  buildPrompt(feedback) {
    return [
      this.context.systemPrompt && `SYSTEM:\n${this.context.systemPrompt}`,
      this.renderMessages(),
      this.renderTools(),
      feedback,
      this.instructions(),
    ].filter(Boolean).join("\n\n");
  }

  renderMessages() {
    const messages = Array.isArray(this.context.messages) ? this.context.messages : [];
    return messages.map((message) => {
      const content = this.renderContent(message.content);
      return `${String(message.role || "user").toUpperCase()}:\n${content}`;
    }).join("\n\n");
  }

  renderContent(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return JSON.stringify(content ?? "");
    return content.map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return `[thinking]\n${part.thinking}`;
      if (part.type === "toolCall") return `[tool call ${part.name}: ${JSON.stringify(part.arguments || {})}]`;
      if (part.type === "image") return `[image ${part.mimeType}]`;
      return JSON.stringify(part);
    }).join("\n");
  }

  renderTools() {
    if (!this.tools.length) return "TOOLS:\nNo tools are available.";
    return `TOOLS:\n${JSON.stringify(this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })), null, 2)}`;
  }

  instructions() {
    return [
      "Return exactly one JSON object and no markdown.",
      "The JSON shape is {\"actions\":[...]} with at least one action.",
      "For a final answer use exactly one action: {\"type\":\"text\",\"text\":\"...\"}.",
      "For tool use, use one or more actions: {\"tool\":\"tool_name\",\"arguments\":{...}}.",
      "When using tools, do not include text actions in the same response; the app will continue after tools run.",
      "Tool names and arguments must match the available tools and their JSON schema.",
      "Do not invent tool names. Do not include followups.",
    ].join("\n");
  }

  async run(signal) {
    let feedback = "";
    let raw = "";
    let parsed;
    for (let attempt = 0; attempt < 3; attempt++) {
      raw = await this.ask(this.buildPrompt(feedback), signal);
      parsed = this.parse(raw);
      if (parsed.ok) return parsed.value;
      feedback = [
        "Your previous output was rejected by the Webiome Pi adapter.",
        `Rejected output:\n${raw}`,
        `Adapter error:\n${parsed.error}`,
        "Return one valid JSON object only.",
        "If a tool is needed, return only tool actions and no text action.",
        "If no tool is needed, return one text action and no tool actions.",
      ].join("\n\n");
    }
    throw new Error(parsed?.error || "Model output could not be adapted");
  }

  async ask(prompt, signal) {
    return await this.provider.complete(prompt, this.model, signal);
  }

  parse(raw) {
    const text = this.clean(raw);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return { ok: false, error: "No JSON object found" };
      try {
        value = JSON.parse(match[0]);
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
    return this.validate(value);
  }
  clean(raw) {
    return String(raw || "")
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .replace(/```followups[\s\S]*$/i, "")
      .trim();
  }

  validate(value) {
    if (!value || !Array.isArray(value.actions) || !value.actions.length)
      return { ok: false, error: "Expected a non-empty actions array" };
    try {
      const normalized = this.normalizeActions(value.actions);
      const actions = normalized.map((action) => {
        if (!action || typeof action !== "object" || Array.isArray(action))
          throw new Error("Each action must be an object");
        if (action.type === "text") {
          if (typeof action.text !== "string" || !action.text.trim()) throw new Error("Text action needs text");
          return { type: "text", text: action.text };
        }
        if (typeof action.tool !== "string") throw new Error("Tool action needs a tool name");
        const tool = this.tools.find((candidate) => candidate.name === action.tool);
        if (!tool) throw new Error(`Unavailable tool: ${action.tool}`);
        if (!this.isPlainObject(action.arguments)) throw new Error(`Invalid arguments for ${action.tool}`);
        return { tool: action.tool, arguments: this.withoutNulls(action.arguments) };
      });
      return { ok: true, value: { actions } };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  normalizeActions(actions) {
    const toolActions = actions.filter((action) => action && typeof action === "object" && !Array.isArray(action) && typeof action.tool === "string");
    if (toolActions.length) return toolActions;
    const textActions = actions.filter((action) => action && typeof action === "object" && !Array.isArray(action) && action.type === "text");
    if (textActions.length > 1) {
      return [{
        type: "text",
        text: textActions.map((action) => String(action.text || "").trim()).filter(Boolean).join("\n\n"),
      }];
    }
    return actions;
  }

  isPlainObject(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  withoutNulls(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item != null));
  }
}

class ExaProvider {
  async complete(prompt, model, signal) {
    const response = await fetch(EXA_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        message: prompt,
        history: [],
        exaEnabled: false,
        model: model.id || DEFAULT_MODEL,
        searchType: "instant",
      }),
    });
    if (!response.ok) throw new Error(`Exa upstream ${response.status}: ${(await response.text()).slice(0, 500)}`);
    if (!response.body) throw new Error("Exa returned no response stream");
    const text = await new ExaStreamReader(response).readText();
    if (!text) throw new Error("Exa returned no assistant content");
    return text;
  }
}

class CodexOAuthProvider {
  constructor(auth) {
    this.auth = auth;
  }

  async run(request, writer, signal) {
    writer.start();
    const response = await this.responses(request, signal);
    if (response.toolCalls.length) writer.tools(response.toolCalls);
    else writer.text(response.text || "");
  }

  async responses(request, signal) {
    const payload = this.payload(request);
    const response = await this.fetchChatGptCodex(payload, signal);
    if (response.ok) return await this.readResponse(response, "Codex");
    const body = await response.text();
    this.throwUpstream("Codex", response.status, body);
  }

  async fetchChatGptCodex(payload, signal) {
    return await fetch(CODEX_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.auth.accessToken}`,
        "Accept": "text/event-stream",
        "Content-Type": "application/json",
        "OpenAI-Beta": "responses_websockets=2026-02-06",
        ...(this.auth.accountId ? { "ChatGPT-Account-Id": this.auth.accountId } : {}),
        "originator": "Codex CLI",
        "x-openai-internal-codex-residency": "us",
        "x-client-request-id": `req_${crypto.randomUUID().replace(/-/g, "")}`,
        "x-codex-turn-state": "active",
      },
      signal,
      body: JSON.stringify(payload),
    });
  }

  async readResponse(response, label) {
    if (response.status === 401) throw new Error(`${label} OAuth token expired or was rejected; please sign in again`);
    if (!response.body) throw new Error("Codex returned no response stream");
    return await new CodexResponsesReader(response).read();
  }

  payload(request) {
    const context = request.context || {};
    return {
      model: this.modelId(request.model || {}),
      instructions: context.systemPrompt || "You are Webiome, a browser-local agent.",
      input: this.input(context.messages || []),
      store: false,
      stream: true,
      tool_choice: "auto",
      tools: this.tools(context.tools || []),
      text: { format: { type: "text" } },
    };
  }

  input(messages) {
    const normalized = messages.map((message) => this.inputMessage(message)).filter(Boolean);
    return normalized.length ? normalized : [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Continue." }],
    }];
  }

  inputMessage(message) {
    const role = String(message.role || "user").toLowerCase();
    if (role === "tool" || role === "toolresult" || role === "tool_result") {
      return {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Tool result:\n${this.contentText(message.content)}` }],
      };
    }
    return {
      type: "message",
      role: role === "assistant" ? "assistant" : "user",
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text: this.contentText(message.content) }],
    };
  }

  contentText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return JSON.stringify(content ?? "");
    return content.map((part) => {
      if (part.type === "text") return part.text || "";
      if (part.type === "toolCall") return `[tool call ${part.name}: ${JSON.stringify(part.arguments || {})}]`;
      if (part.type === "image") return `[image ${part.mimeType || ""}]`;
      return JSON.stringify(part);
    }).filter(Boolean).join("\n");
  }

  tools(tools) {
    return tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} },
      strict: false,
    }));
  }

  modelId(model) {
    const requested = String(model?.id || "").trim();
    if (!requested || requested === DEFAULT_MODEL || requested.includes("gemini")) return CODEX_DEFAULT_MODEL;
    return requested.replace(/^openai-codex\//, "").replace(/^codex\//, "");
  }

  throwUpstream(label, status, text) {
    if (status === 401) throw new Error(`${label} OAuth token expired or was rejected; please sign in again`);
    throw new Error(`${label} upstream ${status}: ${this.errorText(text)}`);
  }

  errorText(text) {
    const cleaned = String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return cleaned.slice(0, 500) || "empty error body";
  }
}

class CodexResponsesReader {
  constructor(response) {
    this.reader = response.body.getReader();
    this.decoder = new TextDecoder();
    this.pending = "";
    this.text = "";
    this.toolCalls = [];
  }

  async read() {
    while (true) {
      const { done, value } = await this.reader.read();
      this.pending += this.decoder.decode(value, { stream: !done });
      const events = this.pending.split("\n\n");
      this.pending = done ? "" : events.pop() || "";
      for (const event of events) this.consume(event);
      if (done) break;
    }
    if (this.pending) this.consume(this.pending);
    return { text: this.text.trim(), toolCalls: this.toolCalls };
  }

  consume(event) {
    const lines = event.split("\n");
    const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const dataLine = lines.find((line) => line.startsWith("data:"));
    if (!dataLine) return;
    const payload = dataLine.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const data = JSON.parse(payload);
      if (typeof data.delta === "string") this.text += data.delta;
      else if (data.type === "response.output_text.delta" && typeof data.delta === "string") this.text += data.delta;
      else if (typeof data.text === "string" && /output_text/.test(type || "")) this.text += data.text;
      else if (data.type === "response.completed") this.collectCompleted(data.response);
    } catch {}
  }

  collectCompleted(response) {
    for (const item of response?.output || []) {
      if (item.type === "function_call") {
        this.toolCalls.push({
          tool: item.name,
          arguments: this.parseArguments(item.arguments),
          id: item.call_id || item.id,
        });
        continue;
      }
      for (const part of item.content || []) {
        if (typeof part.text === "string" && !this.text.includes(part.text)) this.text += part.text;
      }
    }
  }

  parseArguments(value) {
    if (!value) return {};
    if (typeof value === "object") return value;
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
}

class PiEventWriter {
  constructor(controller, model) {
    this.controller = controller;
    this.encoder = new TextEncoder();
    this.output = {
      role: "assistant",
      content: [],
      api: model.api || "webiome-exa",
      provider: model.provider || "webiome",
      model: model.id || DEFAULT_MODEL,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  send(event) {
    this.controller.enqueue(this.encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  }

  start() {
    this.send({ type: "start", partial: this.output });
  }

  text(text) {
    const block = { type: "text", text: "" };
    this.output.content.push(block);
    const contentIndex = this.output.content.indexOf(block);
    this.send({ type: "text_start", contentIndex, partial: this.output });
    block.text = text;
    this.send({ type: "text_delta", contentIndex, delta: text, partial: this.output });
    this.send({ type: "text_end", contentIndex, content: block.text, partial: this.output });
    this.output.stopReason = "stop";
    this.send({ type: "done", reason: "stop", message: this.output });
  }

  tools(actions) {
    for (const action of actions) {
      const toolCall = {
        type: "toolCall",
        id: `webiome-${crypto.randomUUID()}`,
        name: action.tool,
        arguments: {},
      };
      this.output.content.push(toolCall);
      const contentIndex = this.output.content.indexOf(toolCall);
      this.send({ type: "toolcall_start", contentIndex, partial: this.output });
      toolCall.arguments = action.arguments;
      this.send({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(action.arguments), partial: this.output });
      this.send({ type: "toolcall_end", contentIndex, toolCall, partial: this.output });
    }
    this.output.stopReason = "toolUse";
    this.send({ type: "done", reason: "toolUse", message: this.output });
  }

  error(error, aborted) {
    this.output.stopReason = aborted ? "aborted" : "error";
    this.output.errorMessage = error instanceof Error ? error.message : String(error);
    this.send({ type: "error", reason: this.output.stopReason, error: this.output });
  }
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function allowedReturnTo(value) {
  let url;
  try {
    url = new URL(value || "https://theabbie.github.io/webiome/");
  } catch {
    url = new URL("https://theabbie.github.io/webiome/");
  }
  const host = url.hostname.toLowerCase();
  const ok =
    host === "theabbie.github.io" ||
    host === "localhost" ||
    host === "127.0.0.1";
  return ok ? url.toString() : "https://theabbie.github.io/webiome/";
}

async function authStart(request, env) {
  const url = new URL(request.url);
  const verifier = randomToken(48);
  const state = await seal({
    kind: "oauth_state",
    verifier,
    redirectUri: LOCAL_OAUTH_CALLBACK,
    returnTo: allowedReturnTo(url.searchParams.get("return_to")),
  }, env, 10 * 60);
  const auth = new URL(`${CODEX_ISSUER}/oauth/authorize`);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", CODEX_CLIENT_ID);
  auth.searchParams.set("redirect_uri", LOCAL_OAUTH_CALLBACK);
  auth.searchParams.set("scope", "openid profile email");
  auth.searchParams.set("code_challenge", await codeChallenge(verifier));
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("id_token_add_organizations", "true");
  auth.searchParams.set("state", state);
  return Response.redirect(auth.toString(), 302);
}

async function authCallback(request, env) {
  const url = new URL(request.url);
  const result = await completeOAuth(url, env);
  return authCallbackHtml(result.returnTo, result.token, result.error);
}

async function authComplete(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {}
  const pasted = String(body.url || "").trim();
  if (!pasted) return jsonResponse({ ok: false, error: "Missing callback URL" }, { status: 400 });
  let url;
  try {
    url = new URL(pasted);
  } catch {
    return jsonResponse({ ok: false, error: "Invalid callback URL" }, { status: 400 });
  }
  const result = await completeOAuth(url, env);
  if (result.error) return jsonResponse({ ok: false, error: result.error }, { status: 400 });
  return jsonResponse({ ok: true, token: result.token });
}

async function completeOAuth(url, env) {
  if (url.searchParams.get("error")) {
    return { error: `OAuth error: ${url.searchParams.get("error_description") || url.searchParams.get("error")}` };
  }
  if (`${url.origin}${url.pathname}` !== LOCAL_OAUTH_CALLBACK)
    return { error: "Callback URL must be the localhost OpenAI OAuth callback" };
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  if (!code || !stateToken) return { error: "Missing OAuth code or state" };
  let state;
  try {
    state = await unseal(stateToken, env);
  } catch (error) {
    return { error: `Invalid OAuth state: ${error.message}` };
  }
  if (state.kind !== "oauth_state" || !state.verifier || state.redirectUri !== LOCAL_OAUTH_CALLBACK)
    return { error: "Invalid OAuth state payload" };
  try {
    const tokenResponse = await fetch(`${CODEX_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: LOCAL_OAUTH_CALLBACK,
        client_id: CODEX_CLIENT_ID,
        code_verifier: state.verifier,
      }),
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok) throw new Error(JSON.stringify(tokenData).slice(0, 500));
    if (!tokenData.access_token) throw new Error("OAuth token response did not include access_token");
    const claims = {
      ...(jwtPayload(tokenData.access_token) || {}),
      ...(jwtPayload(tokenData.id_token) || {}),
    };
    const account = await accountInfo(tokenData.access_token).catch(() => ({}));
    const upstreamExp = Number(jwtPayload(tokenData.access_token)?.exp || 0);
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(60, Math.min(AUTH_TOKEN_TTL_SECONDS, upstreamExp ? upstreamExp - now - 30 : AUTH_TOKEN_TTL_SECONDS));
    const sealed = await seal({
      kind: "codex_access",
      accessToken: tokenData.access_token,
      accountId: accountIdFrom(claims, tokenData, account),
      email: claims.email || account.email || "",
      name: claims.name || account.name || "",
      provider: "codex-oauth",
    }, env, ttl);
    return { returnTo: state.returnTo, token: sealed };
  } catch (error) {
    return { error: `Token exchange failed: ${error.message}` };
  }
}

function accountIdFrom(claims, tokenData, account) {
  const nested = claims["https://api.openai.com/auth"] || {};
  return (
    claims.chatgpt_account_id ||
    claims.account_id ||
    nested.chatgpt_account_id ||
    nested.account_id ||
    tokenData.account_id ||
    tokenData.chatgpt_account_id ||
    account.account_id ||
    account.accountId ||
    account?.account?.id ||
    account?.session?.account?.id ||
    ""
  );
}

async function accountInfo(accessToken) {
  const response = await fetch("https://chatgpt.com/backend-api/me", {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
      "originator": "Codex CLI",
    },
  });
  if (!response.ok) throw new Error(`Account lookup ${response.status}`);
  return await response.json();
}

function jwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(textDecoder.decode(fromBase64Url(part)));
  } catch {
    return null;
  }
}

function authCallbackHtml(returnTo, token, error) {
  const safeReturn = JSON.stringify(returnTo || "https://theabbie.github.io/webiome/");
  const safeToken = JSON.stringify(token || "");
  const safeError = JSON.stringify(error || "");
  return new Response(`<!doctype html>
<meta charset="utf-8">
<title>Webiome sign-in</title>
<body style="font-family:system-ui;background:#111;color:#eee">
<script>
const returnTo = ${safeReturn};
const token = ${safeToken};
const error = ${safeError};
if (token) location.replace(returnTo.split("#")[0] + "#webiome_token=" + encodeURIComponent(token));
else document.body.textContent = error || "Sign-in did not complete.";
</script>
</body>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...cors() },
  });
}

async function authStatus(request, env) {
  try {
    const auth = await authFromRequest(request, env);
    if (!auth) return jsonResponse({ ok: false, authenticated: false });
    return jsonResponse({
      ok: true,
      authenticated: true,
      provider: "codex-oauth",
      exp: auth.exp,
      hasAccountId: Boolean(auth.accountId),
      email: auth.email || "",
      name: auth.name || "",
    });
  } catch (error) {
    return jsonResponse({ ok: false, authenticated: false, error: error.message }, { status: 401 });
  }
}

async function authFromRequest(request, env) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const payload = await unseal(match[1], env);
  if (payload.kind !== "codex_access" || !payload.accessToken) throw new Error("Invalid Webiome auth token");
  return payload;
}

function textFromHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isBlockedDocHost(hostname) {
  const name = hostname.toLowerCase();
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "0.0.0.0" ||
    name === "::1" ||
    /^127\./.test(name) ||
    /^10\./.test(name) ||
    /^192\.168\./.test(name) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(name)
  );
}

function jinaReaderUrl(url) {
  return `https://r.jina.ai/http://${url.host}${url.pathname}${url.search}`;
}

function jinaReaderHeaders(env) {
  const headers = { Accept: "text/plain" };
  const token = String(env?.JINA_API_KEY || env?.JINA_READER_TOKEN || env?.JINA_TOKEN || "").trim();
  if (token) headers.Authorization = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  return headers;
}

async function fetchJinaDoc(parsed, env) {
  const response = await fetch(jinaReaderUrl(parsed), {
    headers: jinaReaderHeaders(env),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Jina Reader ${response.status}: ${text.slice(0, 300)}`);
  return {
    source: "jina",
    contentType: response.headers.get("content-type") || "text/plain",
    text: text.trim(),
    status: response.status,
    ok: response.ok,
  };
}

async function fetchDirectDoc(parsed) {
  const response = await fetch(parsed.toString(), {
    headers: {
      "User-Agent": "webiome-doc-fetcher",
      "Accept": "text/html,text/plain,application/json,application/javascript,text/*,*/*;q=0.5",
    },
  });
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();
  return {
    source: "direct",
    contentType,
    text: /html/i.test(contentType) ? textFromHtml(raw) : raw.trim(),
    status: response.status,
    ok: response.ok,
  };
}

async function doc(request, env) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) return Response.json({ error: "Missing url" }, { status: 400, headers: cors() });
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return Response.json({ error: "Invalid url" }, { status: 400, headers: cors() });
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    return Response.json({ error: "Only http(s) docs are supported" }, { status: 400, headers: cors() });
  if (isBlockedDocHost(parsed.hostname))
    return Response.json({ error: "Blocked docs host" }, { status: 400, headers: cors() });
  let result;
  let fallbackReason = "";
  try {
    result = await fetchJinaDoc(parsed, env);
  } catch (error) {
    fallbackReason = error instanceof Error ? error.message : String(error);
    result = await fetchDirectDoc(parsed);
  }
  return Response.json({
    url: parsed.toString(),
    source: result.source,
    fallbackReason,
    status: result.status,
    ok: result.ok,
    contentType: result.contentType,
    chars: result.text.length,
    text: result.text.slice(0, DOC_MAX_CHARS),
    truncated: result.text.length > DOC_MAX_CHARS,
  }, { headers: cors() });
}

async function stream(request, env) {
  const body = await request.json();
  const signal = request.signal;
  const auth = await authFromRequest(request, env).catch((error) => ({ error }));
  return new Response(new ReadableStream({
    async start(controller) {
      const writer = new PiEventWriter(controller, body.model || {});
      try {
        if (auth?.error) throw auth.error;
        if (auth) {
          await new CodexOAuthProvider(auth).run(body, writer, signal);
        } else {
          writer.start();
          const plan = await new WebiomePlanner(body, new ExaProvider()).run(signal);
          const textAction = plan.actions.find((action) => action.type === "text");
          if (textAction) writer.text(textAction.text);
          else writer.tools(plan.actions);
        }
      } catch (error) {
        writer.error(error, signal.aborted);
      } finally {
        controller.close();
      }
    },
  }), {
    headers: {
      ...cors(),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    if (url.pathname === "/api/stream" && request.method === "POST") return stream(request, env);
    if (url.pathname === "/api/auth/start" && request.method === "GET") return authStart(request, env);
    if (url.pathname === "/api/auth/callback" && request.method === "GET") return authCallback(request, env);
    if (url.pathname === "/api/auth/complete" && request.method === "POST") return authComplete(request, env);
    if (url.pathname === "/api/auth/status" && request.method === "GET") return authStatus(request, env);
    if (url.pathname === "/api/doc" && request.method === "GET") return doc(request, env);
    return new Response("Not found", { status: 404 });
  },
};
