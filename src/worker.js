const MAX_BODY_BYTES = 32 * 1024;
const MAX_ADMIN_ROWS = 1_000;
const MAX_EXPORT_ROWS = 5_000;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const VISITOR_COOKIE_TTL_SECONDS = 400 * 24 * 60 * 60;
const VISITOR_COOKIE_NAME = "drivu_visitor";
const OWNER_COOKIE_NAME = "drivu_owner_session";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; " +
    "form-action 'self'",
};

class APIError extends Error {
  constructor(status, message, code = "request_error", extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function applySecurityHeaders(headers) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return headers;
}

function jsonResponse(status, payload, extraHeaders = undefined) {
  const body = JSON.stringify(payload);
  const headers = new Headers(extraHeaders || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Content-Length", String(textEncoder.encode(body).byteLength));
  headers.set("Cache-Control", "no-store");
  applySecurityHeaders(headers);
  return new Response(body, { status, headers });
}

function errorResponse(error) {
  const payload = {
    error: {
      code: error.code || "request_error",
      message: error.message || "The server could not complete that request.",
    },
    ...(error.extra || {}),
  };
  return jsonResponse(error.status || 500, payload);
}

function primaryDatabase(env) {
  if (!env.DB) {
    throw new APIError(503, "The result database is not configured.", "service_unavailable");
  }
  return typeof env.DB.withSession === "function"
    ? env.DB.withSession("first-primary")
    : env.DB;
}

function secretsConfigured(env) {
  return (
    typeof env.OWNER_PIN_SHA256 === "string" &&
    SHA256_PATTERN.test(env.OWNER_PIN_SHA256) &&
    typeof env.RATE_LIMIT_SECRET === "string" &&
    env.RATE_LIMIT_SECRET.length >= 32
  );
}

function requireSecrets(env) {
  if (!secretsConfigured(env)) {
    throw new APIError(
      503,
      "Owner access is not configured yet.",
      "service_unavailable",
    );
  }
}

function parseCookies(request) {
  const cookies = new Map();
  const raw = request.headers.get("Cookie") || "";
  for (const item of raw.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

function cookieValue(request, name) {
  const value = parseCookies(request).get(name);
  return value && TOKEN_PATTERN.test(value) ? value : null;
}

function cookieHeader(name, value, maxAge, request) {
  const url = new URL(request.url);
  const localHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  const secure = localHttp ? "" : "; Secure";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function clearCookieHeader(name, request) {
  return cookieHeader(name, "", 0, request);
}

function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomIndex(length) {
  const range = 0x1_0000_0000;
  const ceiling = range - (range % length);
  const random = new Uint32Array(1);
  do {
    crypto.getRandomValues(random);
  } while (random[0] >= ceiling);
  return random[0] % length;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

let cachedHmacSecret = null;
let cachedHmacKeyPromise = null;

function hmacKey(secret) {
  if (cachedHmacSecret !== secret || !cachedHmacKeyPromise) {
    cachedHmacSecret = secret;
    cachedHmacKeyPromise = crypto.subtle.importKey(
      "raw",
      textEncoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return cachedHmacKeyPromise;
}

async function hmacHex(secret, value) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    textEncoder.encode(value),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(left, right) {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

function clientAddress(request) {
  return request.headers.get("CF-Connecting-IP") || "local-client";
}

async function rateAllowed(env, request, scope, limit, windowSeconds, key = null) {
  requireSecrets(env);
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - windowSeconds;
  const identity = key || clientAddress(request);
  const keyHash = await hmacHex(env.RATE_LIMIT_SECRET, `${scope}\0${identity}`);
  const row = await primaryDatabase(env)
    .prepare(
      `
        INSERT INTO rate_limits (scope, key_hash, window_start, attempts)
        VALUES (?1, ?2, ?3, 1)
        ON CONFLICT(scope, key_hash) DO UPDATE SET
          window_start = CASE
            WHEN rate_limits.window_start <= ?4 THEN excluded.window_start
            ELSE rate_limits.window_start
          END,
          attempts = CASE
            WHEN rate_limits.window_start <= ?4 THEN 1
            ELSE rate_limits.attempts + 1
          END
        RETURNING attempts
      `,
    )
    .bind(scope, keyHash, now, cutoff)
    .first();
  return Number(row?.attempts || 0) <= limit;
}

function requireSameOrigin(request) {
  const fetchSite = request.headers.get("Sec-Fetch-Site") || "";
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    throw new APIError(403, "Cross-origin requests are not allowed.", "cross_origin");
  }

  const origin = request.headers.get("Origin");
  if (!origin) return;
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) {
      throw new Error("origin mismatch");
    }
  } catch {
    throw new APIError(403, "Cross-origin requests are not allowed.", "cross_origin");
  }
}

async function readJson(request) {
  const contentType = (request.headers.get("Content-Type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new APIError(415, "Send this request as application/json.");
  }

  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength <= 0) {
      throw new APIError(400, "A JSON request body is required.");
    }
    if (parsedLength > MAX_BODY_BYTES) {
      throw new APIError(413, "The request is too large.");
    }
  }

  if (!request.body) throw new APIError(400, "A JSON request body is required.");

  const reader = request.body.getReader();
  const chunks = [];
  let bodyLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bodyLength += value.byteLength;
    if (bodyLength > MAX_BODY_BYTES) {
      try {
        await reader.cancel("request body limit exceeded");
      } catch {
        // The 413 response still takes precedence if the client already disconnected.
      }
      throw new APIError(413, "The request is too large.");
    }
    chunks.push(value);
  }
  if (bodyLength <= 0) throw new APIError(400, "A JSON request body is required.");

  const bytes = new Uint8Array(bodyLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let body;
  try {
    body = textDecoder.decode(bytes);
  } catch {
    throw new APIError(400, "The JSON request body must be valid UTF-8.");
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new APIError(400, "The JSON request body is invalid.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new APIError(400, "The JSON request body must be an object.");
  }
  return payload;
}

function collapseWhitespace(value) {
  return value.trim().split(/\s+/u).filter(Boolean).join(" ");
}

function normalizeChoices(rawChoices) {
  if (!Array.isArray(rawChoices) || rawChoices.length < 2 || rawChoices.length > 16) {
    throw new APIError(400, "Provide between 2 and 16 choices.");
  }

  const choices = [];
  const ids = new Set();
  for (let index = 0; index < rawChoices.length; index += 1) {
    const rawChoice = rawChoices[index];
    if (!rawChoice || typeof rawChoice !== "object" || Array.isArray(rawChoice)) {
      throw new APIError(400, `Choice ${index + 1} is invalid.`);
    }
    const rawId = rawChoice.id;
    const rawLabel = rawChoice.label === null ? "" : rawChoice.label ?? "";
    if (typeof rawId !== "string" || typeof rawLabel !== "string") {
      throw new APIError(400, `Choice ${index + 1} is invalid.`);
    }
    if (rawId.length > 128 || rawLabel.length > 60) {
      throw new APIError(400, `Choice ${index + 1} is too long.`);
    }
    const id = rawId.trim();
    if (!id || /[\u0000-\u001f\u007f]/u.test(id)) {
      throw new APIError(400, `Choice ${index + 1} must have a valid id.`);
    }
    if (ids.has(id)) throw new APIError(400, "Choice ids must be unique.");
    ids.add(id);
    choices.push({ id, label: collapseWhitespace(rawLabel) || `Prize ${index + 1}` });
  }
  return choices;
}

function normalizeParticipant(rawParticipant) {
  const value = rawParticipant === null || rawParticipant === undefined ? "" : rawParticipant;
  if (typeof value !== "string" || value.length > 120) {
    throw new APIError(400, "Participant name must be 120 characters or fewer.");
  }
  return collapseWhitespace(value);
}

function rowToSpin(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    participant: row.participant || "",
    winnerIndex: Number(row.winner_index),
    result: { id: row.result_id, label: row.result_label },
    choiceCount: Number(row.choice_count),
    choices: JSON.parse(row.choices_json),
  };
}

async function handleHealth(env) {
  if (!env.DB || !secretsConfigured(env)) {
    throw new APIError(503, "The service is not fully configured.", "service_unavailable");
  }
  const state = await primaryDatabase(env)
    .prepare(
      `
        SELECT c.generation
        FROM campaign_state AS c
        LEFT JOIN spins AS s ON 0
        LEFT JOIN admin_sessions AS a ON 0
        LEFT JOIN rate_limits AS r ON 0
        WHERE c.singleton = 1
        LIMIT 1
      `,
    )
    .first();
  if (!state || Number(state.generation) < 1) {
    throw new APIError(503, "The campaign has not been initialized.", "service_unavailable");
  }
  return jsonResponse(200, { ok: true });
}

async function handleEligibility(request, env) {
  if (!(await rateAllowed(env, request, "eligibility", 1_200, 60))) {
    throw new APIError(
      429,
      "Too many requests. Please wait a moment.",
      "rate_limited",
    );
  }

  let token = cookieValue(request, VISITOR_COOKIE_NAME);
  const headers = new Headers();
  if (!token) {
    token = randomToken();
    headers.set(
      "Set-Cookie",
      cookieHeader(VISITOR_COOKIE_NAME, token, VISITOR_COOKIE_TTL_SECONDS, request),
    );
  }
  const tokenHash = await sha256Hex(token);
  const row = await primaryDatabase(env)
    .prepare(
      `
        SELECT c.generation, s.*
        FROM campaign_state AS c
        LEFT JOIN spins AS s
          ON s.campaign_generation = c.generation
         AND s.attempt_token_hash = ?1
        WHERE c.singleton = 1
        LIMIT 1
      `,
    )
    .bind(tokenHash)
    .first();
  if (!row) {
    throw new APIError(503, "The campaign has not been initialized.", "service_unavailable");
  }
  return jsonResponse(
    200,
    {
      eligible: !row.id,
      generation: Number(row.generation),
      previousSpin: row.id ? rowToSpin(row) : null,
    },
    headers,
  );
}

async function handleSpin(request, env) {
  if (!(await rateAllowed(env, request, "spin", 1_200, 60))) {
    throw new APIError(
      429,
      "Too many spin requests. Please wait a moment and try again.",
      "rate_limited",
    );
  }

  const token = cookieValue(request, VISITOR_COOKIE_NAME);
  if (!token) {
    throw new APIError(
      428,
      "Check eligibility before spinning so this browser can receive its campaign pass.",
      "visitor_cookie_required",
    );
  }

  const payload = await readJson(request);
  const choices = normalizeChoices(payload.choices);
  const participant = normalizeParticipant(payload.participant);
  const winnerIndex = randomIndex(choices.length);
  const result = choices[winnerIndex];
  const spinId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const tokenHash = await sha256Hex(token);
  const choicesJson = JSON.stringify(choices);
  const database = primaryDatabase(env);

  const batch = await database.batch([
    database
      .prepare(
        `
          INSERT INTO spins (
            id, created_at, participant, winner_index, result_id, result_label,
            choice_count, choices_json, attempt_token_hash, campaign_generation
          )
          SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, generation
          FROM campaign_state
          WHERE singleton = 1
          ON CONFLICT(attempt_token_hash, campaign_generation)
          WHERE attempt_token_hash IS NOT NULL
          DO NOTHING
        `,
      )
      .bind(
        spinId,
        createdAt,
        participant || null,
        winnerIndex,
        result.id,
        result.label,
        choices.length,
        choicesJson,
        tokenHash,
      ),
    database
      .prepare(
        `
          SELECT s.*
          FROM spins AS s
          JOIN campaign_state AS c ON c.generation = s.campaign_generation
          WHERE c.singleton = 1 AND s.attempt_token_hash = ?1
          LIMIT 1
        `,
      )
      .bind(tokenHash),
  ]);

  const inserted = Number(batch[0]?.meta?.changes || 0) === 1;
  const storedRow = batch[1]?.results?.[0] || null;
  if (!storedRow) {
    throw new APIError(503, "The spin could not be recorded.", "service_unavailable");
  }
  if (!inserted) {
    throw new APIError(
      409,
      "This browser has already used its spin for the current campaign round.",
      "already_spun",
      { previousSpin: rowToSpin(storedRow) },
    );
  }

  return jsonResponse(201, {
    id: spinId,
    createdAt,
    winnerIndex,
    result,
  });
}

async function isAuthenticated(request, env) {
  const token = cookieValue(request, OWNER_COOKIE_NAME);
  if (!token || !env.DB) return false;
  const tokenHash = await sha256Hex(token);
  const row = await primaryDatabase(env)
    .prepare(
      "SELECT 1 AS authenticated FROM admin_sessions WHERE token_hash = ?1 AND expires_at > ?2",
    )
    .bind(tokenHash, Math.floor(Date.now() / 1000))
    .first();
  return Boolean(row?.authenticated);
}

async function requireAuthentication(request, env) {
  if (!(await isAuthenticated(request, env))) {
    throw new APIError(401, "Owner authentication is required.");
  }
}

async function handleOwnerMe(request, env) {
  return jsonResponse(200, { authenticated: await isAuthenticated(request, env) });
}

async function handleOwnerLogin(request, env) {
  requireSecrets(env);
  const globalAllowed = await rateAllowed(
    env,
    request,
    "owner-login-global",
    200,
    5 * 60,
    "global",
  );
  const clientAllowed = await rateAllowed(env, request, "owner-login", 8, 5 * 60);
  if (!globalAllowed || !clientAllowed) {
    throw new APIError(429, "Too many sign-in attempts. Please wait before trying again.");
  }

  const payload = await readJson(request);
  const pin = payload.pin ?? "";
  if (typeof pin !== "string" || pin.length > 128) {
    throw new APIError(400, "Enter a valid owner PIN.");
  }
  const submittedHash = await sha256Hex(pin);
  if (!timingSafeEqual(submittedHash, env.OWNER_PIN_SHA256.toLowerCase())) {
    throw new APIError(401, "That PIN was not recognized.");
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL_SECONDS;
  const database = primaryDatabase(env);
  await database.batch([
    database.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?1").bind(now),
    database
      .prepare(
        "INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?1, ?2, ?3)",
      )
      .bind(tokenHash, now, expiresAt),
  ]);
  return jsonResponse(
    200,
    { authenticated: true },
    {
      "Set-Cookie": cookieHeader(
        OWNER_COOKIE_NAME,
        token,
        SESSION_TTL_SECONDS,
        request,
      ),
    },
  );
}

async function handleOwnerLogout(request, env) {
  const token = cookieValue(request, OWNER_COOKIE_NAME);
  if (token && env.DB) {
    await primaryDatabase(env)
      .prepare("DELETE FROM admin_sessions WHERE token_hash = ?1")
      .bind(await sha256Hex(token))
      .run();
  }
  return jsonResponse(
    200,
    { authenticated: false },
    { "Set-Cookie": clearCookieHeader(OWNER_COOKIE_NAME, request) },
  );
}

function ownerLimit(url) {
  let limit = MAX_ADMIN_ROWS;
  for (const [key, value] of url.searchParams.entries()) {
    if (key !== "limit") continue;
    const parsed = value.trim() === "" ? Number.NaN : Number(value);
    if (!Number.isInteger(parsed)) throw new APIError(400, "The result limit is invalid.");
    limit = Math.max(1, Math.min(MAX_ADMIN_ROWS, parsed));
  }
  return limit;
}

async function handleOwnerSpins(request, env, url) {
  await requireAuthentication(request, env);
  const limit = ownerLimit(url);
  const database = primaryDatabase(env);
  const batch = await database.batch([
    database
      .prepare(
        `
          SELECT COUNT(s.id) AS total
          FROM campaign_state AS c
          LEFT JOIN spins AS s ON s.campaign_generation = c.generation
          WHERE c.singleton = 1
        `,
      ),
    database
      .prepare(
        `
          SELECT s.*
          FROM spins AS s
          JOIN campaign_state AS c ON c.generation = s.campaign_generation
          WHERE c.singleton = 1
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT ?1
        `,
      )
      .bind(limit),
  ]);
  return jsonResponse(200, {
    count: Number(batch[0]?.results?.[0]?.total || 0),
    spins: (batch[1]?.results || []).map(rowToSpin),
  });
}

function csvSafe(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function handleCsvExport(request, env) {
  await requireAuthentication(request, env);
  const database = primaryDatabase(env);
  const rows = await database
    .prepare(
      `
        SELECT s.*
        FROM spins AS s
        JOIN campaign_state AS c ON c.generation = s.campaign_generation
        WHERE c.singleton = 1
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ?1
      `,
    )
    .bind(MAX_EXPORT_ROWS + 1)
    .all();
  if ((rows.results || []).length > MAX_EXPORT_ROWS) {
    throw new APIError(
      413,
      `Export is limited to ${MAX_EXPORT_ROWS} results at a time.`,
      "export_too_large",
    );
  }
  const output = [
    [
      "spin_id",
      "created_at_utc",
      "participant",
      "result",
      "winner_index",
      "choice_count",
      "choices",
    ],
  ];
  for (const row of rows.results || []) {
    const choices = JSON.parse(row.choices_json);
    output.push([
      row.id,
      row.created_at,
      csvSafe(row.participant),
      csvSafe(row.result_label),
      row.winner_index,
      row.choice_count,
      csvSafe(choices.map((choice) => choice.label).join(" | ")),
    ]);
  }
  const body = `\ufeff${output.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
  const headers = new Headers({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition":
      'attachment; filename="drivu-tbl-summer-rewards-results.csv"',
    "Content-Length": String(textEncoder.encode(body).byteLength),
    "Cache-Control": "no-store",
  });
  applySecurityHeaders(headers);
  return new Response(body, { status: 200, headers });
}

async function handleOwnerReset(request, env) {
  const payload = await readJson(request);
  if (payload.confirm !== true) {
    throw new APIError(400, "Reset confirmation is required.", "confirmation_required");
  }
  const database = primaryDatabase(env);
  const updatedAt = new Date().toISOString();
  const batch = await database.batch([
    database.prepare(
      `
        SELECT c.generation, COUNT(s.id) AS archived_count
        FROM campaign_state AS c
        LEFT JOIN spins AS s ON s.campaign_generation = c.generation
        WHERE c.singleton = 1
        GROUP BY c.generation
      `,
    ),
    database
      .prepare(
        `
          UPDATE campaign_state
          SET generation = generation + 1, updated_at = ?1
          WHERE singleton = 1
          RETURNING generation
        `,
      )
      .bind(updatedAt),
  ]);
  const previous = batch[0]?.results?.[0];
  const updated = batch[1]?.results?.[0];
  if (!previous || !updated) {
    throw new APIError(503, "The campaign could not be reset.", "service_unavailable");
  }
  return jsonResponse(200, {
    ok: true,
    archivedCount: Number(previous.archived_count || 0),
    generation: Number(updated.generation),
  });
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === "GET") {
    if (pathname === "/api/health") return handleHealth(env);
    if (pathname === "/api/eligibility") return handleEligibility(request, env);
    if (pathname === "/api/admin/me") return handleOwnerMe(request, env);
    if (pathname === "/api/admin/spins") return handleOwnerSpins(request, env, url);
    if (pathname === "/api/admin/export.csv") return handleCsvExport(request, env);
    throw new APIError(404, "API endpoint not found.");
  }

  if (request.method === "POST") {
    requireSameOrigin(request);
    if (pathname === "/api/spin") return handleSpin(request, env);
    if (pathname === "/api/admin/login") return handleOwnerLogin(request, env);
    if (pathname === "/api/admin/logout") return handleOwnerLogout(request, env);
    if (pathname === "/api/admin/reset") {
      await requireAuthentication(request, env);
      return handleOwnerReset(request, env);
    }
    throw new APIError(404, "API endpoint not found.");
  }

  throw new APIError(405, "Method not allowed.");
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith("/api/")) {
      return env.ASSETS
        ? env.ASSETS.fetch(request)
        : new Response("Not found", { status: 404 });
    }
    try {
      return await handleApi(request, env);
    } catch (error) {
      if (error instanceof APIError) return errorResponse(error);
      console.error("Unhandled API error", error?.message || String(error));
      return errorResponse(
        new APIError(500, "The server could not complete that request."),
      );
    }
  },

  async scheduled(_controller, env, context) {
    if (!env.DB) return;
    const now = Math.floor(Date.now() / 1000);
    const rateLimitCutoff = now - 24 * 60 * 60;
    const database = primaryDatabase(env);
    context.waitUntil(
      database.batch([
        database
          .prepare("DELETE FROM admin_sessions WHERE expires_at <= ?1")
          .bind(now),
        database
          .prepare("DELETE FROM rate_limits WHERE window_start <= ?1")
          .bind(rateLimitCutoff),
      ]),
    );
  },
};
