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

async function overpass(q) {
  const key = q;
  const hit = osmCache.get(key);
  if (hit && Date.now() - hit.ts < OSM_TTL) return { data: hit.data, cached: true };

  let lastErr = "";
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
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
      if (!r.ok) { lastErr = "HTTP " + r.status + " from " + mirror; continue; }
      const data = await r.json();
      if (osmCache.size > 200) osmCache.clear();
      osmCache.set(key, { data, ts: Date.now() });
      return { data };
    } catch (e) {
      lastErr = (e.name === 'AbortError' ? 'timeout from ' : 'error from ') + mirror;
    }
  }
  if (hit) return { data: hit.data, cached: true, stale: true };
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

async function handleCamps(request) {
  const u = new URL(request.url);
  const lat = parseFloat(u.searchParams.get("lat"));
  const lon = parseFloat(u.searchParams.get("lon"));
  const radiusKm = Math.min(parseInt(u.searchParams.get("radius") || "40"), 100);
  if (isNaN(lat) || isNaN(lon)) return jsonResp({ error: "lat and lon required" }, 400);
  const q = `[out:json][timeout:20];(node["tourism"~"camp_site|caravan_site"](around:${radiusKm*1000},${lat},${lon});way["tourism"~"camp_site|caravan_site"](around:${radiusKm*1000},${lat},${lon}););out center tags 150;`;
  const res = await overpass(q);
  if (res.error) return jsonResp({ error: "camps lookup failed", detail: res.error, unavailable: true }, 503);
  const results = osmPlacesNearest(res.data.elements, "", lat, lon, 12).map(p => ({
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

// ═══ Worker build stamp — plain English, so the phone can check what's live ═══
const WORKER_BUILD = "Navigator Worker — 23 Jul 2026, 3:40 PM AEST (adds /transcribe and /version)";

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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    const routes = {
      "/fuel": () => handleFuel(request, env),
      "/poi": () => handlePoi(request),
      "/camps": () => handleCamps(request),
      "/stations": () => handleStations(request),
      "/accom": () => handleAccom(request),
      "/weather": () => handleWeather(request, env),
      "/transcribe": () => handleTranscribe(request, env),
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
