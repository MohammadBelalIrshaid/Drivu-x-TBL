const CANONICAL_URL_ERROR = "The official Summer Rewards website is unavailable.";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
};

function secureHeaders(initialHeaders = undefined) {
  const headers = new Headers(initialHeaders || {});
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return headers;
}

function canonicalUrl(env) {
  if (typeof env.CANONICAL_PUBLIC_URL !== "string") return null;
  try {
    const url = new URL(env.CANONICAL_PUBLIC_URL);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function jsonResponse(status, payload, extraHeaders = undefined) {
  const headers = secureHeaders(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return Response.json(payload, { status, headers });
}

function retiredResponse(env) {
  const canonical = canonicalUrl(env);
  const payload = {
    error: {
      code: "canonical_host_required",
      message: "Use the official Summer Rewards website for this request.",
    },
  };
  if (canonical) payload.canonicalUrl = canonical.href;
  return jsonResponse(410, payload);
}

function methodNotAllowedResponse() {
  return jsonResponse(
    405,
    {
      error: {
        code: "method_not_allowed",
        message: "Only navigation requests can use this retired address.",
      },
    },
    { Allow: "GET, HEAD" },
  );
}

function redirectResponse(request, env) {
  const canonical = canonicalUrl(env);
  if (!canonical) {
    return jsonResponse(503, {
      error: {
        code: "canonical_url_unavailable",
        message: CANONICAL_URL_ERROR,
      },
    });
  }

  const requestUrl = new URL(request.url);
  const destination = new URL(canonical.origin);
  destination.pathname = requestUrl.pathname;
  destination.search = requestUrl.search;
  const headers = secureHeaders({
    "Cache-Control": "no-store",
    Location: destination.href,
  });
  return new Response(null, { status: 308, headers });
}

function primaryDatabase(env) {
  if (!env.DB) return null;
  return typeof env.DB.withSession === "function"
    ? env.DB.withSession("first-primary")
    : env.DB;
}

export default {
  fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return retiredResponse(env);
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      return methodNotAllowedResponse();
    }
    return redirectResponse(request, env);
  },

  async scheduled(_controller, env, context) {
    const database = primaryDatabase(env);
    if (!database) return;
    const now = Math.floor(Date.now() / 1000);
    const rateLimitCutoff = now - 24 * 60 * 60;
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
