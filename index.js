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
    headers:
