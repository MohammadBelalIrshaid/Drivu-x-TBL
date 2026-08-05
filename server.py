#!/usr/bin/env python3
"""Dependency-free web server for the Drivu x TBL Spin & Win campaign."""

from __future__ import annotations

import argparse
import csv
import hashlib
import hmac
import ipaddress
import io
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
import webbrowser
from collections import defaultdict, deque
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
DEFAULT_DB_PATH = BASE_DIR / "data" / "roulette.db"
configured_db_path = Path(os.environ.get("ROULETTE_DB_PATH", str(DEFAULT_DB_PATH)))
DB_PATH = configured_db_path if configured_db_path.is_absolute() else BASE_DIR / configured_db_path

DEFAULT_OWNER_PIN = "6609"
OWNER_PIN = os.environ.get("ROULETTE_OWNER_PIN", DEFAULT_OWNER_PIN) or DEFAULT_OWNER_PIN
COOKIE_NAME = "drivu_owner_session"
VISITOR_COOKIE_NAME = "drivu_visitor"
COOKIE_SECURE = (
    os.environ.get("ROULETTE_COOKIE_SECURE", "").lower() in {"1", "true", "yes", "on"}
    or os.environ.get("RENDER", "").lower() == "true"
)
TRUST_PROXY = os.environ.get("ROULETTE_TRUST_PROXY", "").lower() in {
    "1",
    "true",
    "yes",
    "on",
}
SESSION_TTL_SECONDS = 8 * 60 * 60
VISITOR_COOKIE_TTL_SECONDS = 400 * 24 * 60 * 60
MAX_BODY_BYTES = 32 * 1024
MAX_ADMIN_ROWS = 1_000
VISITOR_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,128}$")

sessions: dict[str, float] = {}
sessions_lock = threading.Lock()
rate_buckets: dict[tuple[str, str], deque[float]] = defaultdict(deque)
rate_lock = threading.Lock()


class APIError(Exception):
    def __init__(
        self,
        status: int,
        message: str,
        code: str = "request_error",
        extra: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code
        self.extra = extra or {}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def connect_db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect_db() as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS spins (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                participant TEXT,
                winner_index INTEGER NOT NULL,
                result_id TEXT NOT NULL,
                result_label TEXT NOT NULL,
                choice_count INTEGER NOT NULL,
                choices_json TEXT NOT NULL,
                attempt_token_hash TEXT,
                campaign_generation INTEGER NOT NULL DEFAULT 1
            )
            """
        )
        columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(spins)").fetchall()
        }
        if "attempt_token_hash" not in columns:
            connection.execute("ALTER TABLE spins ADD COLUMN attempt_token_hash TEXT")
        if "campaign_generation" not in columns:
            connection.execute(
                "ALTER TABLE spins ADD COLUMN campaign_generation INTEGER NOT NULL DEFAULT 1"
            )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS campaign_state (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                generation INTEGER NOT NULL CHECK (generation >= 1)
            )
            """
        )
        connection.execute(
            "INSERT OR IGNORE INTO campaign_state (singleton, generation) VALUES (1, 1)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_spins_created_at ON spins(created_at DESC)"
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_spins_generation_created
            ON spins(campaign_generation, created_at DESC)
            """
        )
        connection.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_spins_attempt_generation
            ON spins(attempt_token_hash, campaign_generation)
            WHERE attempt_token_hash IS NOT NULL
            """
        )


def current_generation(connection: sqlite3.Connection) -> int:
    row = connection.execute(
        "SELECT generation FROM campaign_state WHERE singleton = 1"
    ).fetchone()
    if row is None:
        connection.execute(
            "INSERT INTO campaign_state (singleton, generation) VALUES (1, 1)"
        )
        return 1
    return int(row["generation"])


def visitor_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def rate_allowed(bucket: str, client: str, limit: int, window_seconds: int) -> bool:
    now = time.monotonic()
    key = (bucket, client)
    with rate_lock:
        entries = rate_buckets[key]
        cutoff = now - window_seconds
        while entries and entries[0] < cutoff:
            entries.popleft()
        if len(entries) >= limit:
            return False
        entries.append(now)
        return True


