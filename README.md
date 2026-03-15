# Waverley Buses Live 🚌

A real-time bus tracking map for the Eastern Suburbs of Sydney, built as a serverless AWS project.

Live at **[waverley-bus.live](https://waverley-bus.live)**

---

## What it does

- Fetches live bus positions from the **NSW Transport GTFS-RT feed** every 10 seconds
- Displays buses on an interactive map with **smooth animation** between GPS updates
- Each bus rotates to face its **direction of travel** before moving
- Buses are **colour-coded by route** with a legend
- Filter by route using the dropdown

Monitored routes: `313` `333` `350` `370` `373` `379` `390X`

---

## Architecture

```
NSW GTFS-RT feed (every ~10 s)
        │
        ▼
┌───────────────────┐
│  Ingest Lambda    │  triggered every minute by EventBridge Scheduler
│  polls feed every │  runs an internal loop for 55 s, writing to S3
│  5 s              │  each time new data arrives
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

Infrastructure is managed with Terraform. Deployment is triggered manually via GitHub Actions.

**Required GitHub secrets:**

| Secret | Description |
|--------|-------------|
| `AWS_ACCESS_KEY_ID` | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials |
| `TFNSW_API_KEY` | NSW Transport Open Data API key |

```bash
# First-time setup
cd infra/terraform/environments/dev
terraform init
terraform apply
```

---

## Data source

Bus positions are sourced from the **NSW Transport Open Data** GTFS-Realtime feed.
API documentation: [opendata.transport.nsw.gov.au](https://opendata.transport.nsw.gov.au)

---

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/).

You are free to share and adapt this work for non-commercial purposes, provided appropriate credit is given.
Commercial use of any kind is strictly prohibited without prior written permission from the author.
