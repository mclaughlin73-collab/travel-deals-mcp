import express from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DUFFEL_API_KEY = process.env.DUFFEL_API_KEY;
const SEATS_AERO_API_KEY = process.env.SEATS_AERO_API_KEY;
const GF_MCP_SHARED_KEY = process.env.GF_MCP_SHARED_KEY;
const GF_MCP_AUTH_TOKEN = process.env.GF_MCP_AUTH_TOKEN;

// ---------------------------------------------------------------------------
// Duffel: cash fare search
// ---------------------------------------------------------------------------
const searchCashFlightsSchema = z.object({
  origin: z.string().length(3).describe("Origin airport IATA code, e.g. SFO"),
  destination: z.string().length(3).describe("Destination airport IATA code, e.g. DFW"),
  departureDate: z.string().describe("Departure date, YYYY-MM-DD"),
  returnDate: z.string().optional().describe("Return date, YYYY-MM-DD. Omit for one-way."),
  cabinClass: z.enum(["economy", "premium_economy", "business", "first"]).default("economy"),
  adults: z.number().int().min(1).default(1),
  maxResults: z.number().int().min(1).max(20).default(8),
});

async function searchCashFlights(params) {
  if (!DUFFEL_API_KEY) {
    throw new Error("Server misconfigured: DUFFEL_API_KEY is not set");
  }
  const { origin, destination, departureDate, returnDate, cabinClass, adults, maxResults } = params;

  const slices = [{ origin, destination, departure_date: departureDate }];
  if (returnDate) {
    slices.push({ origin: destination, destination: origin, departure_date: returnDate });
  }
  const passengers = Array.from({ length: adults }, () => ({ type: "adult" }));

  const resp = await fetch("https://api.duffel.com/air/offer_requests?return_offers=true", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Duffel-Version": "v2",
      Authorization: `Bearer ${DUFFEL_API_KEY}`,
      Accept: "application/json",
    },
    body: JSON.stringify({
      data: { slices, passengers, cabin_class: cabinClass },
    }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const detail = json?.errors ? JSON.stringify(json.errors) : `HTTP ${resp.status}`;
    throw new Error(`Duffel error: ${detail}`);
  }

  const offers = (json?.data?.offers ?? [])
    .map((o) => ({
      id: o.id,
      price: o.total_amount,
      currency: o.total_currency,
      airline: o.owner?.name ?? o.owner?.iata_code ?? "unknown",
      slices: (o.slices ?? []).map((s) => ({
        durationIso: s.duration,
        segments: (s.segments ?? []).map((seg) => ({
          from: seg.origin?.iata_code,
          to: seg.destination?.iata_code,
          airline: seg.marketing_carrier?.name,
          flightNumber: seg.marketing_carrier_flight_number,
          departingAt: seg.departing_at,
          arrivingAt: seg.arriving_at,
          cabinClass: seg.passengers?.[0]?.cabin_class,
        })),
      })),
    }))
    .sort((a, b) => parseFloat(a.price) - parseFloat(b.price))
    .slice(0, maxResults);

  return {
    origin,
    destination,
    departureDate,
    returnDate: returnDate ?? null,
    cabinClassRequested: cabinClass,
    offerCount: json?.data?.offers?.length ?? 0,
    cheapestOffers: offers,
  };
}

// ---------------------------------------------------------------------------
// Seats.aero: United MileagePlus (and other program) award availability
// ---------------------------------------------------------------------------
const searchAwardAvailabilitySchema = z.object({
  origin: z.string().describe("Origin airport IATA code, or comma-separated list, e.g. SFO or SFO,OAK"),
  destination: z.string().describe("Destination airport IATA code, or comma-separated list"),
  startDate: z.string().optional().describe("Earliest departure date, YYYY-MM-DD"),
  endDate: z.string().optional().describe("Latest departure date, YYYY-MM-DD"),
  cabinClass: z
    .enum(["economy", "premium", "business", "first"])
    .optional()
    .describe("Cabin filter. Seats.aero uses 'premium' for premium economy."),
  source: z
    .string()
    .default("united")
    .describe("Loyalty program(s) to search, comma-delimited, e.g. 'united' or 'united,aeroplan'"),
  onlyDirectFlights: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(100).default(25),
});

