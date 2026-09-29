const ALLOWED_ORIGIN = "https://csbowring6-source.github.io";

// ═══ ORIGIN GATE (SECURE) ═══
// Every route except /version and GET /log/<id> is reachable ONLY from the app's
// own origin (GitHub Pages) or a local dev server. Anything else — a different
// origin, or NO Origin header (curl, scripts, a pasted URL) — gets a 403 before any
// paid service (Anthropic, OpenAI, Places, the fuel feeds) is touched. CORS headers
// echo the matched origin (never "*"), so localhost on any port works for testing.
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
function allowedOrigin(request) {
  const o = request.headers.get("Origin") || "";
  return (o === ALLOWED_ORIGIN || LOCAL_ORIGIN.test(o)) ? o : null;
}
// Exempt from the gate: read-only, free, and opened as a plain navigation (no Origin).
function originExempt(request, url) {
  if (url.pathname === "/version") return true;
  return request.method === "GET" && url.pathname.startsWith("/log/");
}
// Stamp the matched origin onto a handler's response (all responses here are built
// with `new Response`, so a copy with mutable headers is cheap and safe).
function withOrigin(res, origin) {
  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin", origin);
  out.headers.set("Vary", "Origin");
  return out;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,   // default; withOrigin() overrides per request
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

// ═══ OVERPASS — verified mirror pool, raced in pairs, and caching ═══
// Pool refreshed 07 Aug 2026 (MIRROR-POOL): every slot verified live with the real
// AU camps query — a mirror earns its place only by returning Australian ELEMENTS,
// never by a bare 200 (overpass.osm.ch answers 200 with zero AU elements; regional
// instances must never slip in). Dropped: kumi.systems (flapping), private.coffee
// (dead), osm.jp candidate (expired cert). Ordered by measured health on the day;
// overpass-api.de kept last as the canonical anchor despite 504ing on verification day.
const OVERPASS_MIRRORS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

const osmCache = new Map();
const OSM_TTL = 30 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Overpass mirrors are individually flaky (2–12s, 429/503s, whole instances vanish —
// field 07 Aug: three of four dead left the pool ONE deep, so a single 504 blip of the
// survivor burned the 13s budget serially and failed the ask). So: RACE mirrors in
// PAIRS — fire the top two together, the first good answer wins, a mirror's failure
// only costs anything if its partner fails too; then the next pair — all under the
// same hard TOTAL deadline that fits the client's 15s abort. On a total miss, serve
// the stale in-memory copy; the caller adds a KV fallback on top (7-day heal).
const OVERPASS_MIRROR_MS = 6000;   // per-attempt cap — a lost racer aborts itself here
const OVERPASS_DEADLINE_MS = 13000;

// One attempt against one mirror: resolves with parsed JSON, or throws with the same
// mirror-tagged reason strings the routes have always surfaced in their 503 detail
// ("timeout from URL" / "HTTP 429 from URL" / "error from URL").
async function overpassAttempt(mirror, q, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(mirror, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "User-Agent": "NavigatorApp/1.0 (Australian road travel assistant)",
      },
      body: "data=" + encodeURIComponent(q),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("HTTP " + r.status + " from " + mirror);
    return await r.json();
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("timeout from " + mirror);
    if (e && /^HTTP \d/.test(e.message || "")) throw e;
    throw new Error("error from " + mirror);
  } finally {
    clearTimeout(timer);
  }
}

// `deadlineMs` (optional) shortens the TOTAL budget for one caller — /stay passes ~6 s
// so one slow mirror pair can't hold a many-anchor request to the 13 s default.
async function overpass(q, deadlineMs) {
  const key = q;
  const hit = osmCache.get(key);
  if (hit && Date.now() - hit.ts < OSM_TTL) return { data: hit.data, cached: true };

  const deadline = Date.now() + (deadlineMs || OVERPASS_DEADLINE_MS);
  let lastErr = "";
  for (let i = 0; i < OVERPASS_MIRRORS.length; i += 2) {
    const remaining = deadline - Date.now();
    if (remaining < 1200) { lastErr = lastErr || "deadline"; break; }   // out of budget — stop, serve stale
    const pair = OVERPASS_MIRRORS.slice(i, i + 2);
    try {
      const data = await Promise.any(pair.map((m) => overpassAttempt(m, q, Math.min(OVERPASS_MIRROR_MS, remaining))));
      if (osmCache.size > 200) osmCache.clear();
      osmCache.set(key, { data, ts: Date.now() });
      return { data };
    } catch (agg) {
      // Every mirror in the pair failed — keep BOTH tagged reasons, move to the next pair.
      lastErr = ((agg && agg.errors) || [agg]).map((e) => (e && e.message) || String(e)).join("; ");
    }
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
    id: p.osmid,   // stable OSM id (never the name)
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

// ═══ /camps2 — PLACES-BACKED CAMPS (camps architecture, phase 1 — ADDITIVE) ═══
// Google Places (New) Text Search for caravan parks + camps near lat/lon. The app
// /camps stays as the frontend's Places-down fallback ONLY (phase 4 done). Records are normalised to the OSM /camps site-record shape (id, name,
// type, lat, lon, phone) PLUS hours, tagged source:"places", so later phases merge
// without rework. NOT filtered to commercial parks — free camps appear in Places (the
// Hughenden probe proved it) and are kept. KV cache on rounded coords + radius, 30-day
// TTL (parks don't move). Its own field-mask const (NOT the temporary probe's, which
// is scheduled for removal at phase 4).
//
// FIELD MASK — EXACTLY the approved set: id, displayName, formattedAddress, location,
// nationalPhoneNumber, regularOpeningHours. Nothing more — ratings/reviews/photos are
// a higher SKU and are forbidden.
const CAMPS2_FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.regularOpeningHours";
// The lookup itself, shared by /camps2 and /stay (STAY): returns { results, cached } or
// { errResp } — the exact error Response the route has always sent. One KV cache.
async function placesCamps(lat, lon, radiusKm, env) {
  if (!env.GOOGLE_PLACES_KEY) return { errResp: jsonResp({ error: "places camps not configured — no GOOGLE_PLACES_KEY", unavailable: true }, 503) };

  // KV cache keyed on ROUNDED coords (~1km) + radius, 30-day TTL — caravan parks don't
  // move. Distinct "camps2:" prefix so it never collides with the OSM "camps:" cache.
  const kv = env && env.PLACES_KV;
  const ckey = `camps2:${lat.toFixed(2)},${lon.toFixed(2)}:${radiusKm}`;
  if (kv) {
    try { const c = await kv.get(ckey, { type: "json" }); if (c && c.results) return { results: c.results, cached: true }; } catch (e) {}
  }

  // Places (New) Text Search, biased to a circle around the driver. maxResultCount 20
  // (the API ceiling); circle radius capped at Places' 50 km limit. No commercial-only
  // filter — keep free camps too.
  let d = null;
  try {
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_PLACES_KEY,
        "X-Goog-FieldMask": CAMPS2_FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: "caravan parks and camping grounds",
        maxResultCount: 20,
        locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: Math.min(radiusKm * 1000, 50000) } },
      }),
    });
    if (!r.ok) {
      let detail = ""; try { const e = await r.json(); detail = (e && e.error && e.error.message) || ""; } catch (_) {}
      return { errResp: jsonResp({ error: "places camps lookup failed", status: r.status, detail, unavailable: true }, 502) };
    }
    try { d = await r.json(); } catch (e) { return { errResp: jsonResp({ error: "places sent back something unreadable", unavailable: true }, 502) }; }
  } catch (e) {
    return { errResp: jsonResp({ error: "couldn't reach Places", detail: String((e && e.message) || e), unavailable: true }, 503) };
  }
  if (!d || typeof d !== "object") return { errResp: jsonResp({ error: "places sent back something unreadable", unavailable: true }, 502) };

  // Zero results is a valid, honest answer (Places returns {} — no `places`), NOT an
  // error. Normalise each place; drop any without a usable location or name.
  const places = Array.isArray(d.places) ? d.places : [];
  const results = places.map((p) => {
    const loc = p.location || {};
    const plat = (typeof loc.latitude === "number") ? loc.latitude : null;
    const plon = (typeof loc.longitude === "number") ? loc.longitude : null;
    if (plat == null || plon == null) return null;
    const name = (p.displayName && p.displayName.text) || "";
    if (!name) return null;
    return {
      id: p.id || "",                                  // stable Places id (phase-3 merge/dedup key)
      name,
      type: "caravan park",                            // Places doesn't split park/camp; app treats generically
      lat: plat, lon: plon,
      km: hav(lat, lon, plat, plon),                   // for the nearest-first sort below (dropped from output)
      address: p.formattedAddress || "",
      phone: p.nationalPhoneNumber || "",
      hours: (p.regularOpeningHours && p.regularOpeningHours.weekdayDescriptions) || null,
      source: "places",
    };
  }).filter(Boolean).sort((a, b) => a.km - b.km).map(({ km, ...rec }) => rec);   // nearest first, km not emitted (mirrors /camps)

  if (kv) { try { await kv.put(ckey, JSON.stringify({ results, ts: Date.now() }), { expirationTtl: 30 * 24 * 3600 }); } catch (e) {} }
  return { results, cached: false };
}
async function handleCamps2(request, env) {
  const u = new URL(request.url);
  const lat = parseFloat(u.searchParams.get("lat"));
  const lon = parseFloat(u.searchParams.get("lon"));
  const radiusKm = Math.min(parseInt(u.searchParams.get("radius") || "40"), 100);
  if (isNaN(lat) || isNaN(lon)) return jsonResp({ error: "lat and lon required" }, 400);
  const r = await placesCamps(lat, lon, radiusKm, env);
  if (r.errResp) return r.errResp;
  return jsonResp({ source: "places", radiuskm: radiusKm, cached: r.cached, results: r.results });
}

