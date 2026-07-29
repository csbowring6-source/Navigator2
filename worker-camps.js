const ALLOWED_ORIGIN = "https://csbowring6-source.github.io";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-api-key, anthropic-version",
};

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function hav(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ═══ NSW FuelCheck ═══
let cachedToken = null;
let tokenExpiry = 0;

async function getNswToken(env) {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const basic = btoa(env.NSW_API_KEY + ":" + env.NSW_API_SECRET);
  const r = await fetch(
    "https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials",
    { headers: { Authorization: "Basic " + basic } }
  );
  const d = await r.json();
  cachedToken = d.access_token;
  tokenExpiry = Date.now() + 11 * 60 * 60 * 1000;
  return cachedToken;
}

function nswTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  let h = d.getUTCHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(h)}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${ap}`;
}

async function nswFuel(lat, lon, fueltype, radius, env) {
  const token = await getNswToken(env);
  const r = await fetch(
    "https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/prices/nearby",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: env.NSW_API_KEY,
        authorization: "Bearer " + token,
        transactionid: crypto.randomUUID(),
        requesttimestamp: nswTimestamp(),
      },
      body: JSON.stringify({
        fueltype, latitude: String(lat), longitude: String(lon),
        radius: String(radius), sortby: "price", sortascending: "true",
      }),
    }
  );
  const d = await r.json();
  const stations = {};
  (d.stations || []).forEach((s) => (stations[s.code] = s));
  return (d.prices || []).map((p) => {
    const s = stations[p.stationcode] || {};
    return {
      name: s.name || "Unknown", address: s.address || "",
      price: p.price, fueltype: p.fueltype,
      lat: s.location ? s.location.latitude : null,
      lon: s.location ? s.location.longitude : null,
      updated: p.lastupdated,
    };
  }).slice(0, 8);
}

// ═══ WA FuelWatch ═══
const WA_PRODUCT = { U91: 1, P95: 2, P98: 6, DL: 4, E10: 1 };
function xmlField(block, tag) {
  const m = block.match(new RegExp("<" + tag + ">([^<]*)</" + tag + ">"));
  return m ? m[1].trim() : "";
}
async function waFuel(lat, lon, fueltype) {
  const geo = await fetch(
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
    { headers: { "User-Agent": "NavigatorApp/1.0", "Accept-Language": "en" } }
  );
  const g = await geo.json();
  const suburb = (g.address && (g.address.suburb || g.address.town || g.address.city || g.address.village)) || "";
  if (!suburb) return [];
  const product = WA_PRODUCT[fueltype] || 1;
  const r = await fetch(
    `https://www.fuelwatch.wa.gov.au/fuelwatch/fuelWatchRSS?Product=${product}&Suburb=${encodeURIComponent(suburb)}&Surrounding=yes`,
    { headers: { "User-Agent": "NavigatorApp/1.0" } }
  );
  const xml = await r.text();
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const results = items.map((it) => ({
    name: xmlField(it, "trading-name"),
    address: xmlField(it, "address") + ", " + xmlField(it, "location"),
    price: parseFloat(xmlField(it, "price")), fueltype,
    lat: parseFloat(xmlField(it, "latitude")) || null,
    lon: parseFloat(xmlField(it, "longitude")) || null,
    updated: xmlField(it, "date"),
  }));
  results.sort((a, b) => a.price - b.price);
  return results.slice(0, 8);
}

// ═══ Informed Sources FPDAPI — QLD and SA ═══
const FPD_FUEL = { U91: 2, DL: 3, P95: 5, P98: 8, E10: 12 };
const FPD_REGION = { QLD: 1, SA: 4 };
const fpdCache = {};

async function fpdFuel(stateKey, base, token, lat, lon, fueltype, radiusKm) {
  const auth = { Authorization: "FPDAPI SubscriberToken=" + token, "Content-Type": "application/json" };
  const region = FPD_REGION[stateKey];
  const c = fpdCache[stateKey] || (fpdCache[stateKey] = { sites: null, sitesTs: 0, prices: null, pricesTs: 0 });
  if (!c.sites || Date.now() - c.sitesTs > 12 * 60 * 60 * 1000) {
    const r = await fetch(base + `/Subscriber/GetFullSiteDetails?countryId=21&geoRegionLevel=3&geoRegionId=${region}`, { headers: auth });
    const d = await r.json();
    c.sites = d.S || []; c.sitesTs = Date.now();
  }
  if (!c.prices || Date.now() - c.pricesTs > 6 * 60 * 1000) {
    const r = await fetch(base + `/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=${region}`, { headers: auth });
    const d = await r.json();
    const map = {};
    (d.SitePrices || []).forEach((p) => { map[p.SiteId + "_" + p.FuelId] = p; });
    c.prices = map; c.pricesTs = Date.now();
  }
  const fuelId = FPD_FUEL[fueltype] || 2;
  const results = [];
  for (const s of c.sites) {
    if (!s.Lat || !s.Lng) continue;
    const km = hav(lat, lon, s.Lat, s.Lng);
    if (km > radiusKm) continue;
    const p = c.prices[s.S + "_" + fuelId];
    if (!p || !p.Price) continue;
    const cpl = p.Price > 500 ? p.Price / 10 : p.Price;
    results.push({
      name: s.N || "Unknown", address: s.A || "",
      price: Math.round(cpl * 10) / 10, fueltype,
      lat: s.Lat, lon: s.Lng, updated: p.TransactionDateUtc || "",
    });
  }
  results.sort((a, b) => a.price - b.price);
  return results.slice(0, 8);
}