async function searchAwardAvailability(params) {
  if (!SEATS_AERO_API_KEY) {
    throw new Error("Server misconfigured: SEATS_AERO_API_KEY is not set");
  }
  const { origin, destination, startDate, endDate, cabinClass, source, onlyDirectFlights, maxResults } = params;

  const query = new URLSearchParams({
    origin_airport: origin,
    destination_airport: destination,
    sources: source,
    order_by: "lowest_mileage",
    take: String(Math.min(maxResults, 1000)),
  });
  if (startDate) query.set("start_date", startDate);
  if (endDate) query.set("end_date", endDate);
  if (cabinClass) query.set("cabins", cabinClass);
  if (onlyDirectFlights) query.set("only_direct_flights", "true");

  const resp = await fetch(`https://seats.aero/partnerapi/search?${query.toString()}`, {
    headers: {
      "Partner-Authorization": SEATS_AERO_API_KEY,
      Accept: "application/json",
    },
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`Seats.aero error: HTTP ${resp.status} - ${JSON.stringify(json).slice(0, 500)}`);
  }

  const results = (json?.data ?? []).slice(0, maxResults);

  return {
    origin,
    destination,
    source,
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    resultCount: results.length,
    availability: results,
  };
}

// ---------------------------------------------------------------------------
// MCP tool registration
// ---------------------------------------------------------------------------
const toMcpResponse = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

const toMcpError = (error) => ({
  content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
  isError: true,
});

const registerTools = (server) => {
  server.tool(
    "search_cash_flights",
    "Search real, live cash flight prices via the Duffel flight API. Returns actual airline offers sorted by price, cheapest first.",
    searchCashFlightsSchema.shape,
    async (params) => {
      try {
        return toMcpResponse(await searchCashFlights(params));
      } catch (err) {
        return toMcpError(err);
      }
    }
  );

  server.tool(
    "search_award_availability",
    "Search real award/miles availability via the Seats.aero Pro API. Defaults to United MileagePlus ('united'), but accepts other loyalty programs too (comma-delimited 'source').",
    searchAwardAvailabilitySchema.shape,
    async (params) => {
      try {
        return toMcpResponse(await searchAwardAvailability(params));
      } catch (err) {
        return toMcpError(err);
      }
    }
  );
};

// ---------------------------------------------------------------------------
// HTTP transport (remote MCP server)
// ---------------------------------------------------------------------------
const startHttp = async () => {
  const app = express();
  app.use(express.json());

  const sessions = new Map();

  const requireAuth = (req, res, next) => {
    if (!GF_MCP_AUTH_TOKEN && !GF_MCP_SHARED_KEY) return next();
    const header = req.headers.authorization ?? "";
    if (GF_MCP_AUTH_TOKEN && header === `Bearer ${GF_MCP_AUTH_TOKEN}`) return next();
    const queryKey = typeof req.query.key === "string" ? req.query.key : undefined;
    if (GF_MCP_SHARED_KEY && queryKey === GF_MCP_SHARED_KEY) return next();
    res.status(401).json({ error: "Unauthorized" });
  };

  app.use("/mcp", requireAuth);

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // A session ID was sent but this process doesn't recognize it (e.g. the
    // server restarted and the in-memory session map reset). Only a fresh
    // "initialize" request may start a brand-new session. Anything else
    // referencing an unknown session ID gets a 404 so the client knows to
    // reinitialize, instead of silently being force-fed into a new,
    // not-yet-initialized transport (which fails with "Server not
    // initialized").
    const isInitializeRequest = req.body?.method === "initialize";
    if (sessionId && !isInitializeRequest) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found. Reinitialize." },
        id: req.body?.id ?? null,
      });
      return;
    }

    const server = new McpServer({ name: "travel-deals", version: "1.0.0" });
    registerTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { server, transport });
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId).transport.handleRequest(req, res);
      return;
    }
    res.status(400).json({ error: "No session. Send a POST to /mcp first." });
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId).transport.handleRequest(req, res);
      sessions.delete(sessionId);
      return;
    }
    res.status(400).json({ error: "No session found." });
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      tools: 2,
      duffelConfigured: Boolean(DUFFEL_API_KEY),
      seatsAeroConfigured: Boolean(SEATS_AERO_API_KEY),
    });
  });

  const port = parseInt(process.env.PORT ?? "3000", 10);
  app.listen(port, () => {
    console.error(`travel-deals-mcp running on http://0.0.0.0:${port}/mcp (2 tools)`);
  });
};

startHttp().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