// ═══ /camps2-osm — FILTERED OSM CAMPS (camps architecture, phase 2 — ADDITIVE) ═══
// Overpass camp/caravan sites + rest areas near lat/lon, returning ONLY the
// NON-COMMERCIAL category Places lacks — free camps, bush camps, rest areas. The app
// /camps stays as the frontend's Places-down fallback ONLY (phase 4 done). Reuses the shared overpass() (mirrors/retry/backoff,
// in-memory cache) and osmPlacesNearest() — no duplication, /camps unaffected. Records
// mirror the /camps2 shape (id,name,type,lat,lon,address,phone,hours) tagged
// source:"osm". KV on rounded coords + radius, 7-day TTL (OSM moves more than Google's).
//
// CLASSIFICATION (commercial vs non-commercial), tag-driven, biased to INCLUDE when
// ambiguous — a free camp wrongly dropped is worse than a commercial park wrongly kept
// (phase 3 dedupes the overlap against Places):
//   INCLUDE if  fee explicitly free (no/none/free/0)      — a free site
//           OR  highway=rest_area                          — a roadside rest area
//           OR  backcountry=yes                            — a bush/backcountry camp
//   EXCLUDE if  a COMMERCIAL NAME (caravan/holiday/tourist park, cabins, resort, motel,
//               villas) — commercial even with no fee tag; belongs to the Places side
//           OR  fee=yes / a charge tag                     — a paid site
//           OR  tourism=caravan_site (not marked free)     — the commercial van-park category
//   otherwise INCLUDE (an untagged tourism=camp_site is ambiguous → keep it).
// Edge cases: a rest area is non-commercial even if it carries a nominal fee (the
// rest_area/free/backcountry signals are checked BEFORE the paid signal); a caravan_site
// marked fee=no is kept (explicitly free); access=private is NOT currently filtered
// (rare, and the include-bias favours surfacing it).
function campFee(tags) { return String((tags && tags.fee) || "").toLowerCase(); }
// A NAME that says commercial — a caravan/holiday/tourist park, cabins, resort, motel or
// villas — is commercial even with NO fee tag (field 30 Jul: "Etty Bay Cabins and Caravan
// Park" was tagged tourism=camp_site with no fee, so the ambiguity-include wrongly kept it
// as a free camp). Such a site belongs to the Places side, which carries its number. Rest
// areas, pubs/hotels/showgrounds and plainly-named camp grounds don't carry these words.
const COMMERCIAL_NAME = /\b(caravan\s*park|holiday\s*park|tourist\s*park|cabins?|resort|motel|villas?)\b/i;
function isNonCommercialCamp(tags) {
  const t = tags || {};
  const fee = campFee(t);
  if (fee === "no" || fee === "none" || fee === "free" || fee === "0") return true;   // explicitly free
  if (t.highway === "rest_area") return true;                                          // rest area (name check N/A)
  if (String(t.backcountry || "").toLowerCase() === "yes") return true;                // bush/backcountry camp
  if (COMMERCIAL_NAME.test(String(t.name || ""))) return false;                        // NAME says commercial → belongs to Places, exclude
  if (fee === "yes" || fee === "true" || (t.charge != null && t.charge !== "")) return false;   // paid
  if (t.tourism === "caravan_site") return false;   // commercial van-park category (deduped vs Places in phase 3)
  return true;                                       // ambiguous camp_site → INCLUDE (bias)
}
function osmCampType(tags) {
  const t = tags || {};
  if (t.highway === "rest_area") return "rest area";
  if (t.tourism === "caravan_site") return "caravan park";
  return "camp site";
}
function osmAddress(t) {
  if (!t) return "";
  return [((t["addr:housenumber"] ? t["addr:housenumber"] + " " : "") + (t["addr:street"] || "")).trim(), (t["addr:city"] || t["addr:suburb"] || "").trim()]
    .filter(Boolean).join(", ");
}
// STAY: the facility tags /stay reads off an OSM record — kept on the cached record (a
// short whitelist, never the whole tag bag) so the shared cache serves both routes.
// /camps2-osm strips them on output, so its shape is unchanged.
const OSM_FACILITY_TAGS = ["fee", "charge", "power_supply", "shower", "toilets", "swimming_pool", "pool", "internet_access"];
function facilityTags(t) {
  const out = {};
  OSM_FACILITY_TAGS.forEach((k) => { if (t && t[k] != null && t[k] !== "") out[k] = String(t[k]); });
  return out;
}
// The lookup itself, shared by /camps2-osm and /stay: { results, cached } or { errResp }.
// Caches up to 40 nearest (was 12) so a corridor anchor isn't starved; the route still
// presents 12. Older cached entries (≤12, no tags) stay valid — tags default to none.
async function osmCamps(lat, lon, radiusKm, env, opts) {
  // KV cache FIRST — a hit serves WITHOUT hitting Overpass. Distinct "camps2-osm:"
  // prefix so it never collides with the "camps:" or "camps2:" caches. 7-day TTL.
  const kv = env && env.PLACES_KV;
  const ckey = `camps2-osm:${lat.toFixed(2)},${lon.toFixed(2)}:${radiusKm}`;
  if (kv) {
    try { const c = await kv.get(ckey, { type: "json" }); if (c && c.results) return { results: c.results, cached: true }; } catch (e) {}
  }

  // Same camp/caravan selectors as /camps, PLUS rest areas — the free-stop category.
  // Distinct query string from /camps, so overpass()'s in-memory cache never collides.
  const r = radiusKm * 1000;
  const q = `[out:json][timeout:20];(node["tourism"~"camp_site|caravan_site"](around:${r},${lat},${lon});way["tourism"~"camp_site|caravan_site"](around:${r},${lat},${lon});node["highway"="rest_area"](around:${r},${lat},${lon});way["highway"="rest_area"](around:${r},${lat},${lon}););out center tags 150;`;
  const res = await overpass(q, opts && opts.deadlineMs);   // /stay passes a shorter budget; the route uses the default
  if (res.error) {
    // A fresh KV hit would have returned above — honest error, never a crash.
    return { errResp: jsonResp({ error: "camps lookup failed", detail: res.error, unavailable: true }, 503) };
  }
  const elements = (res.data && res.data.elements) || [];   // malformed/empty upstream -> [] (honest zero), not a crash
  const results = osmPlacesNearest(elements, "", lat, lon, 200)   // parse + nearest-first (big cap; we filter next)
    .filter((p) => isNonCommercialCamp(p.tags))                   // NON-COMMERCIAL only — the category Places lacks
    .slice(0, 40)                                                 // cache cap (the route presents 12, as always)
    .map((p) => ({
      id: p.osmid,                                                // stable OSM id (phase-3 merge/dedup key)
      name: p.name,
      type: osmCampType(p.tags),
      lat: p.lat, lon: p.lon,
      address: osmAddress(p.tags),
      phone: p.tags.phone || p.tags["contact:phone"] || "",       // where a tag exists, else ""
      hours: p.tags.opening_hours ? [p.tags.opening_hours] : null, // OSM single string -> array; mirrors /camps2 hours shape
      source: "osm",
      tags: facilityTags(p.tags),                                 // STAY facilities — stripped by /camps2-osm
    }));
  if (kv && !res.cached) { try { await kv.put(ckey, JSON.stringify({ results, ts: Date.now() }), { expirationTtl: 7 * 24 * 3600 }); } catch (e) {} }
  return { results, cached: !!res.cached };
}
async function handleCamps2Osm(request, env) {
  const u = new URL(request.url);
  const lat = parseFloat(u.searchParams.get("lat"));
  const lon = parseFloat(u.searchParams.get("lon"));
  const radiusKm = Math.min(parseInt(u.searchParams.get("radius") || "40"), 100);
  if (isNaN(lat) || isNaN(lon)) return jsonResp({ error: "lat and lon required" }, 400);
  const r = await osmCamps(lat, lon, radiusKm, env);
  if (r.errResp) return r.errResp;
  // Same 12-record presentation, same record shape (no `tags`) as before STAY.
  const results = r.results.slice(0, 12).map(({ tags, ...rec }) => rec);
  return jsonResp({ source: "osm", radiuskm: radiusKm, cached: r.cached, results });
}

