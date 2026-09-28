# Waverley Buses Live 🚌

A real-time bus tracking map for the Eastern Suburbs of Sydney, built as a serverless AWS project.

Live at **[waverley-bus.live](https://waverley-bus.live)**

---

## What it does

- Ingests the **NSW Transport GTFS-RT feed** every ~5 seconds (the feed itself refreshes roughly every 10 s), only writing a new snapshot to S3 when the data actually changes
- The browser polls for updates every 3 seconds and **smoothly animates** each bus to its new GPS position, timing the glide to match the vehicle's real GPS fix interval (from its own GTFS-RT timestamp) rather than the poll rate, so motion stays continuous instead of a quick snap followed by a stall
- Each bus rotates to face its **direction of travel** before moving
- Buses are **colour-coded by route** with a legend
- Filter by route using the dropdown
- Shows the current time in Sydney, with a night-time notice (22:00–06:00 Sydney time) warning that bus frequency is reduced

Monitored routes: `313` `333` `350` `360` `362` `370` `373` `379` `380` `381` `390X` `726e`

---

## Architecture

```
NSW GTFS-RT feed (every ~10 s)
        │
        ▼
┌───────────────────┐
│  Ingest Lambda    │  triggered every minute by EventBridge Scheduler
│  (arm64)          │  runs an internal loop for ~55 s, polling every 5 s,
│                   │  writing to S3 only when the data has changed
└────────┬──────────┘
         │ writes latest/buses_latest.json
         ▼
    ┌─────────┐
    │   S3    │  also hosts the built frontend under web_frontend/
    └────┬────┘
         │                         │
         │ read                    │ static files
         ▼                         ▼
┌─────────────────┐      ┌──────────────────┐
│  Read API       │      │   CloudFront CDN │
│  Lambda         │◄─────│   waverley-      │◄── Browser
│  (API Gateway)  │      │   bus.live       │
└─────────────────┘      └──────────────────┘
```

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JS, [Leaflet.js](https://leafletjs.com), HTML/CSS |
| Ingest | Python 3.11, AWS Lambda, `gtfs-realtime-bindings`, `requests` |
| Read API | Python 3.11, AWS Lambda, `boto3` |
| Storage | AWS S3 |
| API | AWS API Gateway HTTP API |
| Scheduler | AWS EventBridge Scheduler |
| CDN | AWS CloudFront + ACM (TLS) |
| Infrastructure | Terraform |
| CI/CD | GitHub Actions |

---

## Project structure

```
.
├── services/
│   ├── ingest_lambda/       # Polls NSW feed, writes snapshot to S3
│   │   ├── src/
│   │   └── tests/
│   ├── read_api_lambda/     # Serves latest.json from S3 via API Gateway
│   │   └── src/
│   └── web_frontend/        # Browser map (index.html, app.js, style.css)
├── infra/
│   └── terraform/
│       └── environments/
│           └── dev/         # AWS infrastructure definition
└── .github/
    └── workflows/           # CI (tests) and CD (deploy) pipelines
```

---

## Local development

**Prerequisites:** Python 3.11+, a [NSW Transport Open Data](https://opendata.transport.nsw.gov.au) API key.

### Frontend

```bash
cd services/web_frontend
python -m http.server 8000
# open http://localhost:8000
```

### Ingest Lambda

```bash
cd services/ingest_lambda
cp .env.example .env          # fill in your NSW API key
pip install -r requirements.txt
python src/handler.py         # runs one polling loop locally (no S3 write)
```

### Tests

```bash
cd services/ingest_lambda
pip install -r requirements.txt
pytest tests/
```

---

## Deployment

**Frontend** deploys automatically: any push to `main` touching `services/web_frontend/` triggers the `deploy-frontend` GitHub Action, which syncs the files to S3 and invalidates the CloudFront cache. No manual step needed.

**Infrastructure** (Terraform, Lambdas) is applied manually, either locally or by running the `deploy-dev` GitHub Action (`workflow_dispatch`).

The ingest Lambda runs on **arm64**, so its zip must be built targeting that architecture — `rebuild_lambda_zip.sh` pins `pip` to `manylinux2014_aarch64` wheels regardless of the machine it's run on. Always rebuild the zip before applying if `services/ingest_lambda/` changed:

```bash
# Package the ingest Lambda (arm64)
bash rebuild_lambda_zip.sh

# Apply infrastructure
cd infra/terraform/environments/dev
terraform init
terraform apply
```

**Required GitHub secrets:**

| Secret | Used by | Description |
|--------|---------|-------------|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `deploy-dev` | AWS credentials for Terraform |
| `TFNSW_API_KEY` | `deploy-dev` | NSW Transport Open Data API key |
| `AWS_ROLE_ARN` | `deploy-frontend` | IAM role assumed via OIDC |
| `S3_BUCKET` | `deploy-frontend` | Frontend S3 bucket name |
| `CLOUDFRONT_DISTRIBUTION_ID` | `deploy-frontend` | CDN cache invalidation |

---

## Data source

Bus positions are sourced from the **NSW Transport Open Data** GTFS-Realtime feed.
API documentation: [opendata.transport.nsw.gov.au](https://opendata.transport.nsw.gov.au)

---

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/).

You are free to share and adapt this work for non-commercial purposes, provided appropriate credit is given.
Commercial use of any kind is strictly prohibited without prior written permission from the author.
