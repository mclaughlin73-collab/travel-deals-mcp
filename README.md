# travel-deals-mcp

A remote MCP server exposing two tools backed by real, legitimate APIs:

- `search_cash_flights` — real cash fares via the [Duffel](https://duffel.com) flight API
- `search_award_availability` — real award/miles availability via the [Seats.aero Pro API](https://developers.seats.aero) (defaults to United MileagePlus)

No scraping, no reverse-engineering. Both upstream APIs are documented, stable, and paid/contracted, which is the whole point.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DUFFEL_API_KEY` | yes | Your Duffel access token (`duffel_test_...` or `duffel_live_...`) |
| `SEATS_AERO_API_KEY` | yes | Your Seats.aero Pro API key (`pro_...`) |
| `GF_MCP_SHARED_KEY` | recommended | A long random string. Callers must pass it as `?key=...` on the `/mcp` URL. Protects this public endpoint from random internet traffic. |
| `GF_MCP_AUTH_TOKEN` | optional | Alternative bearer-token auth (`Authorization: Bearer ...`) for clients that support custom headers. |
| `PORT` | set by Render automatically | HTTP port |

## Endpoints

- `GET /health` — no auth, confirms the process is up and which keys are configured
- `POST /mcp`, `GET /mcp`, `DELETE /mcp` — the MCP Streamable HTTP transport, requires auth if either env var above is set

## Deploying on Render

1. Push this folder to a GitHub repo
2. Render dashboard → New + → Web Service → connect the repo (Render auto-detects the Dockerfile)
3. Set the environment variables above
4. Deploy. Render gives you a URL like `https://travel-deals-mcp-xxxx.onrender.com`

## Adding as a claude.ai custom connector

URL: `https://<your-render-url>/mcp?key=<your GF_MCP_SHARED_KEY value>`