// ═══ GET /stay — "SOMEWHERE TO STAY" as finished data, code only, no AI (STAY) ═══
// lat,lng (the van) · dlat,dlng (the destination) · window 1|2 (hours ahead, default 1)
// · kind both|paid|free (default both). Road route from OSRM (the app's routing source),
// parks from the Places lookup + free camps / rest areas from the OSM lookup around
// anchors spaced along the ahead stretch, merged with the app's dedupe rules, then kept
// only if AHEAD on the route, inside the drive-time window and within STAY_CORRIDOR_KM
// of the road. Three nearest ahead, with the nearest free camp guaranteed a slot when
// kind=both and one qualifies.
//
// CORRIDOR: 5 km crow-flies from the nearest route vertex. Why 5: a highway town is
// ~3 km across, so 5 km takes in a caravan park on the far side of town, but leaves out a
// beach camp 20 minutes down a side road — whose detour our along-route drive_time
// wouldn't include, so quoting it would understate the time. (The app's own corridor
// filters use 10 km for servos and 15 km for camps; both quote time-from-GPS by road,
// which absorbs the detour. This endpoint doesn't, so it's tighter.)
const STAY_CORRIDOR_KM = 5;
const STAY_ANCHOR_RADIUS_KM = 40;    // each lookup circle (the Places bias cap is 50 km)
// STAYGAP speed guard: Overpass gets ~6 s per anchor here (one mirror pair, no second
// round) instead of the routes' 13 s, so a slow mirror can't hold a cold request past
// 10 s. A timed-out anchor is REPORTED — "free camps couldn't be checked for that
// stretch" — never silently left out. Parks (Places) are unaffected.
const STAY_OSM_DEADLINE_MS = 6000;
// STAYGAP: every 20 km (was 50). Places returns at most 20 results per circle, so on a
// busy corridor (the M1 through Brisbane) a 50 km spacing let whole towns of parks fall
// between the 20-result caps. 20 km spacing means each stretch of road is inside ~4
// circles, each ranked from a different centre.
const STAY_ANCHOR_SPACING_KM = 20;
const STAY_ANCHOR_GRID = 0.2;        // anchors snap to a ~20 km grid so a moving van re-hits the same KV keys
const STAY_MAX_ANCHORS = 12;         // a 2 h window is ~180 km → ~9 anchors; 6 would have cut it short
const STAY_RESULTS = 3;

