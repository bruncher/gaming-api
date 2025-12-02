import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
const allowedOrigins = ["https://bruncher.github.io", "http://localhost:3000"];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn("Blocked CORS request from:", origin);
      callback(new Error("Not allowed by CORS"));
    }
  }
}));

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
    while (Object.keys(uniqueGames).length < 1000 && page < 100) {
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
    const uniqueDeals = Object.values(uniqueGames);

    // Reattach previously cached Steam metadata
    for (const deal of uniqueDeals) {
      const id = String(deal.steamAppID);
      if (steamMetaCache[id] !== undefined) {
        deal.steamMeta = steamMetaCache[id];
      } else {
        deal.steamMeta = null; // placeholder until enrichment fills it
      }
    }

    const newBlock = {
      timestamp: Date.now(),
      data: uniqueDeals
    };
    
    // Atomic swap — ensures no partial metadata window
    cache[currency] = newBlock;

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

// Global cache for Steam metadata
const steamMetaCache = {};

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
      fetchDeals(currency, defaultStoreIDs).catch(console.error);
    }

    res.json({
      success: true,
      cached: wasCached,
      currency,
      count: entry ? entry.data.length : 0,
      deals: entry ? entry.data : []
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "gaming-api live" });
});

app.get("/debug/cache", (req, res) => {
  res.json({
    usd: cache.USD?.data.length || 0,
    cad: cache.CAD?.data.length || 0,
    steamMetaCount: Object.keys(steamMetaCache).length
  });
});

app.get("/ping", (req, res) => {
  res.json({ status: "alive", time: Date.now() });
});

// ==========================
// Revised Steam enrichment
// ==========================
async function enrichWithSteamData(deals) {
  // Deduplicate by Steam ID
  const seen = new Set();
  const steamDeals = deals.filter(d => {
    if (!d.steamAppID) return false;
    const id = String(d.steamAppID);
    if (seen.has(id)) return false;
    seen.add(id);
    return steamMetaCache[id] === undefined || steamMetaCache[id] === null;
  });

  if (steamDeals.length === 0) {
    console.log("Steam enrichment: nothing to enrich, all metadata already cached.");
    return;
  }
  
  console.log(`Steam enrichment: ${steamDeals.length} new or missing metadata items.`);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let enrichedCount = 0;

  for (const deal of steamDeals) {
    const id = String(deal.steamAppID);

    // Skip if cached with real data
    if (steamMetaCache[id] !== undefined && steamMetaCache[id] !== null) {
      deal.steamMeta = steamMetaCache[id];
      enrichedCount++;
      if (enrichedCount % 5 === 0 || enrichedCount === steamDeals.length) {
        console.log(`Enriched Steam metadata (cached): ${enrichedCount}/${steamDeals.length}`);
      }
      continue;
    }

    // Retry logic for 429 with soft max attempts
    let attempts = 0;
    const MAX_ATTEMPTS = 30;
    let done = false;
    
    while (!done && attempts < MAX_ATTEMPTS) {
      attempts++;
      try {
        const res = await axios.get(
          "https://store.steampowered.com/api/appdetails",
          { params: { appids: id, l: "en", cc: "us" }, timeout: 6000 }
        );
    
        const info = res.data[id];
        if (!info || !info.success) {
          deal.steamMeta = null;
        } else {
          const data = info.data;
          const date = data.release_date?.date;
          deal.steamMeta = {
            name: data.name,
            release_date: date || null,
            year: date && /\d{4}/.test(date) ? date.match(/\d{4}/)[0] : null,
            genres: data.genres?.map(g => g.description) || [],
            publishers: data.publishers || [],
            rating: data.metacritic?.score || null
          };
        }
    
        steamMetaCache[id] = deal.steamMeta;

        // Also update current deals inside both USD and CAD caches
        for (const currency of CURRENCIES) {
          const cur = cache[currency];
          if (!cur || !cur.data) continue;
        
          const match = cur.data.find(d => String(d.steamAppID) === id);
          if (match) {
            match.steamMeta = deal.steamMeta;
          }
        }
        done = true;
    
        if (attempts > 1) {
          console.log(`✅ Steam app ${id} succeeded after ${attempts} attempts (backoff completed)`);
        }
    
      } catch (err) {
        const status = err.response?.status;
      
        if (status === 429 || status === 403) {
          // exponential backoff for both 429 and 403
          const delay = Math.min(30000, 1000 * Math.pow(2, attempts));
          console.warn(`${status} for ${id}, retrying in ${delay}ms (attempt ${attempts})`);
          await sleep(delay);
          // do not set done = true; retry will continue
        } else {
          console.error(`Steam meta error for ${id}:`, err.message);
          deal.steamMeta = null;
          steamMetaCache[id] = null;
          done = true; // stop retries for other errors
        }
      }
    }
    
    if (!done) {
      console.warn(`Max attempts reached for ${id}, skipping...`);
    }

    enrichedCount++;
    if (enrichedCount % 5 === 0 || enrichedCount === steamDeals.length) {
      console.log(`Enriched Steam metadata: ${enrichedCount}/${steamDeals.length}`);
    }

    await sleep(150); // throttle normal requests
  }

  console.log(`Finished enriching Steam data: ${enrichedCount}/${steamDeals.length} deals`);
}


const PORT = process.env.PORT || 3000;
(async () => {
  console.log("Starting server… loading stores and warming cache…");

  await preWarm(); // fetch CheapShark deals
  console.log("Warmup complete.");
  
  // Start Steam enrichment asynchronously (does NOT block server start)
  const allDeals = [
    ...(cache["USD"]?.data || []),
    ...(cache["CAD"]?.data || [])
  ];
  if (allDeals.length > 0) {
    enrichWithSteamData(allDeals).catch(err => console.error("Initial Steam enrichment failed:", err));
  }
  
  app.listen(PORT, () => {
    console.log(`gaming-api running on port ${PORT}`);
  });

  // Periodic status update
  setInterval(() => {
    const usdCount = cache.USD?.data.length || 0;
    const cadCount = cache.CAD?.data.length || 0;
    console.log(`Status update: USD deals ${usdCount}, CAD deals ${cadCount}, Steam cache ${Object.keys(steamMetaCache).length}`);
  }, 60 * 60 * 1000); // every hour

})();

// ==========================
// Run enrichment once per day
// ==========================
setInterval(() => {
  const combined = [
    ...(cache["USD"]?.data || []),
    ...(cache["CAD"]?.data || [])
  ];

  if (combined.length > 0) {
    enrichWithSteamData(combined).catch(console.error);
  }
}, 24 * 60 * 60 * 1000); // daily