async function handleFuel(request, env) {
  const u = new URL(request.url);
  const lat = parseFloat(u.searchParams.get("lat"));
  const lon = parseFloat(u.searchParams.get("lon"));
  const fueltype = u.searchParams.get("type") || "U91";
  const radius = parseFloat(u.searchParams.get("radius") || "25");
  if (isNaN(lat) || isNaN(lon)) return jsonResp({ error: "lat and lon required" }, 400);
  let source, results;
  if (lon < 129) { source = "WA FuelWatch"; results = await waFuel(lat, lon, fueltype); }
  else if (lat <= -26 && lon <= 141) { source = "SA Fuel Pricing"; results = await fpdFuel("SA", "https://fppdirectapi-prod.safuelpricinginformation.com.au", env.SA_TOKEN, lat, lon, fueltype, Math.min(radius, 100)); }
  else if (lat >= -29) { source = "QLD Fuel Prices"; results = await fpdFuel("QLD", "https://fppdirectapi-prod.fuelpricesqld.com.au", env.QLD_TOKEN, lat, lon, fueltype, Math.min(radius, 100)); }
  else { source = "NSW FuelCheck"; results = await nswFuel(lat, lon, fueltype, radius, env); }
  return jsonResp({ source, fueltype, radiuskm: radius, results });
}

// ═══ OVERPASS — four mirrors, retries, and caching ═══
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const osmCache = new Map();
const OSM_TTL = 30 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Overpass is intermittently slow (2–12s) and sometimes 429/503s. The client aborts
// at 15s, so we CANNOT grind 4 mirrors at 12s each (up to 48s). Instead: short
// per-mirror timeout, retry a TRANSIENT failure once with backoff, fail over to the
// next mirror — all under a hard TOTAL deadline that fits the client budget. On a
// total miss, serve the stale in-memory copy; the caller adds a KV fallback on top.
const OVERPASS_MIRROR_MS = 6000;   // was 12000 — two mirrors now fit the 15s client budget
const OVERPASS_DEADLINE_MS = 13000;
async function overpass(q) {
  const key = q;
  const hit = osmCache.get(key);
  if (hit && Date.now() - hit.ts < OSM_TTL) return { data: hit.data, cached: true };

  const deadline = Date.now() + OVERPASS_DEADLINE_MS;
  let lastErr = "";
  for (const mirror of OVERPASS_MIRRORS) {
    for (let attempt = 0; attempt < 2; attempt++) {   // one retry per mirror for a transient blip
      const remaining = deadline - Date.now();
      if (remaining < 1200) { lastErr = lastErr || "deadline"; break; }   // out of budget — stop, serve stale
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.min(OVERPASS_MIRROR_MS, remaining));
        const r = await fetch(mirror, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "User-Agent": "NavigatorApp/1.0 (Australian road travel assistant)",
          },
          body: "data=" + encodeURIComponent(q),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        // Transient (busy/rate-limit) — back off and retry the SAME mirror once.
        if (r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504) {
          lastErr = "HTTP " + r.status + " from " + mirror;
          if (attempt === 0 && deadline - Date.now() > 1500) { await sleep(400); continue; }
          break;   // still busy — move to the next mirror
        }
        if (!r.ok) { lastErr = "HTTP " + r.status + " from " + mirror; break; }   // hard error — next mirror
        const data = await r.json();
        if (osmCache.size > 200) osmCache.clear();
        osmCache.set(key, { data, ts: Date.now() });
        return { data };
      } catch (e) {
        lastErr = (e.name === 'AbortError' ? 'timeout from ' : 'error from ') + mirror;
        break;   // timeout/network — next mirror (don't burn the budget retrying a dead endpoint)
      }
    }
    if (Date.now() > deadline) break;
  }
  if (hit) return { data: hit.data, cached: true, stale: true };   // stale in-memory copy beats a hard failure
  return { error: lastErr || "all mirrors failed" };
}