// Durations are ALWAYS hours-and-minutes (the app's locked convention, ported verbatim
// from index.html hrsMins): "1 hr 35" · "2 hr" · "28 min" — never decimals, never "95 minutes".
function hrsMins(totalMins) {
  const t = Math.max(0, Math.round(totalMins));
  if (t < 60) return `${t} min`;
  const h = Math.floor(t / 60), m = t % 60;
  return m ? `${h} hr ${String(m).padStart(2, "0")}` : `${h} hr`;
}

// OSRM route with per-segment annotations, so every vertex carries cumulative km and
// seconds from the start. In-memory cache (1 h, 2-decimal coords) — free source, but a
// 1000 km route is a big JSON and the same pair is asked again as the van rolls.
const routeCache = new Map();
const ROUTE_TTL = 60 * 60 * 1000;
async function osrmRoute(lat, lng, dlat, dlng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}>${dlat.toFixed(2)},${dlng.toFixed(2)}`;
  const hit = routeCache.get(key);
  if (hit && Date.now() - hit.ts < ROUTE_TTL) return hit.data;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${lng},${lat};${dlng},${dlat}?overview=full&geometries=geojson&annotations=distance,duration`,
      { headers: { "User-Agent": "NavigatorApp/1.0 (Australian road travel assistant)" }, signal: ctrl.signal });
    if (!r.ok) return { error: "HTTP " + r.status };
    const d = await r.json();
    const rt = d && d.routes && d.routes[0];
    if (!rt || !rt.geometry || !rt.legs || !rt.legs[0] || !rt.legs[0].annotation) return { error: "no route" };
    const pts = rt.geometry.coordinates.map((c) => ({ lat: c[1], lon: c[0] }));
    const segKm = rt.legs[0].annotation.distance, segS = rt.legs[0].annotation.duration;
    const cumKm = [0], cumS = [0];
    for (let i = 0; i < segKm.length; i++) { cumKm.push(cumKm[i] + segKm[i] / 1000); cumS.push(cumS[i] + segS[i]); }
    const data = { pts, cumKm, cumS, km: rt.distance / 1000, secs: rt.duration };
    if (routeCache.size > 50) routeCache.clear();
    routeCache.set(key, { data, ts: Date.now() });
    return data;
  } catch (e) {
    return { error: e && e.name === "AbortError" ? "timeout" : "error" };
  } finally { clearTimeout(timer); }
}

