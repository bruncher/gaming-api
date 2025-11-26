import express from "express";
import axios from "axios";

const app = express();

// In-memory cache per currency
let cache = {};
const CACHE_TTL = 1000 * 60 * 60; // 1 hour
const CURRENCIES = ["USD", "CAD"];
const DEFAULT_STORES = ["steam", "humble store", "fanatical", "gog"];
let storeMap = {};

/**
 * Load storeID -> storeName map
 */
async function loadStores() {
  try {
    const res = await axios.get("https://www.cheapshark.com/api/1.0/stores");
    storeMap = Object.fromEntries(res.data.map(s => [s.storeID, s.storeName]));
    console.log("Store map loaded:", Object.keys(storeMap).length, "stores");
  } catch (err) {
    console.error("Error loading stores:", err.message);
  }
}

/**
 * Fetch deals from CheapShark (multiple pages) and store in cache
 */
async function fetchDeals(currency) {
  try {
    let page = 0;
    const uniqueGames = {};
    const pagesFetched = [];

    // Keep fetching until we have 100 unique games or 10 pages max
    while (page < 10) {
      const response = await axios.get("https://www.cheapshark.com/api/1.0/deals", {
        params: { pageSize: 100, pageNumber: page, cc: currency }
      });

      let newDealsThisPage = 0;

      for (const deal of response.data) {
        // Add human-readable storeName
        deal.storeName = storeMap[deal.storeID] || "Unknown";
    
        // Skip deal if store is not in default stores
        if (!DEFAULT_STORES.includes(deal.storeName.toLowerCase())) continue;
    
        const gameId = deal.gameID;
        // Keep cheapest deal per game
        if (!uniqueGames[gameId] || parseFloat(deal.salePrice) < parseFloat(uniqueGames[gameId].salePrice)) {
            uniqueGames[gameId] = deal;
            newDealsThisPage++;
        }
    
        // Stop immediately if we hit 100 unique games
        if (Object.keys(uniqueGames).length >= 100) break;
    }

      pagesFetched.push({ page: page + 1, dealsFetched: newDealsThisPage });

      // Stop fetching more pages if we hit 100 unique games
      if (Object.keys(uniqueGames).length >= 100) break;

      page++;
    }

    // Convert to array and trim to exactly 100 unique games (safety)
    const uniqueDeals = Object.values(uniqueGames).slice(0, 100);

    // Add human-readable storeName
    uniqueDeals.forEach(d => {
      d.storeName = storeMap[d.storeID] || "Unknown";
    });

    cache[currency] = {
      timestamp: Date.now(),
      data: uniqueDeals
    };

    console.log(`Cache updated for ${currency} with ${uniqueDeals.length} unique deals`);
    console.log(`Pages fetched:`, pagesFetched);

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
