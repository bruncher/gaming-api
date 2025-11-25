# gaming-api

Node.js microservice that returns current game deals from the [CheapShark API](https://www.cheapshark.com/api/) in **USD** and **CAD**.

## Features

- Returns discounted game deals in USD or CAD
- Automatically caches deals per currency for **1 hour**
- Pre-warms USD and CAD on startup
- Hourly automatic refresh
- Ready to deploy on Render

## Endpoints

### GET /deals

**Query parameters:**

| Parameter | Description | Default |
|-----------|-------------|---------|
| currency  | Currency code (USD, CAD, etc.) | USD |