// Nearest route vertex to a point, searched only over the ahead stretch [from, to]. A
// coarse stride first (≤ ~600 checks), then a fine pass around the best — a 2 h stretch
// can be thousands of vertices and there may be a hundred candidates.
function nearestVertex(route, lat, lon, from, to) {
  const n = to - from + 1;
  const stride = Math.max(1, Math.floor(n / 600));
  let best = from, bestKm = Infinity;
  for (let i = from; i <= to; i += stride) {
    const dk = hav(lat, lon, route.pts[i].lat, route.pts[i].lon);
    if (dk < bestKm) { bestKm = dk; best = i; }
  }
  for (let i = Math.max(from, best - stride); i <= Math.min(to, best + stride); i++) {
    const dk = hav(lat, lon, route.pts[i].lat, route.pts[i].lon);
    if (dk < bestKm) { bestKm = dk; best = i; }
  }
  return { idx: best, km: bestKm };
}

// Ported from index.html sharesNameToken / fetchMergedCamps / dedupeCampSites — the
// same rules the app applies, so /stay and the app never disagree about what's one site.
function sharesNameToken(a, b) {
  const GEN = /^(park|parks|caravan|van|camp|camps|camping|tourist|holiday|site|sites|free|powered|beach|creek|river|point|rest|area|reserve|road|highway|big4|discovery|top)$/;
  const toks = (s) => new Set((s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GEN.test(w)));
  const A = toks(a), B = toks(b);
  for (const t of A) if (B.has(t)) return true;
  return false;
}
function verifiedPhone(s) {
  const p = (s && s.phone) || "";
  return (p.replace(/[^\d]/g, "").length >= 6) ? p.trim() : null;
}
// Twin rule: an OSM record within ~100 m of a Places result sharing a distinctive name
// token is the SAME site. A numbered Places twin wins (and carries the free NATURE); an
// unnumbered Places twin adds nothing — keep the OSM record instead.
function mergeCamps(places, osm) {
  const merged = places.slice();
  for (const o of osm) {
    const twin = places.find((p) => hav(p.lat, p.lon, o.lat, o.lon) <= 0.1 && sharesNameToken(p.name, o.name));
    if (!twin) { merged.push(o); continue; }
    if (verifiedPhone(twin)) { twin.freeByNature = true; continue; }
    const mi = merged.indexOf(twin); if (mi !== -1) merged.splice(mi, 1);
    merged.push(o);
  }
  return merged;
}
// Same-site dedupe: within 250 m AND one name a substring of the other (punctuation
// stripped). Places beats OSM; otherwise the longer name wins; a dropped free twin
// stamps its nature onto the survivor. Fields are never merged between records.
function isFreeNature(s) { return !!(s && (s.source === "osm" || s.freeByNature)); }
function dedupeCampSites(sites) {
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const out = [];
  for (const s of sites) {
    const sn = norm(s.name);
    const j = out.findIndex((o) => { const on = norm(o.name); return hav(s.lat, s.lon, o.lat, o.lon) <= 0.25 && (sn.includes(on) || on.includes(sn)); });
    if (j === -1) { out.push(s); continue; }
    const cur = out[j];
    const preferNew = (s.source === "places" && cur.source !== "places") ? true
                    : (cur.source === "places" && s.source !== "places") ? false
                    : sn.length > norm(cur.name).length;
    const winner = preferNew ? s : cur, loser = preferNew ? cur : s;
    if (isFreeNature(loser)) winner.freeByNature = true;
    if (preferNew) out[j] = s;
  }
  return out;
}
const FREE_CAMP_NAME = /\b(rest area|free camp|rv free camp)\b/i;   // a Places-only free camp, by name (app rule)
function stayKind(s) { return (isFreeNature(s) || FREE_CAMP_NAME.test(s.name || "") || FREE_CAMP_NAME.test(s.type || "")) ? "free" : "park"; }

