# Drivu x TBL — Spin & Win

A responsive campaign roulette built from the supplied beach artwork. Visitors can configure 2–16 wheel slices, leave labels blank to use automatic prize names, and receive a full-screen winner reveal. Each browser gets one spin per campaign round, while every server-backed result is stored in a private, password-protected owner dashboard.

## Run it

Python 3.11 or newer is the only requirement.

```powershell
cd "C:\Users\Mohammad Belal\Downloads\drivu-tbl-roulette"
python server.py --open
```

The site runs at `http://127.0.0.1:8000`.

For a quick local preview, the owner PIN is `6609`. Set a private PIN before sharing or deploying the site:

```powershell
$env:ROULETTE_OWNER_PIN = "use-a-long-private-pin"
python server.py --host 0.0.0.0 --port 8000
```

## How results are stored

- **Visitor history:** the latest 20 spins are kept only in that visitor's browser.
- **Owner history:** all server-backed spins are written to `data/roulette.db` and can only be read after owner sign-in.
- **Winner selection:** the server selects the winning slice with Python's cryptographically secure random generator before the wheel animates.
- **One-try rule:** an anonymous long-lived browser cookie allows one successful spin per campaign round. Only a SHA-256 hash of its random token is stored.
- **New rounds:** the owner dashboard's **Start new round** action archives the visible winner list and grants every browser one fresh try. Earlier rounds remain recoverable in SQLite.
- **CSV export:** available inside the owner dashboard.

If the page is opened without `server.py`, the wheel can fall back to one device-only spin, but that result cannot reach the private owner log.

The one-try rule is browser-based, not identity verification. Someone can obtain another attempt by using a different browser/device or clearing site data. For strict one-person enforcement, add unique invitation codes, account sign-in, or phone verification before running the campaign.

## Deployment notes

The repository includes a Render Blueprint for a single Frankfurt web service with a 1 GB persistent disk. This preserves the private SQLite winner history across restarts and deployments.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2FMohammadBelalIrshaid%2FDrivu-x-TBL)

During deployment, Render asks for `ROULETTE_OWNER_PIN`. Use a private value with at least 8 characters and keep it outside the repository. The Blueprint also enables secure cookies, proxy-aware rate limiting, the platform-provided port, and `/api/health` health checks.

The persistent disk requires a paid Render web-service instance. Keep the service at one instance because SQLite cannot share this disk across multiple instances. Back up `/var/data/roulette.db` or export the current round as CSV when campaign history must be retained.

The server refuses to bind publicly with the documented local preview PIN. The `6609` fallback works only on the loopback interface for local development.

## Project structure

```text
drivu-tbl-roulette/
├── server.py                 # Static server, API, auth, and SQLite persistence
├── render.yaml               # Render service, secret, and persistent-disk configuration
├── requirements.txt          # Python runtime marker (no third-party packages)
├── public/
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── assets/               # Supplied campaign artwork, optimized for web
└── data/                     # Runtime database (created automatically)
```