// Always sort by distance BEFORE truncating. When typeLabel is "" each result
// reports its REAL OSM tag — never claim a kebab shop is a cafe.
function osmPlacesNearest(elements, typeLabel, lat, lon, limit) {
  return (elements || [])
    .map((e) => {
      const t = e.tags || {};
      const plat = e.lat || (e.center && e.center.lat) || null;
      const plon = e.lon || (e.center && e.center.lon) || null;
      if (!plat || !plon) return null;
      const name = t.name || t.brand || "";
      if (!name) return null;
      return {
        name,
        type: typeLabel || t.amenity || t.leisure || t.shop || t.tourism || "",
        lat: plat, lon: plon,
        km: hav(lat, lon, plat, plon),
        osmid: (e.type || "node") + "/" + e.id,   // stable site id (for the phone-lookup cache key)
        tags: t,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.km - b.km)      // NEAREST FIRST — the whole point
    .slice(0, limit || 20);
}

// Each kind is an ARRAY of Overpass selectors, unioned in one query.
// cafe: genuine cafes + coffee shops + coffee-cuisine fast food (Zarraffa's
// style drive-throughs) — NOT general fast food or restaurants.
// food: the deliberate broad kind for "somewhere for dinner" requests.
const POI_KINDS = {
  gym:        ['["leisure"~"fitness_centre|sports_centre"]'],
  cafe:       ['["amenity"="cafe"]', '["shop"="coffee"]', '["amenity"="fast_food"]["cuisine"~"coffee_shop|coffee"]'],
  food:       ['["amenity"~"restaurant|fast_food"]'],
  supermarket:['["shop"~"supermarket|convenience"]'],
  pharmacy:   ['["amenity"="pharmacy"]'],
  pub:        ['["amenity"~"pub|bar"]'],
  bakery:     ['["shop"="bakery"]'],
  medical:    ['["amenity"~"hospital|clinic|doctors"]'],
  laundry:    ['["shop"~"laundry|dry_cleaning"]'],
  toilets:    ['["amenity"~"toilets|fuel|cafe|fast_food|restaurant|pub|bar"]'],
  atm:        ['["amenity"~"atm|bank"]'],
  mechanic:   ['["shop"~"car_repair|tyres"]'],
};

async function handlePoi(request) {
  const u = new URL(request.url);
  const lat = parseFloat(u.searchParams.get("lat"));
  const lon = parseFloat(u.searchParams.get("lon"));
  const kind = u.searchParams.get("kind") || "";
  const radiusKm = Math.min(parseInt(u.searchParams.get("radius") || "25"), 60);
  const sel = POI_KINDS[kind];
  if (isNaN(lat) || isNaN(lon)) return jsonResp({ error: "lat and lon required" }, 400);
  if (!sel) return jsonResp({ error: "unknown kind", kinds: Object.keys(POI_KINDS) }, 400);
  // Union all selectors for this kind into one query; ask for plenty —
  // we sort by distance ourselves, so more is better
  const parts = sel.map(s =>
    `node${s}(around:${radiusKm * 1000},${lat},${lon});way${s}(around:${radiusKm * 1000},${lat},${lon});`
  ).join("");
  const q = `[out:json][timeout:20];(${parts});out center tags 150;`;
  const res = await overpass(q);
  if (res.error) return jsonResp({ error: "poi lookup failed", detail: res.error, unavailable: true }, 503);
  // Empty label = every result carries its REAL OSM tag, not the requested kind
  const results = osmPlacesNearest(res.data.elements, "", lat, lon, 40)
    .map(p => ({ name: p.name, type: p.type, lat: p.lat, lon: p.lon }));
  return jsonResp({ source: "OpenStreetMap", kind, radiuskm: radiusKm, cached: !!res.cached, results });
}

async function handleCamps(request, env) {
  const u = new URL(request.url);
  const lat = parseFloat(u.searchParams.get("lat"));
  const lon = parseFloat(u.searchParams.get("lon"));
  const radiusKm = Math.min(parseInt(u.searchParams.get("radius") || "40"), 100);
  if (isNaN(lat) || isNaN(lon)) return jsonResp({ error: "lat and lon required" }, 400);
  const q = `[out:json][timeout:20];(node["tourism"~"camp_site|caravan_site"](around:${radiusKm*1000},${lat},${lon});way["tourism"~"camp_site|caravan_site"](around:${radiusKm*1000},${lat},${lon}););out center tags 150;`;
  // KV cache keyed by ROUNDED coords (~1km) + radius — camps don't move, so a
  // recent result is a fine answer when Overpass is having a bad minute.
  const kv = env && env.PLACES_KV;
  const ckey = `camps:${lat.toFixed(2)},${lon.toFixed(2)}:${radiusKm}`;
  const res = await overpass(q);
  if (res.error) {
    // Overpass is down/slow — serve the last-known result rather than failing outright.
    if (kv) {
      try { const c = await kv.get(ckey, { type: "json" }); if (c && c.results) return jsonResp({ source: "OpenStreetMap", radiuskm: radiusKm, cached: true, stale: true, results: c.results }); } catch (e) {}
    }
    return jsonResp({ error: "camps lookup failed", detail: res.error, unavailable: true }, 503);
  }
  const results = osmPlacesNearest(res.data.elements, "", lat, lon, 12).map(p => ({
    id: p.osmid,   // stable OSM id — the /place-phone cache key (never the name)
    name: p.name,
    type: p.tags.tourism === "caravan_site" ? "caravan park" : "camp site",
    lat: p.lat, lon: p.lon,
    fee: p.tags.fee || "", powered: p.tags.power_supply || "",
    dump: p.tags.sanitary_dump_station || "", toilets: p.tags.toilets || "",
    water: p.tags.drinking_water || "",
    // NEW: passed through so the app can offer a verified Call handoff and speak
    // real amenities. A tag OSM doesn't have stays "" — the app treats "" as
    // UNCONFIRMED, never as a yes or a no. Do not fabricate values here.
    phone: p.tags.phone || p.tags["contact:phone"] || "",
    internet_access: p.tags.internet_access || "",
    shower: p.tags.shower || "",
    swimming_pool: p.tags.swimming_pool || p.tags.pool || "",
  }));
  // Persist for the stale-fallback above (7-day TTL — camps don't move).
  if (kv && !res.cached) { try { await kv.put(ckey, JSON.stringify({ results, ts: Date.now() }), { expirationTtl: 7 * 24 * 3600 }); } catch (e) {} }
  return jsonResp({ source: "OpenStreetMap", radiuskm: radiusKm, cached: !!res.cached, results });
}

async function handleStations(request) {
  const u = new URL(request.url);
  const lat = parseFloat(u.searchParams.get("lat"));
  const lon = parseFloat(u.searchParams.get("lon"));
  const radiusKm = Math.min(parseInt(u.searchParams.get("radius") || "30"), 60);
  if (isNaN(lat) || isNaN(lon)) return jsonResp({ error: "lat and lon required" }, 400);
  const q = `[out:json][timeout:20];(node["amenity"="fuel"](around:${radiusKm*1000},${lat},${lon});way["amenity"="fuel"](around:${radiusKm*1000},${lat},${lon}););out center tags 150;`;
  const res = await overpass(q);
  if (res.error) return jsonResp({ error: "stations lookup failed", detail: res.error, unavailable: true }, 503);
  const results = osmPlacesNearest(res.data.elements, "", lat, lon, 30)
    .map(p => ({ name: p.name, brand: p.tags.brand || "", lat: p.lat, lon: p.lon }));
  return jsonResp({ source: "OpenStreetMap", radiuskm: radiusKm, cached: !!res.cached, results });
}

async function handleAccom(request) {
  const u = new URL(request.url);
  const lat = parseFloat(u.searchParams.get("lat"));
  const lon = parseFloat(u.searchParams.get("lon"));
  const radiusKm = Math.min(parseInt(u.searchParams.get("radius") || "30"), 60);
  if (isNaN(lat) || isNaN(lon)) return jsonResp({ error: "lat and lon required" }, 400);
  const q = `[out:json][timeout:20];(node["tourism"~"hotel|motel|hostel|guest_house|apartment"](around:${radiusKm*1000},${lat},${lon});way["tourism"~"hotel|motel|hostel|guest_house|apartment"](around:${radiusKm*1000},${lat},${lon}););out center tags 150;`;
  const res = await overpass(q);
  if (res.error) return jsonResp({ error: "accom lookup failed", detail: res.error, unavailable: true }, 503);
  const typeNames = { hotel:"hotel", motel:"motel", hostel:"backpackers/hostel", guest_house:"guest house", apartment:"apartment" };
  const results = osmPlacesNearest(res.data.elements, "", lat, lon, 15).map(p => ({
    name: p.name,
    type: typeNames[p.tags.tourism] || p.tags.tourism || "",
    stars: p.tags.stars || "",
    lat: p.lat, lon: p.lon,
  }));
  return jsonResp({ source: "OpenStreetMap", radiuskm: radiusKm, cached: !!res.cached, results });
}

async function handleWeather(request, env) {
  const u = new URL(request.url);
  const lat = parseFloat(u.searchParams.get("lat"));
  const lon = parseFloat(u.searchParams.get("lon"));
  if (isNaN(lat) || isNaN(lon)) return jsonResp({ error: "lat and lon required" }, 400);
  const r = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${env.WEATHER_KEY}&units=metric`);
  return new Response(r.body, { status: r.status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

// ═══ /place-phone verification helpers ══════════════════════════════════════
// Generic words carry no identity — two unrelated "caravan parks" share them all.
// Strip them so the name check turns on the DISTINCTIVE token (the town, the brand).
const PP_GENERIC = new Set(["caravan","van","vans","park","parks","tourist","holiday",
  "motel","camp","camps","camping","campground","campgrounds","site","sites","resort",
  "big4","top","the","and","of","a","at","on","in"]);
function ppTokens(s) {
  return (s || "").toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 2 && !PP_GENERIC.has(w));
}
// Distinctive tokens in common. Required, not advisory: a result that passes
// distance but shares no distinctive token (a "Beachcomber" restaurant beside the
// "Beachcomber" park) is rejected.
function ppNameOverlap(osmName, placeName) {
  const a = new Set(ppTokens(osmName)), b = new Set(ppTokens(placeName));
  let n = 0; for (const t of a) if (b.has(t)) n++;
  return n;
}
// Distance from a point to the park's ACTUAL EXTENT: 0 inside the bbox, else the
// great-circle distance to the nearest edge/corner (clamp the point to the box).
function ppDistToExtentKm(plat, plon, bb, clat, clon) {
  if (!bb) return hav(clat, clon, plat, plon);           // node — measure from the point
  const qlat = Math.max(bb.minlat, Math.min(plat, bb.maxlat));
  const qlon = Math.max(bb.minlon, Math.min(plon, bb.maxlon));
  return hav(plat, plon, qlat, qlon);
}
// locationBias radius (metres): a park-sized circle derived from the bbox (centre
// to a corner + margin, capped); a plain 1km for nodes with no extent.
function ppBiasRadiusM(bb, clat, clon) {
  if (!bb) return 1000;
  const cornerM = hav(clat, clon, bb.maxlat, bb.maxlon) * 1000;
  return Math.round(Math.min(Math.max(cornerM + 300, 800), 5000));
}
// The way/relation's bounding box, by OSM id. Nodes (points) return null. Any
// Overpass trouble returns null too, so the caller falls back to the radius guard.
async function ppOsmBbox(id) {
  const m = /^(way|relation)\/(\d+)$/.exec(id || "");
  if (!m) return null;                                   // a node has no extent
  try {
    const res = await overpass(`[out:json][timeout:20];${m[1]}(${m[2]});out bb;`);
    const b = res && res.data && res.data.elements && res.data.elements[0] && res.data.elements[0].bounds;
    if (b && typeof b.minlat === "number") return { minlat: b.minlat, minlon: b.minlon, maxlat: b.maxlat, maxlon: b.maxlon };
  } catch (e) {}
  return null;
}

// ═══ /place-phone — one campsite's phone number, ON REQUEST only ═════════════
// OSM rarely carries a phone tag, so the app asks here for a single named site
// (only AFTER an OSM phone tag has already been tried and missed — that check is
// on the frontend). Keyed on the OSM id; KV first, Google only on a miss. The
// number is BOUND to the id in the response so it can't attach to the wrong site.
// Wrong-number protection = TWO required gates: the Places pin must fall within
// the park's real extent (bbox + 500m of its edge, not a point in a paddock), AND
// its name must share a distinctive token with the OSM name. Fail either → none.
// ?debug=1 bypasses the cache and returns the full reasoning (no console on a phone).
async function handlePlacePhone(request, env) {
  const u = new URL(request.url);
  const id = u.searchParams.get("id") || "";          // OSM id — the cache key
  const name = u.searchParams.get("name") || "";
  const lat = parseFloat(u.searchParams.get("lat"));
  const lon = parseFloat(u.searchParams.get("lon"));
  const debug = u.searchParams.get("debug") === "1" || u.searchParams.get("diag") === "1";
  if (!id || !name || isNaN(lat) || isNaN(lon)) return jsonResp({ error: "id, name, lat and lon required" }, 400);

  const kv = env.PLACES_KV;
  const cacheKey = "phone:" + id;
  const dbg = { id, name, centre: { lat, lon }, textQuery: name };

  // KV FIRST — a cached hit OR miss without any Google call (no re-bill). Debug
  // skips the cache so the field tester always sees a live computation.
  if (kv && !debug) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
      if (cached) return jsonResp({ id, name, phone: cached.phone || "", found: !!cached.phone, cached: true });
    } catch (e) {}
  }
  if (!env.GOOGLE_PLACES_KEY) {
    const out = { id, name, phone: "", found: false, error: "place lookup not configured" };
    return jsonResp(debug ? { ...out, diag: { ...dbg, decision: "no GOOGLE_PLACES_KEY" } } : out);
  }

  // 1) The park's real extent (ways/relations); null for nodes -> radius guard.
  const bb = await ppOsmBbox(id);
  dbg.bbox = bb;
  const biasM = ppBiasRadiusM(bb, lat, lon);
  dbg.locationBiasRadiusM = biasM;

  // 2) Places (New) Text Search, biased to a park-sized circle.
  let places = [];
  try {
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_PLACES_KEY,
        "X-Goog-FieldMask": "places.id,places.displayName,places.nationalPhoneNumber,places.location",
      },
      body: JSON.stringify({
        textQuery: name,
        maxResultCount: 5,
        locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: biasM } },
      }),
    });
    if (r.ok) { const d = await r.json(); places = d.places || []; }
    else dbg.placesHttp = r.status;
  } catch (e) { dbg.placesError = String((e && e.message) || e); }

  // 3) Score every candidate: distance to the extent AND distinctive-name overlap.
  const scored = places.map(p => {
    const plat = p.location ? p.location.latitude : null, plon = p.location ? p.location.longitude : null;
    const distKm = (plat != null) ? ppDistToExtentKm(plat, plon, bb, lat, lon) : Infinity;
    const pname = (p.displayName && p.displayName.text) || "";
    const overlap = ppNameOverlap(name, pname);
    return {
      name: pname, lat: plat, lon: plon, phone: p.nationalPhoneNumber || "",
      distKm: Math.round(distKm * 1000) / 1000, nameOverlap: overlap,
      passDist: distKm <= 0.5, passName: overlap >= 1,
    };
  });
  dbg.places = scored;

  // 4) Pick: must pass BOTH gates and carry a phone; prefer the strongest name
  //    match, then the closest — so the park beats a same-name neighbour.
  const passing = scored.filter(s => s.passName && s.passDist && s.phone);
  passing.sort((a, b) => (b.nameOverlap - a.nameOverlap) || (a.distKm - b.distKm));
  const chosen = passing[0] || null;
  const phone = chosen ? chosen.phone : "";
  dbg.chosen = chosen ? { name: chosen.name, phone: chosen.phone, distKm: chosen.distKm, nameOverlap: chosen.nameOverlap } : null;
  dbg.decision = chosen ? "matched"
    : !places.length ? "no Places result"
    : scored.some(s => s.phone && s.passName && !s.passDist) ? "rejected: outside the park extent"
    : scored.some(s => s.phone && s.passDist && !s.passName) ? "rejected: name mismatch"
    : "no phone on any candidate";

  // 5) Cache (skipped in debug): 90 days for a hit, 7 for a miss (negative cache).
  if (kv && !debug) {
    try {
      await kv.put(cacheKey, JSON.stringify({ phone, ts: Date.now() }),
        { expirationTtl: phone ? 90 * 24 * 3600 : 7 * 24 * 3600 });
    } catch (e) {}
  }

  const out = { id, name, phone, found: !!phone, cached: false };
  return jsonResp(debug ? { ...out, diag: dbg } : out);
}

// ═══ TEMPORARY — /places-probe  (REMOVE AT PHASE 4) ══════════════════════════
// A raw window onto Google Places Text Search so a REAL regional-town query can be
// run with the EXACT production field mask and the result inspected before the
// Places-sourced camps architecture (phase 1) is built. Returns Google's JSON
// UNMODIFIED, no caching. Uses the GOOGLE_PLACES_KEY already configured.
//   GET /places-probe?q=caravan parks in Cardwell QLD        (text only)
//   GET /places-probe?q=caravan parks&lat=-18.26&lon=146.03  (adds a locationBias)
// The field mask below MUST stay identical to production: id, displayName,
// formattedAddress, location, nationalPhoneNumber, regularOpeningHours — no
// ratings/reviews/photos/editorial (those are a further SKU).
// >>> Listed for removal at phase 4 of the camps-architecture change. <<<
const PLACES_PROBE_FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.regularOpeningHours";
async function handlePlacesProbe(request, env) {
  const u = new URL(request.url);
  const q = u.searchParams.get("q") || "";
  if (!q) return jsonResp({ error: "q required — e.g. ?q=caravan parks in Cardwell QLD" }, 400);
  if (!env.GOOGLE_PLACES_KEY) return jsonResp({ error: "GOOGLE_PLACES_KEY not configured" }, 500);
  const lat = parseFloat(u.searchParams.get("lat"));
  const lon = parseFloat(u.searchParams.get("lon"));
  const body = { textQuery: q };
  if (!isNaN(lat) && !isNaN(lon)) body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius: 15000 } };
  try {
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_PLACES_KEY,
        "X-Goog-FieldMask": PLACES_PROBE_FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
    // Google's response, byte-for-byte, no caching, no wrapping.
    return new Response(r.body, {
      status: r.status,
      headers: { ...corsHeaders, "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    return jsonResp({ error: "probe fetch failed", detail: String((e && e.message) || e) }, 502);
  }
}

// ═══ Nominatim THROUGH the Worker — proper UA + bounded retry/backoff ════════
// The frontend used to call Nominatim direct from the browser, so a driver retrying
// got their PHONE rate-limited (~1 req/s per IP) and every lookup then failed. Here
// it's one identified IP with a KV cache, so the phone is never the throttled party.
async function nominatim(url) {
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {   // one retry on a transient blip
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, {
        headers: {
          "User-Agent": "NavigatorApp/1.0 (Australian road-trip assistant; csbowring6@gmail.com)",
          "Accept-Language": "en",
          "Referer": "https://csbowring6-source.github.io/Navigator2",
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504) {
        lastErr = "HTTP " + r.status; if (attempt === 0) { await sleep(500); continue; } break;
      }
      if (!r.ok) { lastErr = "HTTP " + r.status; break; }
      const ct = r.headers.get("content-type") || "";
      if (!/json/.test(ct)) { lastErr = "non-json (" + ct + ")"; break; }   // a rate-limit/block HTML page — NOT a no-match
      return { data: await r.json() };
    } catch (e) {
      lastErr = (e.name === "AbortError" ? "timeout" : "error") + ": " + ((e && e.message) || e);
      if (attempt === 0) { await sleep(400); continue; } break;
    }
  }
  return { error: lastErr || "geocoder failed" };
}

// ═══ /geocode — forward geocoding. q + optional limit / addr / lat,lon (+bounded)
// viewbox bias, so all four frontend call sites keep their behaviour. Returns the
// Nominatim ARRAY raw. KV keyed on the normalised query, 30-day TTL (towns don't
// move). A non-200 / non-JSON / network error surfaces as 502 so the app can tell
// "lookup failed" (transient) from "no match" (empty array) — never conflating them.
async function handleGeocode(request, env) {
  const u = new URL(request.url);
  const q = (u.searchParams.get("q") || "").trim();
  if (!q) return jsonResp({ error: "q required" }, 400);
  const limit = Math.min(Math.max(parseInt(u.searchParams.get("limit") || "1"), 1), 5);
  const addr = u.searchParams.get("addr") === "1";
  const lat = parseFloat(u.searchParams.get("lat"));
  const lon = parseFloat(u.searchParams.get("lon"));
  const bounded = u.searchParams.get("bounded") === "1";
  const vbd = Math.min(Math.max(parseFloat(u.searchParams.get("vbd")) || 1.1, 0.2), 10);   // viewbox half-size (deg)
  const hasBias = !isNaN(lat) && !isNaN(lon);
  const norm = q.toLowerCase().replace(/\s+/g, " ").trim();
  const ckey = `geo:${norm}|l${limit}|a${addr ? 1 : 0}` + (hasBias ? `|${lat.toFixed(2)},${lon.toFixed(2)}|b${bounded ? 1 : 0}|v${vbd}` : "");
  const kv = env && env.PLACES_KV;
  if (kv) { try { const c = await kv.get(ckey, { type: "json" }); if (c && c.data) return jsonResp({ cached: true, data: c.data }); } catch (e) {} }

  let url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=${limit}&countrycodes=au`;
  if (addr) url += "&addressdetails=1";
  if (hasBias) { const d = vbd; url += `&viewbox=${lon - d},${lat + d},${lon + d},${lat - d}`; if (bounded) url += "&bounded=1"; }

  const g = await nominatim(url);
  if (g.error) return jsonResp({ error: "geocoder unavailable", detail: g.error, unavailable: true }, 502);
  // Cache only a NON-EMPTY hit — a genuine empty stays cheap to re-query and a
  // transient empty can recover, never persisting a false "no match".
  if (kv && Array.isArray(g.data) && g.data.length) { try { await kv.put(ckey, JSON.stringify({ data: g.data, ts: Date.now() }), { expirationTtl: 30 * 24 * 3600 }); } catch (e) {} }
  return jsonResp({ cached: false, data: g.data });
}

// ═══ /reverse-geocode — position → place label. Same rate-limit exposure; shorter
// KV TTL (7 days) since a driver moves. Keyed on rounded coords + zoom.
async function handleReverseGeocode(request, env) {
  const u = new URL(request.url);
  const lat = parseFloat(u.searchParams.get("lat"));
  const lon = parseFloat(u.searchParams.get("lon"));
  if (isNaN(lat) || isNaN(lon)) return jsonResp({ error: "lat and lon required" }, 400);
  const zoom = u.searchParams.get("zoom") || "";
  const kv = env && env.PLACES_KV;
  const ckey = `rev:${lat.toFixed(3)},${lon.toFixed(3)}|z${zoom || "d"}`;
  if (kv) { try { const c = await kv.get(ckey, { type: "json" }); if (c && c.data) return jsonResp({ cached: true, data: c.data }); } catch (e) {} }
  let url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
  if (zoom) url += `&zoom=${encodeURIComponent(zoom)}`;
  const g = await nominatim(url);
  if (g.error) return jsonResp({ error: "geocoder unavailable", detail: g.error, unavailable: true }, 502);
  if (kv && g.data && !g.data.error) { try { await kv.put(ckey, JSON.stringify({ data: g.data, ts: Date.now() }), { expirationTtl: 7 * 24 * 3600 }); } catch (e) {} }
  return jsonResp({ cached: false, data: g.data });
}

// ═══ Worker build stamp — plain English, so the phone can check what's live ═══
const WORKER_BUILD = "Navigator Worker — 29 Jul 2026, 10:10 AM AEST (adds POST /log + GET /log/<id>: share a diagnostic voice log via KV, 7-day TTL, random id, no auth/listing)";

// Whisper biases decoding toward vocabulary supplied in `prompt`. Australian
// town names are exactly what it fumbles — "Cardwell" comes back "Cardwall",
// "Canungra" as "Kanungra", "Proserpine" as "Prosperine" — and a misheard town
// is a wrong trip. This is a HINT, not a whitelist: anything not listed still
// transcribes normally. Keep it well under Whisper's ~224-token prompt limit.
const PLACE_HINT = [
  "Australian road trip.",
  "Towns: Cairns, Cardwell, Tully, Innisfail, Townsville, Ingham, Mission Beach,",
  "Port Douglas, Mareeba, Atherton, Cooktown, Mackay, Proserpine, Airlie Beach,",
  "Bowen, Rockhampton, Gladstone, Bundaberg, Hervey Bay, Maryborough, Gympie,",
  "Noosa, Caloundra, Canungra, Boyland, Toowoomba, Warwick, Goondiwindi,",
  "Ballina, Byron Bay, Grafton, Coffs Harbour, Kempsey, Taree, Newcastle,",
  "Dubbo, Broken Hill, Wagga Wagga, Albury, Bendigo, Ballarat, Geelong,",
  "Mount Isa, Longreach, Charleville, Roma, Emerald, Barcaldine, Winton,",
  "Katherine, Alice Springs, Coober Pedy, Ceduna, Esperance, Kalgoorlie,",
  "Geraldton, Carnarvon, Broome, Kununurra, Derby, Exmouth.",
  "Caravan words: caravan park, powered site, dump point, free camp, rest area,",
  "showground, big rig, drive-through site, annexe, jockey wheel, servo, diesel.",
].join(" ");

function handleVersion() {
  return jsonResp({ version: WORKER_BUILD });
}

// ═══ POST /transcribe — audio blob in, { text } out ═══
// The phone's own speech recognition is unreliable in a noisy cab (SPEC §4), so
// the audio can be sent here instead. Key lives ONLY in env — never in the app.
async function handleTranscribe(request, env) {
  if (request.method !== "POST")
    return jsonResp({ error: "POST an audio blob to /transcribe" }, 405);
  if (!env.OPENAI_API_KEY)
    return jsonResp({ error: "Transcription isn't set up — the Worker has no OPENAI_API_KEY." }, 503);

  const type = (request.headers.get("content-type") || "").toLowerCase();
  const audio = await request.arrayBuffer();
  if (!audio || audio.byteLength < 1024)
    return jsonResp({ error: "No audio came through — nothing to transcribe." }, 400);

  // Name the part with an extension OpenAI recognises, matching what was sent.
  const isMp4 = type.includes("mp4") || type.includes("m4a") || type.includes("aac");
  const filename = isMp4 ? "audio.mp4" : "audio.webm";
  const blobType = isMp4 ? "audio/mp4" : "audio/webm";

  const form = new FormData();
  form.append("file", new Blob([audio], { type: blobType }), filename);
  form.append("model", "whisper-1");
  form.append("language", "en");
  form.append("prompt", PLACE_HINT);   // bias toward Australian town names

  let r;
  try {
    r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
    });
  } catch (e) {
    return jsonResp({ error: "Couldn't reach the transcription service — try again in a moment." }, 503);
  }
  if (!r.ok) {
    let detail = "";
    try { const e = await r.json(); detail = (e && e.error && e.error.message) || ""; } catch (_) {}
    return jsonResp({ error: "Transcription failed" + (detail ? ": " + detail : "."), status: r.status }, 502);
  }
  let data;
  try { data = await r.json(); } catch (e) {
    return jsonResp({ error: "Transcription service sent back something unreadable." }, 502);
  }
  const text = (data && typeof data.text === "string") ? data.text.trim() : "";
  if (!text) return jsonResp({ error: "Nothing was heard in that audio.", text: "" }, 200);
  return jsonResp({ text });
}