// Facilities: three states, straight from OSM tags — "yes" / "no" only when the tag says
// exactly that, otherwise "unknown". A Places record has no tags → all unknown. Never guessed.
function stayFacilities(tags) {
  const t = tags || {};
  const yn = (v) => (v === "yes" ? "yes" : v === "no" ? "no" : "unknown");
  const w = String(t.internet_access || "").toLowerCase();
  return {
    powered: yn(t.power_supply),
    showers: yn(t.shower),
    toilets: yn(t.toilets),
    pool: yn(t.swimming_pool || t.pool),
    wifi: /^(wlan|yes|wired|terminal)$/.test(w) ? "yes" : w === "no" ? "no" : "unknown",
  };
}
function stayPrice(tags) {
  const t = tags || {};
  const fee = String(t.fee || "").toLowerCase();
  if (fee === "no" || fee === "none" || fee === "free" || fee === "0") return "free";
  if (t.charge) return String(t.charge);
  return "unknown";
}

// STAYGAP — a final-results-only phone back-fill. A PARK that arrived without a number
// (the Text Search field mask asked for nationalPhoneNumber and got nothing) is looked up
// ONCE more by its Places id via Place Details, asking for both the national and the
// international number. The number is accepted only if Details' location is within 500 m
// of the site we're showing — a stale or re-pointed id must never hand a driver the
// wrong park's number. KV: found → 90 days; not found → 7 days (so a park that adds a
// number is picked up within a week, and a known blank isn't re-billed every request).
// Free camps are never looked up. At most 3 lookups per request (one per shown park).
const PHONE_FIELD_MASK = "id,location,nationalPhoneNumber,internationalPhoneNumber";
const PHONE_MATCH_KM = 0.5;
async function placePhoneById(id, siteLat, siteLon, env) {
  if (!id || !env.GOOGLE_PLACES_KEY) return { phone: null, from: "skipped" };
  const kv = env && env.PLACES_KV;
  const ckey = `phone:${id}`;
  if (kv) {
    try { const c = await kv.get(ckey, { type: "json" }); if (c && "phone" in c) return { phone: c.phone, from: "cache" }; } catch (e) {}
  }
  let phone = null, outcome = "not-found";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
      headers: { "X-Goog-Api-Key": env.GOOGLE_PLACES_KEY, "X-Goog-FieldMask": PHONE_FIELD_MASK },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {                                                 // a failed lookup is NOT cached as "no number"
      let detail = ""; try { const e = await r.json(); detail = (e && e.error && e.error.message) || ""; } catch (_) {}
      return { phone: null, from: `error HTTP ${r.status}${detail ? " — " + detail.slice(0, 120) : ""}` };
    }
    const d = await r.json();
    const loc = (d && d.location) || {};
    const near = typeof loc.latitude === "number" && typeof loc.longitude === "number"
      && hav(siteLat, siteLon, loc.latitude, loc.longitude) <= PHONE_MATCH_KM;
    if (!near) outcome = "mismatch";                            // Details points somewhere else — reject, but cache the miss
    else {
      const p = String((d && (d.nationalPhoneNumber || d.internationalPhoneNumber)) || "").trim();
      if (p.replace(/[^\d]/g, "").length >= 6) { phone = p; outcome = "found"; }
    }
  } catch (e) {
    return { phone: null, from: "error " + (e && e.name === "AbortError" ? "timeout" : String((e && e.message) || e).slice(0, 80)) };
  }
  if (kv) { try { await kv.put(ckey, JSON.stringify({ phone, ts: Date.now() }), { expirationTtl: (phone ? 90 : 7) * 24 * 3600 }); } catch (e) {} }
  return { phone, from: outcome };
}