def clean_sessions() -> None:
    now = time.time()
    expired = [token for token, expiry in sessions.items() if expiry <= now]
    for token in expired:
        sessions.pop(token, None)


def normalize_choices(raw_choices: Any) -> list[dict[str, str]]:
    if not isinstance(raw_choices, list) or not 2 <= len(raw_choices) <= 16:
        raise APIError(400, "Provide between 2 and 16 choices.")

    choices: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    for index, raw_choice in enumerate(raw_choices):
        if not isinstance(raw_choice, dict):
            raise APIError(400, f"Choice {index + 1} is invalid.")
        raw_id = raw_choice.get("id")
        raw_label = raw_choice.get("label", "")

        if raw_label is None:
            raw_label = ""
        if not isinstance(raw_id, str) or not isinstance(raw_label, str):
            raise APIError(400, f"Choice {index + 1} is invalid.")
        if len(raw_id) > 128 or len(raw_label) > 60:
            raise APIError(400, f"Choice {index + 1} is too long.")

        choice_id = raw_id.strip()
        if not choice_id or any(ord(character) < 32 or ord(character) == 127 for character in choice_id):
            raise APIError(400, f"Choice {index + 1} must have a valid id.")
        if choice_id in seen_ids:
            raise APIError(400, "Choice ids must be unique.")
        seen_ids.add(choice_id)
        label = " ".join(raw_label.split()) or f"Prize {index + 1}"
        choices.append({"id": choice_id, "label": label})

    return choices


def row_to_spin(row: sqlite3.Row) -> dict[str, Any]:
    choices = json.loads(row["choices_json"])
    return {
        "id": row["id"],
        "createdAt": row["created_at"],
        "participant": row["participant"] or "",
        "winnerIndex": row["winner_index"],
        "result": {"id": row["result_id"], "label": row["result_label"]},
        "choiceCount": row["choice_count"],
        "choices": choices,
    }


def csv_safe(value: Any) -> str:
    """Prevent spreadsheet programs from treating visitor text as a formula."""
    text = "" if value is None else str(value)
    return f"'{text}" if text.startswith(("=", "+", "-", "@", "\t", "\r")) else text


class RouletteHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class RouletteHandler(SimpleHTTPRequestHandler):
    server_version = "DrivuSpinWin/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        if COOKIE_SECURE:
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; "
            "form-action 'self'",
        )
        if urlsplit(self.path).path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        try:
            if path == "/api/health":
                self.send_json(200, {"ok": True})
                return
            if path == "/api/eligibility":
                self.handle_eligibility()
                return
            if path == "/api/admin/me":
                self.send_json(200, {"authenticated": self.is_authenticated()})
                return
            if path == "/api/admin/spins":
                self.require_authentication()
                self.handle_admin_spins()
                return
            if path == "/api/admin/export.csv":
                self.require_authentication()
                self.handle_csv_export()
                return
            if path.startswith("/api/"):
                raise APIError(404, "API endpoint not found.")

            if path == "/":
                self.path = "/index.html"
            super().do_GET()
        except APIError as error:
            self.send_api_error(error)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            self.send_api_error(APIError(500, "The server could not complete that request."))

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        try:
            self.require_same_origin()
            if path == "/api/spin":
                self.handle_spin()
                return
            if path == "/api/admin/login":
                self.handle_login()
                return
            if path == "/api/admin/logout":
                self.handle_logout()
                return
            if path == "/api/admin/reset":
                self.require_authentication()
                self.handle_admin_reset()
                return
            raise APIError(404, "API endpoint not found.")
        except APIError as error:
            self.send_api_error(error)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            self.send_api_error(APIError(500, "The server could not complete that request."))

    def require_same_origin(self) -> None:
        fetch_site = self.headers.get("Sec-Fetch-Site", "")
        if fetch_site and fetch_site not in {"same-origin", "none"}:
            raise APIError(403, "Cross-origin requests are not allowed.", "cross_origin")
        origin = self.headers.get("Origin")
        if not origin:
            return
        parsed = urlsplit(origin)
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.netloc.lower() != self.headers.get("Host", "").lower()
        ):
            raise APIError(403, "Cross-origin requests are not allowed.", "cross_origin")

    def read_json(self) -> dict[str, Any]:
        content_type = self.headers.get_content_type()
        if content_type != "application/json":
            raise APIError(415, "Send this request as application/json.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise APIError(400, "Invalid request length.") from error
        if length <= 0:
            raise APIError(400, "A JSON request body is required.")
        if length > MAX_BODY_BYTES:
            raise APIError(413, "The request is too large.")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise APIError(400, "The JSON request body is invalid.") from error
        if not isinstance(payload, dict):
            raise APIError(400, "The JSON request body must be an object.")
        return payload

    def client_key(self) -> str:
        peer = self.client_address[0] if self.client_address else "unknown"
        if not TRUST_PROXY:
            return peer

        forwarded_for = self.headers.get("X-Forwarded-For", "")
        candidate = forwarded_for.split(",", 1)[0].strip()
        try:
            return str(ipaddress.ip_address(candidate))
        except ValueError:
            return peer

    def parsed_cookies(self) -> SimpleCookie[str]:
        cookie: SimpleCookie[str] = SimpleCookie()
        raw_cookie = self.headers.get("Cookie")
        if not raw_cookie:
            return cookie
        try:
            cookie.load(raw_cookie)
        except Exception:
            return SimpleCookie()
        return cookie

    def visitor_token(self) -> str | None:
        morsel = self.parsed_cookies().get(VISITOR_COOKIE_NAME)
        if not morsel or not VISITOR_TOKEN_PATTERN.fullmatch(morsel.value):
            return None
        return morsel.value

    def visitor_cookie(self, token: str, *, clear: bool = False) -> str:
        max_age = 0 if clear else VISITOR_COOKIE_TTL_SECONDS
        value = "" if clear else token
        cookie = (
            f"{VISITOR_COOKIE_NAME}={value}; Path=/; HttpOnly; SameSite=Strict; "
            f"Max-Age={max_age}"
        )
        if COOKIE_SECURE:
            cookie += "; Secure"
        return cookie

    def handle_eligibility(self) -> None:
        if not rate_allowed("eligibility", self.client_key(), 1_200, 60):
            raise APIError(429, "Too many requests. Please wait a moment.", "rate_limited")

        token = self.visitor_token()
        headers: dict[str, str] | None = None
        if token is None:
            token = secrets.token_urlsafe(32)
            headers = {"Set-Cookie": self.visitor_cookie(token)}
        token_hash = visitor_token_hash(token)

        with connect_db() as connection:
            connection.execute("BEGIN")
            generation = current_generation(connection)
            row = connection.execute(
                """
                SELECT * FROM spins
                WHERE attempt_token_hash = ? AND campaign_generation = ?
                LIMIT 1
                """,
                (token_hash, generation),
            ).fetchone()
        self.send_json(
            200,
            {
                "eligible": row is None,
                "generation": generation,
                "previousSpin": row_to_spin(row) if row is not None else None,
            },
            headers,
        )

    def handle_spin(self) -> None:
        if not rate_allowed("spin", self.client_key(), 1_200, 60):
            raise APIError(
                429,
                "Too many spin requests. Please wait a moment and try again.",
                "rate_limited",
            )
        token = self.visitor_token()
        if token is None:
            raise APIError(
                428,
                "Check eligibility before spinning so this browser can receive its campaign pass.",
                "visitor_cookie_required",
            )
        payload = self.read_json()
        choices = normalize_choices(payload.get("choices"))

        participant = payload.get("participant", "")
        if participant is None:
            participant = ""
        if not isinstance(participant, str) or len(participant) > 120:
            raise APIError(400, "Participant name must be 120 characters or fewer.")
        participant = " ".join(participant.split())

        token_hash = visitor_token_hash(token)
        with connect_db() as connection:
            connection.execute("BEGIN IMMEDIATE")
            generation = current_generation(connection)
            previous = connection.execute(
                """
                SELECT * FROM spins
                WHERE attempt_token_hash = ? AND campaign_generation = ?
                LIMIT 1
                """,
                (token_hash, generation),
            ).fetchone()
            if previous is not None:
                connection.rollback()
                raise APIError(
                    409,
                    "This browser has already used its spin for the current campaign round.",
                    "already_spun",
                    {"previousSpin": row_to_spin(previous)},
                )

            winner_index = secrets.randbelow(len(choices))
            result = choices[winner_index]
            spin_id = str(uuid.uuid4())
            created_at = utc_now()
            choices_json = json.dumps(choices, ensure_ascii=False, separators=(",", ":"))
            try:
                connection.execute(
                    """
                    INSERT INTO spins (
                        id, created_at, participant, winner_index, result_id,
                        result_label, choice_count, choices_json,
                        attempt_token_hash, campaign_generation
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        spin_id,
                        created_at,
                        participant or None,
                        winner_index,
                        result["id"],
                        result["label"],
                        len(choices),
                        choices_json,
                        token_hash,
                        generation,
                    ),
                )
                connection.commit()
            except sqlite3.IntegrityError:
                connection.rollback()
                previous = connection.execute(
                    """
                    SELECT * FROM spins
                    WHERE attempt_token_hash = ? AND campaign_generation = ?
                    LIMIT 1
                    """,
                    (token_hash, generation),
                ).fetchone()
                if previous is not None:
                    raise APIError(
                        409,
                        "This browser has already used its spin for the current campaign round.",
                        "already_spun",
                        {"previousSpin": row_to_spin(previous)},
                    ) from None
                raise

        self.send_json(
            201,
            {
                "id": spin_id,
                "createdAt": created_at,
                "winnerIndex": winner_index,
                "result": result,
            },
        )

    def handle_login(self) -> None:
        if not rate_allowed("owner-login-global", "all", 200, 5 * 60) or not rate_allowed(
            "owner-login", self.client_key(), 8, 5 * 60
        ):
            raise APIError(429, "Too many sign-in attempts. Please wait before trying again.")
        payload = self.read_json()
        pin = payload.get("pin", "")
        if not isinstance(pin, str) or len(pin) > 128:
            raise APIError(400, "Enter a valid owner PIN.")
        if not hmac.compare_digest(pin.encode("utf-8"), OWNER_PIN.encode("utf-8")):
            raise APIError(401, "That PIN was not recognized.")

        token = secrets.token_urlsafe(32)
        with sessions_lock:
            clean_sessions()
            sessions[token] = time.time() + SESSION_TTL_SECONDS
        cookie = (
            f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; "
            f"Max-Age={SESSION_TTL_SECONDS}"
        )
        if COOKIE_SECURE:
            cookie += "; Secure"
        self.send_json(200, {"authenticated": True}, {"Set-Cookie": cookie})

    def handle_logout(self) -> None:
        token = self.session_token()
        if token:
            with sessions_lock:
                sessions.pop(token, None)
        cookie = f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
        if COOKIE_SECURE:
            cookie += "; Secure"
        self.send_json(200, {"authenticated": False}, {"Set-Cookie": cookie})

    def session_token(self) -> str | None:
        morsel = self.parsed_cookies().get(COOKIE_NAME)
        return morsel.value if morsel else None

    def is_authenticated(self) -> bool:
        token = self.session_token()
        if not token:
            return False
        with sessions_lock:
            clean_sessions()
            expiry = sessions.get(token)
            if not expiry or expiry <= time.time():
                sessions.pop(token, None)
                return False
            return True

    def require_authentication(self) -> None:
        if not self.is_authenticated():
            raise APIError(401, "Owner authentication is required.")

    def handle_admin_spins(self) -> None:
        query = urlsplit(self.path).query
        limit = MAX_ADMIN_ROWS
        if query:
            for pair in query.split("&"):
                key, _, value = pair.partition("=")
                if key == "limit":
                    try:
                        limit = max(1, min(MAX_ADMIN_ROWS, int(value)))
                    except ValueError:
                        raise APIError(400, "The result limit is invalid.") from None
        with connect_db() as connection:
            connection.execute("BEGIN")
            generation = current_generation(connection)
            total = connection.execute(
                "SELECT COUNT(*) FROM spins WHERE campaign_generation = ?", (generation,)
            ).fetchone()[0]
            rows = connection.execute(
                """
                SELECT * FROM spins
                WHERE campaign_generation = ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                (generation, limit),
            ).fetchall()
        self.send_json(200, {"count": total, "spins": [row_to_spin(row) for row in rows]})

    def handle_csv_export(self) -> None:
        with connect_db() as connection:
            connection.execute("BEGIN")
            generation = current_generation(connection)
            rows = connection.execute(
                """
                SELECT * FROM spins
                WHERE campaign_generation = ?
                ORDER BY created_at DESC, id DESC
                """,
                (generation,),
            ).fetchall()
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(
            ["spin_id", "created_at_utc", "participant", "result", "winner_index", "choice_count", "choices"]
        )
        for row in rows:
            choices = json.loads(row["choices_json"])
            writer.writerow(
                [
                    row["id"],
                    row["created_at"],
                    csv_safe(row["participant"]),
                    csv_safe(row["result_label"]),
                    row["winner_index"],
                    row["choice_count"],
                    csv_safe(" | ".join(choice["label"] for choice in choices)),
                ]
            )
        content = ("\ufeff" + output.getvalue()).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="drivu-tbl-spin-results.csv"')
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def handle_admin_reset(self) -> None:
        payload = self.read_json()
        if payload.get("confirm") is not True:
            raise APIError(
                400,
                "Reset confirmation is required.",
                "confirmation_required",
            )

        with connect_db() as connection:
            connection.execute("BEGIN IMMEDIATE")
            generation = current_generation(connection)
            archived_count = int(
                connection.execute(
                    "SELECT COUNT(*) FROM spins WHERE campaign_generation = ?",
                    (generation,),
                ).fetchone()[0]
            )
            next_generation = generation + 1
            connection.execute(
                "UPDATE campaign_state SET generation = ? WHERE singleton = 1",
                (next_generation,),
            )
            connection.commit()

        self.send_json(
            200,
            {
                "ok": True,
                "archivedCount": archived_count,
                "generation": next_generation,
            },
        )

    def send_api_error(self, error: APIError) -> None:
        payload: dict[str, Any] = {
            "error": {"code": error.code, "message": error.message}
        }
        payload.update(error.extra)
        self.send_json(error.status, payload)

    def send_json(
        self, status: int, payload: dict[str, Any], headers: dict[str, str] | None = None
    ) -> None:
        content = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        if headers:
            for name, value in headers.items():
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(content)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Drivu x TBL Spin & Win website.")
    default_host = os.environ.get("HOST", "127.0.0.1")
    try:
        default_port = int(os.environ.get("PORT", "8000"))
    except ValueError:
        default_port = 8000
    parser.add_argument(
        "--host",
        default=default_host,
        help=f"Host interface (default: {default_host})",
    )
    parser.add_argument(
        "--port",
        default=default_port,
        type=int,
        help=f"HTTP port (default: {default_port})",
    )
    parser.add_argument("--open", action="store_true", help="Open the site in the default browser")
    return parser.parse_args()


def validate_runtime_config(host: str) -> None:
    public_bind = host not in {"127.0.0.1", "::1", "localhost"}
    if not public_bind:
        return
    if OWNER_PIN == DEFAULT_OWNER_PIN:
        raise SystemExit(
            "ROULETTE_OWNER_PIN must be set to a private value before binding publicly."
        )
    if len(OWNER_PIN) < 8:
        raise SystemExit("ROULETTE_OWNER_PIN must contain at least 8 characters.")


def main() -> None:
    args = parse_args()
    validate_runtime_config(args.host)
    initialize_database()
    mimetypes.add_type("image/webp", ".webp")
    server = RouletteHTTPServer((args.host, args.port), RouletteHandler)
    display_host = "127.0.0.1" if args.host in {"0.0.0.0", "::"} else args.host
    url = f"http://{display_host}:{server.server_address[1]}"
    print(f"Drivu x TBL Spin & Win is running at {url}")
    if OWNER_PIN == DEFAULT_OWNER_PIN:
        print("Owner PIN: 6609 (set ROULETTE_OWNER_PIN before sharing or deployment)")
    if args.open:
        timer = threading.Timer(0.45, lambda: webbrowser.open(url))
        timer.daemon = True
        timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
