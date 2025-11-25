import express from "express";
import axios from "axios";

const app = express();

// In-memory cache per currency
let cache = {};
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

/**
 * Fetch deals from CheapShark and store in cache
 */
async function fetchDeals(currency) {
  try {
    const response = await axios.get("https://www.cheapshark.com/api/1.0/deals", {
      params: { pageSize: 20, cc: currency }
    });
    cache[currency] = {
      timestamp: Date.now(),
      data: response.data
    };
    console.log(`Cache updated for ${currency} with ${response.data.length} deals`);
  } catch (err) {
    console.error(`Error fetching deals for ${currency}:`, err.message);
  }
}

/**
 * Pre-warm USD and CAD on startup
 */
["USD", "CAD"].forEach(fetchDeals);

/**
 * Set up hourly update for USD and CAD
 */
setInterval(() => {
  ["USD", "CAD"].forEach(fetchDeals);
}, CACHE_TTL); // every 1 hour

/**
 * GET /deals
 * Optional query: ?currency=USD or CAD
 */
app.get("/deals", async (req, res) => {
  try {
    const currency = (req.query.currency || "USD").toUpperCase();

    // Return cache if available
    if (cache[currency]) {
      return res.json({
        success: true,
        cached: true,
        currency,
        count: cache[currency].data.length,
        deals: cache[currency].data
      });
    }

    // If cache missing (first-time other currency), fetch on-demand
    await fetchDeals(currency);

    res.json({
      success: true,
      cached: false,
      currency,
      count: cache[currency].data.length,
      deals: cache[currency].data
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`gaming-api running on port ${PORT}`));