async function handleStay(request, env) {
  const u = new URL(request.url);
  const num = (k) => parseFloat(u.searchParams.get(k));
  const lat = num("lat"), lng = num("lng"), dlat = num("dlat"), dlng = num("dlng");
  if ([lat, lng, dlat, dlng].some(isNaN)) return jsonResp({ error: "lat, lng, dlat and dlng required" }, 400);
  const windowH = u.searchParams.get("window") === "2" ? 2 : 1;
  const kind = ["both", "paid", "free"].includes(u.searchParams.get("kind")) ? u.searchParams.get("kind") : "both";
  const windowLabel = windowH === 1 ? "1 hour" : "2 hours";
  const nothing = { window_hours: windowH, kind, corridor_km: STAY_CORRIDOR_KM };

  // 1. The road route, with cumulative km/seconds at every vertex.
  const route = await osrmRoute(lat, lng, dlat, dlng);
  if (route.error) return jsonResp({ ...nothing, error: "couldn't get the road route", detail: route.error, unavailable: true }, 502);
  const routeOut = { km: Math.round(route.km), drive_time: hrsMins(route.secs / 60) };

  // The ahead stretch: from the start vertex to the last vertex inside the window (plus
  // a little slack so a site just past it still gets measured, then filtered honestly).
  const windowS = windowH * 3600;
  let endIdx = 0;
  while (endIdx + 1 < route.pts.length && route.cumS[endIdx + 1] <= windowS * 1.1) endIdx++;

  // 2. Lookup anchors along the stretch, snapped to a grid (cache re-hits), deduped.
  const snap = (v) => Math.round(v / STAY_ANCHOR_GRID) * STAY_ANCHOR_GRID;
  const anchors = []; const seenA = new Set();
  const stretchKm = route.cumKm[endIdx];
  for (let k = Math.min(20, stretchKm); ; k += STAY_ANCHOR_SPACING_KM) {
    const target = Math.min(k, stretchKm);
    let i = 0; while (i + 1 <= endIdx && route.cumKm[i + 1] <= target) i++;
    const a = { lat: +snap(route.pts[i].lat).toFixed(2), lon: +snap(route.pts[i].lon).toFixed(2) };
    const ak = `${a.lat},${a.lon}`;
    if (!seenA.has(ak)) { seenA.add(ak); a.atKm = Math.round(target); anchors.push(a); }   // atKm: where on the route this circle sits (for the honest per-stretch note)
    if (target >= stretchKm || anchors.length >= STAY_MAX_ANCHORS) break;
  }
  const lookups = await Promise.all(anchors.map(async (a) => {
    const [p, o] = await Promise.all([placesCamps(a.lat, a.lon, STAY_ANCHOR_RADIUS_KM, env), osmCamps(a.lat, a.lon, STAY_ANCHOR_RADIUS_KM, env, { deadlineMs: STAY_OSM_DEADLINE_MS })]);
    return { places: p.errResp ? null : p.results, osm: o.errResp ? null : o.results, atKm: a.atKm };
  }));
  const placesOk = lookups.some((l) => l.places), osmOk = lookups.some((l) => l.osm);
  // Every anchor whose free-camp lookup failed is named by the stretch its circle covers
  // (its route km ± the circle radius, clipped to the window). Plain words, never silence.
  const osmFailed = lookups.filter((l) => !l.osm);
  const osmPartial = osmOk && osmFailed.length > 0;
  const stretchOf = (l) => `${Math.max(0, l.atKm - STAY_ANCHOR_RADIUS_KM)}–${Math.min(Math.round(stretchKm), l.atKm + STAY_ANCHOR_RADIUS_KM)} km ahead`;
  if (!placesOk && !osmOk) return jsonResp({ ...nothing, error: "camp lookups failed", unavailable: true }, 503);
  // Pool by stable id across anchors (overlapping circles return the same sites).
  const byId = (arr, key) => { const m = new Map(); arr.forEach((r) => { if (r && r.id && !m.has(r.id)) m.set(r.id, { ...r }); }); return [...m.values()]; };
  const places = byId(lookups.flatMap((l) => l.places || []));
  const osm = byId(lookups.flatMap((l) => l.osm || []));

  // 3. Merge with the app's rules, then keep AHEAD + in-window + inside the corridor.
  const merged = dedupeCampSites(mergeCamps(places, osm));
  const startIdx = nearestVertex(route, lat, lng, 0, Math.min(endIdx, 50)).idx;   // the van's own vertex (OSRM snaps the start, so ~0)
  const qualifying = [];
  for (const s of merged) {
    if (s.lat == null || s.lon == null) continue;
    const nv = nearestVertex(route, s.lat, s.lon, startIdx, endIdx);
    if (nv.km > STAY_CORRIDOR_KM) continue;                        // too far off the road
    const kmAhead = route.cumKm[nv.idx] - route.cumKm[startIdx];
    if (nv.idx <= startIdx || kmAhead < 0.5) continue;              // behind us, or underfoot
    const secs = route.cumS[nv.idx] - route.cumS[startIdx];
    if (secs > windowS) continue;                                   // past the window
    qualifying.push({ s, kmAhead, secs, kmToDest: route.km - route.cumKm[nv.idx], kindOf: stayKind(s) });
  }
  qualifying.sort((a, b) => a.kmAhead - b.kmAhead);
  const wanted = kind === "both" ? qualifying : qualifying.filter((q) => q.kindOf === (kind === "free" ? "free" : "park"));

  // 4. Three nearest ahead; with kind=both the nearest free camp takes the last slot if
  // none made it on distance alone.
  let picked = wanted.slice(0, STAY_RESULTS);
  if (kind === "both" && !picked.some((q) => q.kindOf === "free")) {
    const firstFree = wanted.find((q) => q.kindOf === "free");
    if (firstFree) { picked = [...picked.slice(0, STAY_RESULTS - 1), firstFree].sort((a, b) => a.kmAhead - b.kmAhead); }
  }
  // STAYGAP: back-fill numbers for the shown PARKS only (never free camps), in parallel.
  let phoneLookups = 0; const phoneOutcomes = [];   // outcomes are reported (cache/found/not-found/mismatch/error …) so a silent miss is diagnosable
  await Promise.all(picked.map(async (q) => {
    if (q.kindOf !== "park" || verifiedPhone(q.s) || q.s.source !== "places" || !q.s.id) return;
    phoneLookups++;
    const r = await placePhoneById(q.s.id, q.s.lat, q.s.lon, env);
    phoneOutcomes.push(`${q.s.name}: ${r.from}`);
    if (r.phone) q.s = { ...q.s, phone: r.phone };
  }));
  const results = picked.map(({ s, kmAhead, secs, kmToDest, kindOf }) => ({
    name: s.name, kind: kindOf, lat: s.lat, lng: s.lon,
    phone: verifiedPhone(s),
    km_ahead: Math.round(kmAhead), drive_time: hrsMins(secs / 60),
    km_from_destination: Math.round(kmToDest),
    facilities: stayFacilities(s.tags),
    price: stayPrice(s.tags),
    source: s.source,
  }));
  let message = null;
  if (!results.length) {
    const what = kind === "free" ? "free camps" : kind === "paid" ? "parks" : "parks or free camps";
    message = `No ${what} within ${windowLabel} ahead`;
  }
  const notes = [];
  if (!placesOk) notes.push("couldn't check caravan parks just now");
  if (!osmOk) notes.push("couldn't check free camps just now");
  else if (osmPartial) notes.push(`free camps couldn't be checked for the stretch ${osmFailed.map(stretchOf).join(" and ")} — the parks shown for it are complete, the free camps are not`);
  return jsonResp({
    ...nothing, route: routeOut, found: wanted.length, results, message,
    sources: { places: placesOk ? "ok" : "failed", osm: !osmOk ? "failed" : osmPartial ? "partial" : "ok", anchors: anchors.length,
               ...(osmFailed.length ? { free_camps_unchecked: osmFailed.map(stretchOf) } : {}), phone_lookups: phoneLookups, ...(phoneOutcomes.length ? { phone_outcomes: phoneOutcomes } : {}) },
    ...(notes.length ? { note: notes.join("; ") } : {}),
  });
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

// ═══ GET /route — the trip's distance and drive time, nothing else (STAYAPP) ═══
// lat,lng → dlat,dlng. The new app's main screen needs "12 hr 40 · 1102 km" before any
// stay search runs; this reuses osrmRoute() and its in-memory cache, so the later /stay
// for the same pair pays no second routing call. Free source, no Places, no OSM.
async function handleRoute(request) {
  const u = new URL(request.url);
  const num = (k) => parseFloat(u.searchParams.get(k));
  const lat = num("lat"), lng = num("lng"), dlat = num("dlat"), dlng = num("dlng");
  if ([lat, lng, dlat, dlng].some(isNaN)) return jsonResp({ error: "lat, lng, dlat and dlng required" }, 400);
  const route = await osrmRoute(lat, lng, dlat, dlng);
  if (route.error) return jsonResp({ error: "couldn't get the road route", detail: route.error, unavailable: true }, 502);
  return jsonResp({ km: Math.round(route.km), drive_time: hrsMins(route.secs / 60), mins: Math.round(route.secs / 60) });
}

// ═══ Worker build stamp — plain English, so the phone can check what's live ═══
const WORKER_BUILD = "Navigator Worker — 29 Sep 2026, 10:17 AM AEST (STAYAPP: GET /route — km and drive time to the destination, same OSRM call and cache as /stay)";

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
  // MAP-EARS: the short command vocabulary — the field mishears ("Hold map",
  // "Hide mat", "This is MEP") were Whisper reaching for words it had no bias toward.
  // CAMPS-EARS: "camps" is the app's own advertised keyword — bare "camps" came
  // back as "Kemps"/"hemps" (the Towns list biases toward Kempsey).
  "Commands: map, show the map, hide the map, camps, carry on, close, that's all,",
  "stop listening, yes, no, none, all of them, number one, number two, number three.",
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
    const url = new URL(request.url);
    const origin = allowedOrigin(request);
    // Preflight: the browser asks before a JSON POST. Answer only for an allowed origin.
    if (request.method === "OPTIONS") {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: { ...corsHeaders, "Access-Control-Allow-Origin": origin, "Access-Control-Max-Age": "86400", "Vary": "Origin" } });
    }
    // The gate — before any route runs, so a refused caller never reaches a paid service.
    if (!origin && !originExempt(request, url)) {
      return new Response(JSON.stringify({ error: "forbidden — this Worker only serves the Navigator app" }), { status: 403, headers: { "content-type": "application/json" } });
    }
    const res = await route(request, env, url);
    return origin ? withOrigin(res, origin) : res;
  },
};

async function route(request, env, url) {
    // GET /log/<id> — dynamic path, so it can't sit in the exact-match table below.
    if (url.pathname.startsWith("/log/")) return handleLogGet(url.pathname.slice(5), env);
    const routes = {
      "/fuel": () => handleFuel(request, env),
      "/poi": () => handlePoi(request),
      "/camps": () => handleCamps(request, env),   // fallback-only: the frontend's Places-down safety net (phase 4)
      "/camps2": () => handleCamps2(request, env),   // Places-backed camps — LIVE (phase 3 merge)
      "/camps2-osm": () => handleCamps2Osm(request, env),   // filtered OSM non-commercial camps — LIVE (phase 3 merge)
      "/stay": () => handleStay(request, env),   // STAY: three places ahead on the route, as finished data (no AI)
      "/route": () => handleRoute(request),      // STAYAPP: km + drive time to the destination — same OSRM call and cache as /stay, no lookups
      "/stations": () => handleStations(request),
      "/accom": () => handleAccom(request),
      "/weather": () => handleWeather(request, env),
      "/transcribe": () => handleTranscribe(request, env),
      "/geocode": () => handleGeocode(request, env),
      "/reverse-geocode": () => handleReverseGeocode(request, env),
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
}
