import express from "express";
import axios from "axios";

const app = express();

// In-memory cache per currency
let cache = {};
const CACHE_TTL = 1000 * 60 * 60; // 1 hour
const CURRENCIES = ["USD", "CAD"];
const DEFAULT_STORES = ["steam", "humble store", "fanatical"].map(s => s.toLowerCase().trim());

const STORE_PRIORITY = {
  "steam": 1,
  "humble store": 2,
  "fanatical": 3
};
let storeMap = {};
let defaultStoreIDs = [];

/**
 * Load storeID -> storeName map
 */
async function loadStores() {
  try {
    const res = await axios.get("https://www.cheapshark.com/api/1.0/stores");
    storeMap = Object.fromEntries(
      res.data.map(s => [s.storeID, s.storeName.toLowerCase().trim()])
    );
    console.log("Store map loaded:", Object.keys(storeMap).length, "stores");

    defaultStoreIDs = Object.entries(storeMap)
      .filter(([id, name]) => DEFAULT_STORES.includes(name))
      .map(([id]) => id);
    
    console.log("Default store IDs:", defaultStoreIDs);

  } catch (err) {
    console.error("Error loading stores:", err.message);
  }
}

/**
 * Fetch deals from CheapShark (multiple pages) and store in cache
 */
async function fetchDeals(currency, storeIDs) {
  if (!Array.isArray(storeIDs)) {
    console.error("fetchDeals called without a valid storeIDs array!");
    return;
  }

  if (storeIDs.length === 0) {
    console.error("fetchDeals aborted: no valid storeIDs found");
    return;
  }
  
  try {
    let page = 0;
    const uniqueGames = {};
    const pagesFetched = [];

    // Keep fetching until we have 100 unique games or 10 pages max
    while (Object.keys(uniqueGames).length < 100 && page < 50) {
      const response = await axios.get("https://www.cheapshark.com/api/1.0/deals", {
        params: {
          pageSize: 100,
          pageNumber: page,
          cc: currency,
          storeID: storeIDs.join(",")
        }
      });
    
      let newDealsThisPage = 0;
    
      for (const deal of response.data) {
        deal.storeName = storeMap[deal.storeID] || "unknown";
    
        // Skip deals without Steam App ID
        if (!deal.steamAppID) continue;
    
        const gameId = deal.gameID;
        const current = uniqueGames[gameId];
        const dealStore = deal.storeName.toLowerCase();
        const dealPrice = parseFloat(deal.salePrice);
    
        if (!STORE_PRIORITY[dealStore]) continue;
    
        if (!current) {
          uniqueGames[gameId] = deal;
          newDealsThisPage++;
          continue;
        }
    
        const currentStore = current.storeName.toLowerCase();
        const currentPrice = parseFloat(current.salePrice);
    
        if (dealPrice < currentPrice) {
          uniqueGames[gameId] = deal;
          continue;
        }
    
        if (dealPrice === currentPrice) {
          const dealPrio = STORE_PRIORITY[dealStore];
          const currentPrio = STORE_PRIORITY[currentStore];
          if (dealPrio < currentPrio) uniqueGames[gameId] = deal;
        }
      }
    
      pagesFetched.push({ page: page + 1, dealsFetched: newDealsThisPage });
    
      page++;
    }

    // Convert to array and trim to exactly 100 unique games (safety)
    const uniqueDeals = Object.values(uniqueGames).slice(0, 100);

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
   
  await Promise.all(CURRENCIES.map(currency => fetchDeals(currency, defaultStoreIDs)));
}

/**
 * Set up hourly update for USD and CAD
 */
setInterval(() => {
  CURRENCIES.forEach(currency => fetchDeals(currency, defaultStoreIDs));
}, CACHE_TTL);

/**
 * GET /deals
 * Optional query: ?currency=USD or CAD
 */
app.get("/deals", async (req, res) => {
  try {
    const currency = (req.query.currency || "USD").toUpperCase();

    const entry = cache[currency];
    const isExpired = !entry || (Date.now() - entry.timestamp > CACHE_TTL);
    const wasCached = !!entry && !isExpired;

    if (isExpired) {
      await fetchDeals(currency, defaultStoreIDs);
    }

    res.json({
      success: true,
      cached: wasCached,
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
