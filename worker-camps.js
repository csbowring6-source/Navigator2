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

// `limit` (FUEL): the route callers keep the 8-by-price cap; /fuelahead asks for more.
async function nswFuel(lat, lon, fueltype, radius, env, limit) {
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
  }).slice(0, limit || 8);
}

// ═══ WA FuelWatch ═══
const WA_PRODUCT = { U91: 1, P95: 2, P98: 6, DL: 4, E10: 1 };
function xmlField(block, tag) {
  const m = block.match(new RegExp("<" + tag + ">([^<]*)</" + tag + ">"));
  return m ? m[1].trim() : "";
}
async function waFuel(lat, lon, fueltype, limit) {
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
  return results.slice(0, limit || 8);
}

// ═══ Informed Sources FPDAPI — QLD and SA ═══
const FPD_FUEL = { U91: 2, DL: 3, P95: 5, P98: 8, E10: 12 };
const FPD_REGION = { QLD: 1, SA: 4 };
const fpdCache = {};

async function fpdFuel(stateKey, base, token, lat, lon, fueltype, radiusKm, limit) {
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
  return results.slice(0, limit || 8);
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
// lat,lng (the van) · dlat,dlng (the destination) · when soon|1|2|stop (default soon; STAYWHEN)
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
const STAY_STOP_RADIUS_KM = 15;      // STAYWHEN when=stop: "in town" = within 15 km of the centre
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
const STAY_RESULTS = 10;         // STAYLIST: every place found, up to 10 (was 3)
const STAY_PHONE_BACKFILL = 3;   // only the first rows get the automatic Place Details back-fill; the rest look up on tap (/stay-phone)

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
  // STAYWHEN — WHEN the driver wants to stop decides WHERE we look:
  //   soon : nearest ahead, inside the first hour of road (the original behaviour)
  //   1 | 2: the three places FURTHEST ahead that are still inside that driving time — so the
  //          driver keeps going as long as possible and still stops in time (listed nearest
  //          first). Nothing inside the time → the nearest place beyond it, with a plain note.
  //   stop : around the destination passed in (the planned stop), within 15 km of its centre
  const whenRaw = (u.searchParams.get("when") || "soon").toLowerCase();
  const when = ["soon", "1", "2", "stop"].includes(whenRaw) ? whenRaw : "soon";
  const hoursAhead = when === "1" ? 1 : when === "2" ? 2 : 0;
  const kind = ["both", "paid", "free"].includes(u.searchParams.get("kind")) ? u.searchParams.get("kind") : "both";
  const nothing = { when, kind, corridor_km: when === "stop" ? STAY_STOP_RADIUS_KM : STAY_CORRIDOR_KM };

  // 1. The road route, with cumulative km/seconds at every vertex.
  const route = await osrmRoute(lat, lng, dlat, dlng);
  if (route.error) return jsonResp({ ...nothing, error: "couldn't get the road route", detail: route.error, unavailable: true }, 502);
  const routeOut = { km: Math.round(route.km), drive_time: hrsMins(route.secs / 60) };
  const lastIdx = route.pts.length - 1;
  const idxAtKm = (km) => { let i = 0; while (i + 1 <= lastIdx && route.cumKm[i + 1] <= km) i++; return i; };

  // "In 2 hrs" on a 1-hour trip: the point is past the destination — say so, plainly.
  if (hoursAhead && route.secs < hoursAhead * 3600) {
    return jsonResp({ ...nothing, route: routeOut, found: 0, results: [], message: `Your destination is less than ${hoursAhead === 1 ? "1 hour" : "2 hours"} away`, sources: { places: "skipped", osm: "skipped", anchors: 0, phone_lookups: 0 } });
  }

  // The stretch of road we search, and the point results are ranked from.
  let stretchStartKm = 0, stretchEndKm, pointKm = 0;
  if (when === "soon") {
    let e = 0; while (e + 1 <= lastIdx && route.cumS[e + 1] <= 3600 * 1.1) e++;   // the first hour (+ slack; the time filter below is exact)
    stretchEndKm = route.cumKm[e];
  } else if (hoursAhead) {
    let p = 0; while (p + 1 <= lastIdx && route.cumS[p] < hoursAhead * 3600) p++;   // first vertex at/after N hours of driving
    pointKm = route.cumKm[p];
    stretchEndKm = Math.min(route.km, pointKm + STAY_ANCHOR_RADIUS_KM);   // the whole N hours, plus one circle beyond for the "nearest beyond" fallback
  } else {
    stretchStartKm = route.km; stretchEndKm = route.km; pointKm = route.km;   // the stop itself
  }
  const endIdx = idxAtKm(stretchEndKm);
  const stretchKm = stretchEndKm;

  // 2. Lookup anchors along the stretch, snapped to a grid (cache re-hits), deduped.
  //    "stop" is ONE circle on the town centre (the destination coordinates as given).
  const snap = (v) => Math.round(v / STAY_ANCHOR_GRID) * STAY_ANCHOR_GRID;
  const anchors = []; const seenA = new Set();
  const addAnchor = (plat, plon, atKm) => {
    const a = { lat: +snap(plat).toFixed(2), lon: +snap(plon).toFixed(2), atKm: Math.round(atKm) };
    const ak = `${a.lat},${a.lon}`;
    if (!seenA.has(ak)) { seenA.add(ak); anchors.push(a); }
  };
  if (when === "stop") addAnchor(dlat, dlng, route.km);
  else for (let k = Math.min(stretchStartKm + 20, stretchEndKm); ; k += STAY_ANCHOR_SPACING_KM) {
    const target = Math.min(k, stretchEndKm);
    const i = idxAtKm(target);
    addAnchor(route.pts[i].lat, route.pts[i].lon, target);
    if (target >= stretchEndKm || anchors.length >= STAY_MAX_ANCHORS) break;
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

  // 3. Merge with the app's rules, then keep what fits the mode, ranked from its point:
  //    soon/1/2 — AHEAD of the van, within the corridor of the road (soon: also inside the hour);
  //    rank = km ahead (soon), or for 1/2: furthest-inside-the-time first, then anything beyond
  //    the time nearest first (used only when nothing is inside).
  //    stop — within 15 km of the town centre, ranked by distance from the centre; km_ahead
  //    is still measured to the nearest point of the route (for the card's second line).
  const merged = dedupeCampSites(mergeCamps(places, osm));
  const startIdx = nearestVertex(route, lat, lng, 0, Math.min(lastIdx, 50)).idx;   // the van's own vertex (OSRM snaps the start, so ~0)
  const qualifying = [];
  for (const s of merged) {
    if (s.lat == null || s.lon == null) continue;
    let distFromStop = null, rank, beyond = false;
    if (when === "stop") {
      distFromStop = hav(dlat, dlng, s.lat, s.lon);
      if (distFromStop > STAY_STOP_RADIUS_KM) continue;              // not in the town
      rank = distFromStop;
    }
    const nv = nearestVertex(route, s.lat, s.lon, startIdx, when === "stop" ? lastIdx : endIdx);
    const kmAhead = route.cumKm[nv.idx] - route.cumKm[startIdx];
    const secs = route.cumS[nv.idx] - route.cumS[startIdx];
    if (when !== "stop") {
      if (nv.km > STAY_CORRIDOR_KM) continue;                        // too far off the road
      if (nv.idx <= startIdx || kmAhead < 0.5) continue;              // behind us, or underfoot
      if (when === "soon" && secs > 3600) continue;                   // soon = inside the hour
      const inside = !hoursAhead || secs <= hoursAhead * 3600;
      rank = when === "soon" ? kmAhead : inside ? -kmAhead : 1e6 + kmAhead;   // 1/2: furthest inside first; beyond-the-time after, nearest first
      beyond = !inside;
    }
    qualifying.push({ s, kmAhead, secs, kmToDest: route.km - route.cumKm[nv.idx], distFromStop, rank, beyond, kindOf: stayKind(s) });
  }
  qualifying.sort((a, b) => a.rank - b.rank);
  const wantedAll = kind === "both" ? qualifying : qualifying.filter((q) => q.kindOf === (kind === "free" ? "free" : "park"));
  const wanted = wantedAll.filter((q) => !q.beyond);

  // 4. Three by the mode's rank; with kind=both the best-ranked free camp takes the last slot
  // if none made it on rank alone. 1/2 with nothing inside the time → the nearest beyond it.
  let picked = wanted.slice(0, STAY_RESULTS);
  if (kind === "both" && !picked.some((q) => q.kindOf === "free")) {
    const firstFree = wanted.find((q) => q.kindOf === "free");
    if (firstFree) { picked = [...picked.slice(0, STAY_RESULTS - 1), firstFree].sort((a, b) => a.rank - b.rank); }
  }
  let beyondNote = "";
  if (hoursAhead && !picked.length) {
    const nb = wantedAll.find((q) => q.beyond);
    if (nb) { picked = [nb]; beyondNote = `Nothing within ${hoursAhead === 1 ? "1 hour" : "2 hours"}. The nearest is ${hrsMins(nb.secs / 60)} ahead`; }
  }
  if (hoursAhead) picked.sort((a, b) => a.kmAhead - b.kmAhead);   // listed nearest first
  // STAYGAP: back-fill numbers for the shown PARKS only (never free camps), in parallel.
  let phoneLookups = 0; const phoneOutcomes = [];   // outcomes are reported (cache/found/not-found/mismatch/error …) so a silent miss is diagnosable
  await Promise.all(picked.slice(0, STAY_PHONE_BACKFILL).map(async (q) => {
    if (q.kindOf !== "park" || verifiedPhone(q.s) || q.s.source !== "places" || !q.s.id) return;
    phoneLookups++;
    const r = await placePhoneById(q.s.id, q.s.lat, q.s.lon, env);
    phoneOutcomes.push(`${q.s.name}: ${r.from}`);
    if (r.phone) q.s = { ...q.s, phone: r.phone };
  }));
  const results = picked.map(({ s, kmAhead, secs, kmToDest, distFromStop, kindOf }) => ({
    id: s.id || "", name: s.name, kind: kindOf, lat: s.lat, lng: s.lon,   // id: the app's key for an on-tap /stay-phone lookup
    phone: verifiedPhone(s),
    km_ahead: Math.round(kmAhead), drive_time: hrsMins(secs / 60),
    km_from_destination: Math.round(kmToDest),
    ...(when === "stop" ? { dist_from_stop_km: Math.round(distFromStop) } : {}),
    facilities: stayFacilities(s.tags),
    price: stayPrice(s.tags),
    source: s.source,
  }));
  let message = null;
  if (!results.length) {
    const what = kind === "free" ? "free camps" : kind === "paid" ? "parks" : "parks or free camps";
    message = when === "stop" ? `No ${what} within ${STAY_STOP_RADIUS_KM} km of the stop`
            : when === "soon" ? `No ${what} within 1 hour ahead`
            : `No ${what} within ${hoursAhead === 1 ? "1 hour" : "2 hours"} ahead`;
  }
  const notes = [];
  if (beyondNote) notes.push(beyondNote);
  if (!placesOk) notes.push("couldn't check caravan parks just now");
  if (!osmOk) notes.push("couldn't check free camps just now");
  else if (osmPartial) notes.push(`free camps couldn't be checked for the stretch ${osmFailed.map(stretchOf).join(" and ")} — the parks shown for it are complete, the free camps are not`);
  return jsonResp({
    ...nothing, route: routeOut, ...(hoursAhead ? { point_km_ahead: Math.round(pointKm) } : {}), found: wanted.length, results, message,
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

// ═══ GET /stay-phone — one place's number on request (STAYLIST) ═══
// id (Places id) + lat,lng (the site as shown). Same placePhoneById as the automatic
// back-fill: Place Details, accepted only within 500 m of the site, KV 90 days found /
// 7 days not-found, a failed call never cached. Rows 4–10 of a /stay list use this when
// the driver taps their phone button, so those lookups are only ever paid for on demand.
async function handleStayPhone(request, env) {
  const u = new URL(request.url);
  const id = (u.searchParams.get("id") || "").trim();
  const lat = parseFloat(u.searchParams.get("lat")), lng = parseFloat(u.searchParams.get("lng"));
  if (!id || isNaN(lat) || isNaN(lng)) return jsonResp({ error: "id, lat and lng required" }, 400);
  const r = await placePhoneById(id, lat, lng, env);
  return jsonResp({ phone: r.phone, outcome: r.from });
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
  // MAP: the route's line for the app's map — evenly sampled to at most 500 points, first
  // and last always kept. Same cached route; nothing else here changes.
  const n = route.pts.length, step = Math.max(1, Math.ceil((n - 1) / 499));
  const line = [];
  for (let i = 0; i < n; i += step) line.push([+route.pts[i].lat.toFixed(5), +route.pts[i].lon.toFixed(5)]);
  const last = route.pts[n - 1]; if (line.length && (line[line.length - 1][0] !== +last.lat.toFixed(5) || line[line.length - 1][1] !== +last.lon.toFixed(5))) line.push([+last.lat.toFixed(5), +last.lon.toFixed(5)]);
  return jsonResp({ km: Math.round(route.km), drive_time: hrsMins(route.secs / 60), mins: Math.round(route.secs / 60), line });
}

// ═══ GET /fuelahead — the FUEL job as finished data, code only, no AI, no Google (FUEL) ═══
// lat,lng (the van) · dlat,dlng (stop or destination) · range (km the driver can still go).
// Route (same osrmRoute + cache as /stay) → servos AHEAD within 3 km of the road from two
// free sources — the state price feeds (/fuel's fetchers) and OpenStreetMap (a corridor
// query that KEEPS opening_hours and fuel:diesel) — merged (same place = within 150 m).
// Every distance is measured FROM THE DRIVER, along the route, never from the previous
// servo. Returns the servos within range (nearest first, ≤10) plus the FIRST one beyond,
// and a headline built here. Hours are parsed only when certain; otherwise "hours not known".
const FUEL_CORRIDOR_KM = 3;
const FUEL_BEYOND_KM = 150;      // how far past the range we look for the "first servo beyond"
const FUEL_RESULTS = 10;
const FUEL_PRICE_MAX_H = 72;     // a diesel price older than this is not quoted
const STATE_TZ = { QLD: "Australia/Brisbane", NSW: "Australia/Sydney", ACT: "Australia/Sydney", VIC: "Australia/Melbourne", TAS: "Australia/Hobart", SA: "Australia/Adelaide", NT: "Australia/Darwin", WA: "Australia/Perth" };
const STATE_NAME = { QLD: "Queensland", NSW: "New South Wales", ACT: "the ACT", VIC: "Victoria", TAS: "Tasmania", SA: "South Australia", NT: "the Northern Territory", WA: "Western Australia" };
const FEED_NAME = { QLD: "QLD Fuel Prices", NSW: "NSW FuelCheck", ACT: "NSW FuelCheck", TAS: "NSW FuelCheck", SA: "SA Fuel Pricing", WA: "WA FuelWatch" };   // VIC and NT: no feed
const FPD_SA_BASE = "https://fppdirectapi-prod.safuelpricinginformation.com.au";
const FPD_QLD_BASE = "https://fppdirectapi-prod.fuelpricesqld.com.au";
// Which state a point is in — good enough to pick a feed (and to say honestly when there
// isn't one). The Murray forms the VIC/NSW border, approximated by a handful of points.
// Murray towns west→east: SA border, Mildura, Swan Hill, Echuca, Cobram, Corowa, Albury/Wodonga, Hume, Tom Groggin, Indi, Cape Howe.
const VIC_BORDER = [[141, -34.02], [142.16, -34.17], [143.55, -35.33], [144.75, -36.11], [145.65, -35.90], [146.38, -35.98], [146.92, -36.095], [147.4, -36.05], [148.0, -36.30], [148.2, -36.80], [149.98, -37.50]];
function stateOf(lat, lon) {
  if (lon < 129) return "WA";
  if (lat > -26 && lon < 138) return "NT";
  if (lat <= -26 && lon <= 141) return "SA";
  if (lat > -29) return "QLD";
  if (lat < -39.5) return "TAS";
  let b = null;
  for (let i = 0; i < VIC_BORDER.length - 1; i++) { const [x1, y1] = VIC_BORDER[i], [x2, y2] = VIC_BORDER[i + 1]; if (lon >= x1 && lon <= x2) { b = y1 + (y2 - y1) * (lon - x1) / (x2 - x1); break; } }
  if (b == null && lon > 149.98) b = -37.5;
  if (b != null && lat < b) return "VIC";
  if (lat < -35.1 && lat > -35.95 && lon > 148.75 && lon < 149.4) return "ACT";
  return "NSW";
}
async function feedAt(state, lat, lon, env, code) {   // code: "DL" (diesel) or "U91" (petrol) — FUELCHEAP
  code = code || "DL";
  if (state === "WA") return waFuel(lat, lon, code, 40);
  if (state === "SA") return fpdFuel("SA", FPD_SA_BASE, env.SA_TOKEN, lat, lon, code, 30, 40);
  if (state === "QLD") return fpdFuel("QLD", FPD_QLD_BASE, env.QLD_TOKEN, lat, lon, code, 30, 40);
  if (state === "NSW" || state === "ACT" || state === "TAS") return nswFuel(lat, lon, code, 30, env, 40);
  return [];
}
// A feed price for the chosen fuel: only if sane (100–400 c/L) and updated within 72 h → { price: $, age_h }.
function feedPrice(feed, now) {
  if (!feed || !feed.price || feed.price < 100 || feed.price > 400) return null;
  const t = feedTime(feed.updated);
  if (!t || now - t > FUEL_PRICE_MAX_H * 3600e3) return null;
  return { price: Math.round(feed.price) / 100, age_h: Math.max(0, Math.round((now - t) / 3600e3)) };
}
// The feeds' timestamps: FPD is UTC without a Z; NSW is dd/mm/yyyy hh:mm:ss local; WA is dd/mm/yyyy.
function feedTime(s) {
  if (!s) return null;
  let m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
  m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (m) return Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4] || "00"}:${m[5] || "00"}:00+10:00`);
  return null;
}
// ── opening_hours: only the common forms, and only when the whole string is understood ──
//   "24/7" · "06:00-22:00" · "Mo-Fr 06:00-20:00; Sa-Su 07:00-18:00" · "Mo-Su 05:30-21:00; PH off"
// Overnight ranges (22:00-06:00) are handled. Anything else → null → "hours not known". Never guessed.
const OH_DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
function parseHours(s) {
  const t = String(s || "").trim();
  if (!t) return null;
  if (/^24\s*\/\s*7$/i.test(t)) return { always: true };
  const rules = [];
  for (const raw of t.split(";")) {
    const part = raw.trim(); if (!part) continue;
    if (/^(PH|SH)\b/i.test(part)) continue;                                     // holiday rules: ignored, not guessed
    const m = part.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)(?:,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)?\s*(.+)$/);
    if (!m) return null;
    const days = new Set();
    if (m[1]) { for (const seg of m[1].split(",")) { const [a, b] = seg.trim().split("-"); const i = OH_DAYS.indexOf(a), j = OH_DAYS.indexOf(b || a); if (i < 0 || j < 0) return null; for (let k = i; ; k = (k + 1) % 7) { days.add(k); if (k === j) break; } } }
    else for (let k = 0; k < 7; k++) days.add(k);
    const times = m[2].trim();
    if (/^(off|closed)$/i.test(times)) { rules.push({ days, ranges: [] }); continue; }
    if (/^24\s*\/\s*7$/i.test(times)) { rules.push({ days, ranges: [[0, 1440]] }); continue; }
    const ranges = [];
    for (const r of times.split(",")) {
      const mm = r.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/); if (!mm) return null;
      const a = +mm[1] * 60 + +mm[2]; let b = +mm[3] * 60 + +mm[4];
      if (a > 1440 || b > 1440) return null;
      if (b <= a) b += 1440;                                                    // overnight
      ranges.push([a, b]);
    }
    rules.push({ days, ranges });
  }
  if (!rules.length) return null;
  if (rules.every((r) => r.days.size === 7 && r.ranges.some(([a, b]) => a === 0 && b >= 1440))) return { always: true };
  return { rules };
}
function localClock(tz, date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), min: (+p.hour % 24) * 60 + +p.minute };
}
function hoursStatus(h, tz, date) {   // → { open, always?, until?, opensIn? (days), opens? }
  if (h.always) return { open: true, always: true };
  const { day, min } = localClock(tz, date);
  let until = null;
  for (const r of h.rules) {
    if (r.days.has(day)) for (const [a, b] of r.ranges) if (min >= a && min < b) until = Math.max(until == null ? 0 : until, b);
    if (r.days.has((day + 6) % 7)) for (const [a, b] of r.ranges) if (b > 1440 && min < b - 1440) until = Math.max(until == null ? 0 : until, b - 1440);
  }
  if (until != null) return { open: true, until: until % 1440 };
  for (let d = 0; d < 8; d++) {
    const dd = (day + d) % 7; let best = null;
    for (const r of h.rules) if (r.days.has(dd)) for (const [a] of r.ranges) if (d > 0 || a > min) best = best == null ? a : Math.min(best, a);
    if (best != null) return { open: false, opensIn: d, opens: best };
  }
  return { open: false };
}
function clockText(min) { const h = Math.floor(min / 60) % 24, m = min % 60; return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "am" : "pm"}`; }
const DAY_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function openText(st, nowDay) {
  if (!st) return "hours not known";
  if (st.open) return st.always ? "open 24 hours" : `open now, until ${clockText(st.until)}`;
  if (st.opens == null) return "closed now";
  return `closed now, opens ${st.opensIn === 0 ? "" : st.opensIn === 1 ? "tomorrow " : DAY_NAME[(nowDay + st.opensIn) % 7] + " "}${clockText(st.opens)}`;
}
function dieselText(feed, tags, now) {
  if (feed && feed.price && feed.price >= 100 && feed.price <= 400) {   // a price outside 100–400 c/L is a feed placeholder, never quoted
    const t = feedTime(feed.updated);
    if (t && now - t <= FUEL_PRICE_MAX_H * 3600e3) { const h = Math.round((now - t) / 3600e3); return `diesel $${(feed.price / 100).toFixed(2)} (checked ${h < 1 ? "under 1" : h} hr ago)`; }
  }
  const d = String((tags && tags["fuel:diesel"]) || "").toLowerCase();
  if (d === "yes") return "diesel: yes (map data)";
  if (d === "no") return "no diesel";
  return "diesel not confirmed";
}
function servoName(tags, feed) {
  const t = tags || {};
  const name = (t.name || (feed && feed.name) || "").trim(), brand = (t.brand || "").trim();
  if (name && brand && !name.toLowerCase().includes(brand.toLowerCase())) return `${name} (${brand})`;
  return name || brand || "Servo";
}
async function handleFuelAhead(request, env) {
  const u = new URL(request.url);
  const num = (k) => parseFloat(u.searchParams.get(k));
  const lat = num("lat"), lng = num("lng"), dlat = num("dlat"), dlng = num("dlng");
  let range = num("range");
  if ([lat, lng, dlat, dlng].some(isNaN)) return jsonResp({ error: "lat, lng, dlat and dlng required" }, 400);
  if (isNaN(range) || range <= 0) range = 100;
  range = Math.min(Math.round(range), 1500);
  const fuel = (u.searchParams.get("fuel") || "diesel").toLowerCase() === "petrol" ? "petrol" : "diesel";   // FUELCHEAP: petrol = unleaded 91
  const fuelCode = fuel === "petrol" ? "U91" : "DL";
  const base = { range_km: range, corridor_km: FUEL_CORRIDOR_KM, fuel };
  const now = Date.now();

  // 1. The route.
  const route = await osrmRoute(lat, lng, dlat, dlng);
  if (route.error) return jsonResp({ ...base, error: "couldn't get the road route", detail: route.error, unavailable: true }, 502);
  const lastIdx = route.pts.length - 1;
  const idxAtKm = (km) => { let i = 0; while (i + 1 <= lastIdx && route.cumKm[i + 1] <= km) i++; return i; };
  const stretchEndKm = Math.min(route.km, range + FUEL_BEYOND_KM);
  const endIdx = idxAtKm(stretchEndKm);
  const startIdx = nearestVertex(route, lat, lng, 0, Math.min(lastIdx, 50)).idx;

  // 2a. OpenStreetMap: ONE bounding-box query over the stretch (cheap for Overpass — a polyline
  //     `around` over 250 km timed out), tags kept; the 3 km corridor is applied in code below.
  let s = 90, w = 180, n = -90, e = -180;
  for (let i = startIdx; i <= endIdx; i++) { const p = route.pts[i]; if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat; if (p.lon < w) w = p.lon; if (p.lon > e) e = p.lon; }
  const pad = 0.04;   // ~4 km, a little more than the corridor
  const bbox = `${(s - pad).toFixed(3)},${(w - pad).toFixed(3)},${(n + pad).toFixed(3)},${(e + pad).toFixed(3)}`;
  // FUELTOWNS: place names come from the SAME query, so every servo can be named after its town.
  const q = `[out:json][timeout:25][bbox:${bbox}];(node["amenity"="fuel"];way["amenity"="fuel"];node["place"~"^(city|town|village|hamlet|locality|suburb)$"]["name"];);out center tags 900;`;
  const osmP = overpass(q);

  // 2b. State price feeds, sampled every 40 km along the stretch; each sample's state picks
  //     its feed — and a state WITHOUT a feed (VIC, NT) is named, never sent elsewhere.
  const samples = []; for (let k = 0; k <= stretchEndKm; k += 40) samples.push(route.pts[idxAtKm(k)]); samples.push(route.pts[endIdx]);
  const statesSeen = new Set(), noFeed = new Set(), feedErrors = new Set();
  const feedCalls = samples.map((p) => { const st = stateOf(p.lat, p.lon); statesSeen.add(st); if (!FEED_NAME[st]) { noFeed.add(st); return Promise.resolve([]); }
    return feedAt(st, p.lat, p.lon, env, fuelCode).then((r) => (r || []).map((x) => ({ ...x, feedName: FEED_NAME[st] }))).catch(() => { feedErrors.add(FEED_NAME[st]); return []; }); });
  const [osmRes, ...feedLists] = await Promise.all([osmP, ...feedCalls]);
  const feedRecs = []; const seenF = new Set();
  for (const r of feedLists.flat()) { if (r.lat == null || r.lon == null) continue; const k = `${(+r.lat).toFixed(4)},${(+r.lon).toFixed(4)}`; if (!seenF.has(k)) { seenF.add(k); feedRecs.push({ ...r, lat: +r.lat, lon: +r.lon }); } }
  const osmOk = !osmRes.error;
  const elements = osmOk ? ((osmRes.data && osmRes.data.elements) || []) : [];
  const osmRecs = osmOk ? osmPlacesNearest(elements.filter((el) => el.tags && el.tags.amenity === "fuel"), "", lat, lng, 300).map((p) => ({ name: p.name, lat: p.lat, lon: p.lon, tags: p.tags, id: p.osmid })) : [];
  // Place names (town > village > hamlet > locality/suburb) for naming servos and stops.
  const PLACE_RANK = { city: 0, town: 0, village: 1, hamlet: 2, suburb: 3, locality: 3 };
  const places = elements.filter((el) => el.tags && el.tags.place && el.tags.name && (el.lat != null || el.center)).map((el) => ({ name: el.tags.name, lat: el.lat != null ? el.lat : el.center.lat, lon: el.lon != null ? el.lon : el.center.lon, rank: PLACE_RANK[el.tags.place] ?? 4 }));
  const townOf = (plat, plon) => {   // nearest named place within 5 km; a proper town beats a locality at similar distance
    let best = null, bestScore = Infinity;
    for (const p of places) { const d = hav(plat, plon, p.lat, p.lon); if (d > 5) continue; const score = d + p.rank * 1.5; if (score < bestScore) { bestScore = score; best = p; } }
    return best ? best.name : null;
  };
  if (!osmOk && !feedRecs.length) return jsonResp({ ...base, error: "servo lookups failed", unavailable: true }, 503);

  // 3. Merge: OSM is the ground truth of what exists; a feed record within 150 m joins it,
  //    a feed record with no OSM twin stands on its own (with no hours / diesel tags).
  const merged = osmRecs.map((o) => ({ ...o, feed: null, src: "osm" }));
  for (const f of feedRecs) {
    const twin = merged.find((m) => hav(m.lat, m.lon, f.lat, f.lon) <= 0.15);
    if (twin) { if (!twin.feed) { twin.feed = f; twin.src = "osm+" + f.feedName; } }
    else merged.push({ name: f.name, lat: f.lat, lon: f.lon, tags: {}, feed: f, src: f.feedName });
  }
  // 4. Ahead, inside the corridor, measured from the driver along the route.
  const ahead = [];
  for (const s of merged) {
    const nv = nearestVertex(route, s.lat, s.lon, startIdx, endIdx);
    if (nv.km > FUEL_CORRIDOR_KM) continue;
    const kmFromYou = route.cumKm[nv.idx] - route.cumKm[startIdx];
    if (nv.idx <= startIdx || kmFromYou < 0.3) continue;
    const secs = route.cumS[nv.idx] - route.cumS[startIdx];
    const st = stateOf(s.lat, s.lon), tz = STATE_TZ[st] || "Australia/Brisbane";
    const h = parseHours(s.tags && s.tags.opening_hours);
    const stNow = h ? hoursStatus(h, tz, new Date(now)) : null;
    const stArr = h ? hoursStatus(h, tz, new Date(now + secs * 1000)) : null;
    const town = townOf(s.lat, s.lon);
    const baseName = servoName(s.tags, s.feed);
    // The feed record is for the CHOSEN fuel: it only tells us about diesel when diesel was asked for.
    const opn = openText(stNow, localClock(tz, new Date(now)).day), dsl = dieselText(fuel === "diesel" ? s.feed : null, s.tags, now);
    const fp = feedPrice(s.feed, now);
    ahead.push({
      // FUELTOWNS: every servo name carries its town ("Caltex Marlborough") unless it already does.
      name: town && !baseName.toLowerCase().includes(town.toLowerCase()) ? `${baseName} ${town}` : baseName,
      town, lat: s.lat, lng: s.lon,
      km_from_you: Math.round(kmFromYou), drive_time: hrsMins(secs / 60),
      open: opn,
      closes_before_arrival: !!(stNow && stNow.open && !stNow.always && stArr && !stArr.open),
      diesel: dsl,
      price: fp ? fp.price : null, price_age_h: fp ? fp.age_h : null,   // FUELCHEAP: the chosen fuel's price, ≤72 h old, else null
      source: s.src, state: st,
      _km: kmFromYou,
      // best-servo rank: open + recent price → open + diesel yes (map) → any open → the rest
      _rank: /^open/.test(opn) ? (/^diesel \$/.test(dsl) ? 0 : /^diesel: yes/.test(dsl) ? 1 : 2) : 3,
    });
  }
  ahead.sort((a, b) => a._km - b._km);

  // 4b. FUELTOWNS: servos within 5 km of each other along the route form ONE stop, named after
  //     its town (the town most of its servos sit in), else "[km] km from you".
  const stops = [];
  for (const s of ahead) {
    const cur = stops[stops.length - 1];
    if (cur && s._km - cur._lastKm <= 5) { cur._servos.push(s); cur._lastKm = s._km; }
    else stops.push({ _servos: [s], _firstKm: s._km, _lastKm: s._km });
  }
  const stopOut = (st) => {
    const servos = st._servos.slice().sort((a, b) => a._rank - b._rank || a._km - b._km);
    const counts = {}; for (const s of st._servos) if (s.town) counts[s.town] = (counts[s.town] || 0) + 1;
    const town = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
    const nearest = st._servos[0], best = servos[0];
    const name = town || `${Math.round(nearest._km)} km from you`;
    // FUELCHEAP: the stop's cheapest servo (lowest price, nearest wins a tie); the servo list is
    // cheapest first, then the unpriced by open/diesel rank.
    const priced = st._servos.filter((s) => s.price != null).sort((a, b) => a.price - b.price || a._km - b._km);
    const cheapest = priced[0] || null;
    const listed = [...priced, ...st._servos.filter((s) => s.price == null).sort((a, b) => a._rank - b._rank || a._km - b._km)];
    return {
      name, town, lat: best.lat, lng: best.lng,
      km_from_you: Math.round(nearest._km), drive_time: nearest.drive_time,
      servo_count: st._servos.length,
      open: best.open, diesel: best.diesel, closes_before_arrival: best.closes_before_arrival,   // the best servo's summary
      best: best.name,
      cheapest: cheapest ? { name: cheapest.name, price: cheapest.price, age_h: cheapest.price_age_h, km_from_you: cheapest.km_from_you } : null,
      servos: listed.map(({ _km, _rank, ...r }) => r),
      _km: nearest._km,
    };
  };
  const stopsOut = stops.map(stopOut);
  const strip = ({ _km, ...r }) => r;
  const withinAll = stopsOut.filter((s) => s._km <= range);          // a stop is within range if its nearest servo is
  // Nearest first, up to 10 stops — the LAST stop inside the range is always shown (it is the headline's "last fuel").
  let within = withinAll.slice(0, FUEL_RESULTS);
  if (withinAll.length > FUEL_RESULTS) within = [...withinAll.slice(0, FUEL_RESULTS - 1), withinAll[withinAll.length - 1]];
  within = within.map(strip);
  const beyondRaw = stopsOut.find((s) => s._km > range);               // the first STOP after the last within range
  const beyond = beyondRaw ? strip(beyondRaw) : null;

  // 5. The headline — every distance from the driver; "last fuel" is the furthest stop inside the range.
  let headline;
  const hName = (st) => st.town ? st.name : st.best;   // a stop with no town is named by its best servo in the headline (never "136 km from you, 136 km from you")
  if (within.length) {
    const lastIn = within[within.length - 1];
    headline = `Last fuel within ${range} km: ${hName(lastIn)}, ${lastIn.km_from_you} km from you. After that: ${beyond ? `${hName(beyond)}, ${beyond.km_from_you} km from you.` : `no servo found in the next ${Math.round(stretchEndKm - range)} km.`}`;
  } else if (beyond) headline = `No fuel within ${range} km. The nearest is ${hName(beyond)}, ${beyond.km_from_you} km from you.`;
  else headline = "No servos found ahead on your route.";
  // FUELCHEAP: the cheapest priced servo among ALL stops within range (nearest wins a tie).
  let cheapestInRange = null;
  for (const st of withinAll) for (const v of st.servos) if (v.price != null && (!cheapestInRange || v.price < cheapestInRange.price || (v.price === cheapestInRange.price && v.km_from_you < cheapestInRange.km_from_you)))
    cheapestInRange = { name: v.name, town: st.town, price: v.price, km_from_you: v.km_from_you, age_h: v.price_age_h };
  const cheapestLine = cheapestInRange
    ? `Cheapest ${fuel} within ${range} km: ${cheapestInRange.name}, $${cheapestInRange.price.toFixed(2)}, ${cheapestInRange.km_from_you} km from you.`
    : `No ${fuel} prices within ${range} km.`;

  // 6. Honest notes: feedless states on the route, a feed or the map data that didn't answer.
  const notes = [];
  for (const st of noFeed) notes.push(`No price feed for ${STATE_NAME[st]}; diesel and prices there come from map data only`);
  for (const f of feedErrors) notes.push(`${f} didn't answer just now; prices from it are missing`);
  if (!osmOk) notes.push("couldn't check map data just now — hours and diesel tags are missing, only priced servos are shown");
  return jsonResp({
    ...base, route: { km: Math.round(route.km), drive_time: hrsMins(route.secs / 60) }, searched_km: Math.round(stretchEndKm),
    headline, cheapest_line: cheapestLine, cheapest_in_range: cheapestInRange,
    results: within, beyond_range: beyond, found: ahead.length, stops_found: stopsOut.length, within_range: withinAll.length,
    ...(notes.length ? { note: notes.join("; ") } : {}),
    sources: { osm: osmOk ? "ok" : "failed", feeds: [...statesSeen].map((s) => `${s}: ${FEED_NAME[s] || "no feed"}`), google_calls: 0 },
  });
}

// ═══ Worker build stamp — plain English, so the phone can check what's live ═══
const WORKER_BUILD = "Navigator Worker — 29 Sep 2026, 03:18 PM AEST (FUELCHEAP: /fuelahead takes fuel=diesel|petrol — prices ≤72 h old per servo, cheapest per stop, cheapest within range, two-line headline)";

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
      "/stay": () => handleStay(request, env),   // STAY: places ahead on the route (up to 10), as finished data (no AI)
      "/stay-phone": () => handleStayPhone(request, env),   // STAYLIST: one place's number on request (500 m rule, cached)
      "/route": () => handleRoute(request),      // STAYAPP: km + drive time to the destination — same OSRM call and cache as /stay, no lookups
      "/fuelahead": () => handleFuelAhead(request, env),   // FUEL: servos ahead within range + the first beyond, no AI, no Google
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
