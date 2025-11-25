import express from "express";
import axios from "axios";

const app = express();

// In-memory cache per currency
let cache = {};
const CACHE_TTL = 1000 * 60 * 60; // 1 hour
const CURRENCIES = ["USD", "CAD"];
let storeMap = {};

/**
 * Load storeID -> storeName map
 */
async function loadStores() {
  try {
    const res = await axios.get("https://www.cheapshark.com/api/1.0/stores");
    storeMap = Object.fromEntries(res.data.map(s => [s.storeID, s.storeName]));
  } catch (err) {
    console.error("Error loading stores:", err.message);
  }
}

/**
 * Fetch deals from CheapShark and store in cache
 */
async function fetchDeals(currency) {
  try {
    const response = await axios.get("https://www.cheapshark.com/api/1.0/deals", {
      params: { pageSize: 100, cc: currency }
    });

    // Keep only one deal per game, pick cheapest
    const uniqueDeals = Object.values(
      response.data.reduce((acc, deal) => {
        const gameId = deal.gameID;
        if (!acc[gameId] || parseFloat(deal.salePrice) < parseFloat(acc[gameId].salePrice)) {
          acc[gameId] = deal;
        }
        return acc;
      }, {})
    );

    // Add human-readable storeName
    uniqueDeals.forEach(d => {
      d.storeName = storeMap[d.storeID] || "Unknown";
    });

    cache[currency] = {
      timestamp: Date.now(),
      data: uniqueDeals
    };

    console.log(`Cache updated for ${currency} with ${uniqueDeals.length} deals`);
  } catch (err) {
    console.error(`Error fetching deals for ${currency}:`, err.message);
  }
}

/**
 * Pre-warm USD and CAD on startup
 */
async function preWarm() {
  await loadStores();
  await Promise.all(CURRENCIES.map(fetchDeals));
}

/**
 * Set up hourly update for USD and CAD
 */
setInterval(() => {
  CURRENCIES.forEach(fetchDeals);
}, CACHE_TTL);

/**
 * GET /deals
 * Optional query: ?currency=USD or CAD
 */
app.get("/deals", async (req, res) => {
  try {
    const currency = (req.query.currency || "USD").toUpperCase();

    if (!cache[currency]) {
      await fetchDeals(currency);
    }

    res.json({
      success: true,
      cached: true,
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
app.listen(PORT, async () => {
  console.log(`gaming-api running on port ${PORT}`);
  await preWarm();
});
