# Drivu x TBL - Spin & Win

A responsive campaign roulette built from the supplied beach artwork. Visitors can use 2-16 wheel slices, leave labels blank for automatic prize names, and see a full-screen winner reveal. Results are stored server-side for the private owner dashboard.

## Live site

Open the public roulette at [drivu-tbl-roulette.mohammadbelalirshaid.workers.dev](https://drivu-tbl-roulette.mohammadbelalirshaid.workers.dev). The private dashboard is available from the **Owner access** button on the same page.

## Run locally with Python

Python 3.11 or newer is the only requirement; the server has no third-party Python dependencies.

```powershell
cd "path\to\drivu-tbl-roulette"
python server.py --open
```

Open `http://127.0.0.1:8000`. The built-in preview credentials work only on the loopback interface. To test with a private PIN without placing it in shell history:

```powershell
$env:ROULETTE_OWNER_PIN = Read-Host "Private owner PIN"
python server.py
```

The Python server stores results in `data/roulette.db`. This local SQLite database is separate from Cloudflare D1.

## Run the Cloudflare version locally

Install Node.js and npm, then run:

```powershell
npm install
npx wrangler d1 migrations apply drivu-tbl-roulette-prod --local
Copy-Item .dev.vars.example .dev.vars
# Replace both placeholder values in .dev.vars, then start the Worker:
npm run dev
```

The ignored `.dev.vars` file supplies local values for `OWNER_PIN_SHA256` and `RATE_LIMIT_SECRET`. `OWNER_PIN_SHA256` is the 64-character hexadecimal SHA-256 digest of a private, randomly generated owner password of at least 16 characters; `RATE_LIMIT_SECRET` must be a random string of at least 32 characters. Never commit either value.

## Deploy to Cloudflare Workers and D1

The production D1 binding is defined in `wrangler.jsonc`. From the project directory:

```powershell
npm install
npx wrangler login
npm run check
npx wrangler d1 migrations list drivu-tbl-roulette-prod --remote
npx wrangler d1 migrations apply drivu-tbl-roulette-prod --remote
npx wrangler secret put OWNER_PIN_SHA256
npx wrangler secret put RATE_LIMIT_SECRET
npm run deploy
```

Enter each secret only at Wrangler's prompt. Do not put production values in `wrangler.jsonc`, source files, shell scripts, or version control. Run remote migrations before deploying code that depends on a new schema.

Cloudflare's free tier currently includes 100,000 dynamic Worker requests per day, 5 million D1 rows read per day, 100,000 D1 rows written per day, 5 GB of included D1 account storage, and a 500 MB limit for each free D1 database. Static asset requests are free and unlimited. Index updates also count as D1 row writes, so monitor usage during high-volume campaigns.

## Results, privacy, and the one-browser rule

- The latest 20 visitor results remain in that visitor's browser.
- Production results are stored in D1 and exposed only through authenticated owner API routes and the owner dashboard.
- Owner sessions, rate limits, campaign rounds, and spin records are persisted in D1.
- The server chooses the winner before the wheel animation begins.
- A long-lived anonymous cookie permits one successful spin per browser per campaign round; only its SHA-256 hash is stored.
- Starting a new round gives each browser one fresh attempt while retaining earlier records.
- The owner dashboard can view results and export the current round as CSV.

The one-spin rule is a browser control, not identity verification. A participant can receive another attempt by clearing site data or using another browser or device. Use unique invitation codes, account sign-in, or verified contact details when strict one-person enforcement is required.

## Project structure

```text
drivu-tbl-roulette/
|-- public/                  # HTML, CSS, browser JavaScript, headers, and artwork
|-- src/worker.js            # Cloudflare API, authentication, rate limits, and D1 access
|-- migrations/              # Versioned D1 schema
|-- wrangler.jsonc           # Worker, static asset, scheduled task, and D1 configuration
|-- package.json             # Wrangler scripts and pinned development dependency
|-- server.py                # Local Python API and SQLite server
|-- requirements.txt         # Documents the dependency-free Python runtime
`-- data/                    # Local SQLite data; runtime files are ignored by Git
```