// ═══ POST /log  — stash a voice log for a remote helper; GET /log/<id> reads it ═══
// Short-lived DIAGNOSTIC text only. No auth, no listing endpoint: the id is a random
// 7-char token (unguessable enough for a throwaway log) and the content carries no
// credentials (the frontend holds none) and no transcript text — the voice log is
// event kinds + status tokens only (open/state/deliver:basic:silence/close reasons/
// classify results), never a spoken phrase or place name. 7-day TTL, then it's gone.
const LOG_MAX = 64 * 1024;                 // ~64 KB cap
const LOG_TTL = 7 * 24 * 3600;             // 7 days
const LOG_ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";   // no 0/O/1/I — reads cleanly aloud
function makeLogId(n) {
  const buf = new Uint8Array(n); crypto.getRandomValues(buf);
  let s = ""; for (let i = 0; i < n; i++) s += LOG_ID_ALPHABET[buf[i] % LOG_ID_ALPHABET.length];
  return s;
}
async function handleLogPost(request, env) {
  if (request.method !== "POST") return jsonResp({ error: "POST the log text to /log" }, 405);
  const kv = env && env.PLACES_KV;
  if (!kv) return jsonResp({ error: "Log sharing isn't set up — the Worker has no KV." }, 503);
  const text = await request.text();
  if (!text || !text.trim()) return jsonResp({ error: "No log text came through." }, 400);
  if (text.length > LOG_MAX) return jsonResp({ error: "Log too large to share (max 64 KB)." }, 413);
  const id = makeLogId(7);
  try { await kv.put("log:" + id, text, { expirationTtl: LOG_TTL }); }
  catch (e) { return jsonResp({ error: "Couldn't store the log — try again." }, 503); }
  return jsonResp({ id });
}
function logTextResp(body, status) {
  return new Response(body, { status: status || 200, headers: { ...corsHeaders, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
async function handleLogGet(id, env) {
  if (!/^[A-Za-z0-9]{4,16}$/.test(id || "")) return logTextResp("Log not found.", 404);   // guard the KV key
  const kv = env && env.PLACES_KV;
  if (!kv) return logTextResp("Log sharing isn't set up.", 503);
  let text = null;
  try { text = await kv.get("log:" + id); } catch (e) {}
  if (text == null) return logTextResp("Log not found or expired.", 404);
  return logTextResp(text, 200);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    // GET /log/<id> — dynamic path, so it can't sit in the exact-match table below.
    if (url.pathname.startsWith("/log/")) return handleLogGet(url.pathname.slice(5), env);
    const routes = {
      "/fuel": () => handleFuel(request, env),
      "/poi": () => handlePoi(request),
      "/camps": () => handleCamps(request, env),
      "/stations": () => handleStations(request),
      "/accom": () => handleAccom(request),
      "/weather": () => handleWeather(request, env),
      "/transcribe": () => handleTranscribe(request, env),
      "/place-phone": () => handlePlacePhone(request, env),
      "/geocode": () => handleGeocode(request, env),
      "/reverse-geocode": () => handleReverseGeocode(request, env),
      "/places-probe": () => handlePlacesProbe(request, env),   // TEMPORARY — remove at phase 4
      "/log": () => handleLogPost(request, env),                // share a voice log; GET /log/<id> handled above
      "/version": () => handleVersion(),
    };
    if (routes[url.pathname]) {
      try { return await routes[url.pathname](); }
      catch (e) { return jsonResp({ error: url.pathname.slice(1) + " lookup failed", unavailable: true }, 503); }
    }
    const body = await request.text();
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  },
};
