const SEARCH_TTL_SECONDS = 60 * 60 * 24; // 24h
const DETAILS_TTL_SECONDS = 60 * 60 * 24 * 3; // 72h
const MIN_QUERY_LENGTH = 2;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 min
const RATE_LIMIT_MAX = 30;

const rateMap = new Map();

function corsHeaders(extra = {}) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...extra,
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(extraHeaders),
  });
}

function normalizeQuery(q) {
  return String(q || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function getClientKey(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'unknown'
  );
}

function checkRateLimit(clientKey) {
  const now = Date.now();
  const entry = rateMap.get(clientKey);

  if (!entry || now - entry.startedAt > RATE_LIMIT_WINDOW_MS) {
    rateMap.set(clientKey, { startedAt: now, count: 1 });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count += 1;
  rateMap.set(clientKey, entry);
  return true;
}

async function fetchGoogleTextSearch({ apiKey, query, language = 'ko', region = 'kr' }) {
  const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
  url.searchParams.set('query', query);
  url.searchParams.set('language', language);
  url.searchParams.set('region', region);
  url.searchParams.set('key', apiKey);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Google API HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Google API status ${data.status}`);
  }

  return data;
}

async function fetchGooglePlaceDetails({
  apiKey,
  placeId,
  language = 'ko',
  region = 'kr',
}) {
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set(
    'fields',
    [
      'place_id',
      'name',
      'formatted_address',
      'geometry',
      'types',
      'rating',
      'user_ratings_total',
      'price_level',
      'formatted_phone_number',
      'website',
      'opening_hours',
      'business_status',
      'photos',
      'url',
    ].join(',')
  );
  url.searchParams.set('language', language);
  url.searchParams.set('region', region);
  url.searchParams.set('key', apiKey);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Google Details API HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Google Details API status ${data.status}`);
  }

  return data;
}

function slimGoogleSearchResults(data) {
  return (data.results || []).map((item) => ({
    place_id: item.place_id || '',
    id: item.id || '',
    name: item.name || '',
    formatted_address: item.formatted_address || '',
    geometry: {
      location: {
        lat: item.geometry?.location?.lat ?? null,
        lng: item.geometry?.location?.lng ?? null,
      },
    },
    types: Array.isArray(item.types) ? item.types : [],
    rating: item.rating ?? null,
    user_ratings_total: item.user_ratings_total ?? null,
    price_level: item.price_level ?? null,
    business_status: item.business_status || '',
  }));
}

function slimGoogleDetails(data) {
  const item = data.result || null;
  if (!item) return null;

  return {
    place_id: item.place_id || '',
    name: item.name || '',
    formatted_address: item.formatted_address || '',
    geometry: {
      location: {
        lat: item.geometry?.location?.lat ?? null,
        lng: item.geometry?.location?.lng ?? null,
      },
    },
    types: Array.isArray(item.types) ? item.types : [],
    rating: item.rating ?? null,
    user_ratings_total: item.user_ratings_total ?? null,
    price_level: item.price_level ?? null,
    formatted_phone_number: item.formatted_phone_number || '',
    website: item.website || '',
    business_status: item.business_status || '',
    opening_hours: item.opening_hours || null,
    photos: Array.isArray(item.photos)
      ? item.photos.map((p) => ({
          photo_reference: p.photo_reference || '',
          width: p.width ?? null,
          height: p.height ?? null,
        }))
      : [],
    google_maps_url: item.url || '',
  };
}

async function readJsonFromCache(cache, cacheKey) {
  const hit = await cache.match(cacheKey);
  if (!hit) return null;
  return await hit.json();
}

async function writeJsonToCache(cache, cacheKey, payload, ttlSeconds) {
  const responseToCache = new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${ttlSeconds}`,
    },
  });
  await cache.put(cacheKey, responseToCache);
}

function makeCacheRequest(urlString, originalRequest) {
  return new Request(urlString, {
    method: 'GET',
    headers: {
      accept: originalRequest.headers.get('accept') || 'application/json',
    },
  });
}

async function handleGoogleSearch(request, env, ctx, url) {
  const query = url.searchParams.get('q') || '';
  const lang = url.searchParams.get('lang') || 'ko';
  const region = url.searchParams.get('region') || 'kr';
  const normalizedQuery = normalizeQuery(query);

  if (normalizedQuery.length < MIN_QUERY_LENGTH) {
    return json({
      ok: true,
      provider: 'google',
      query,
      results: [],
      cached: false,
      reason: 'query_too_short',
    });
  }

  const clientKey = getClientKey(request);
  if (!checkRateLimit(clientKey)) {
    return json(
      {
        ok: false,
        error: 'rate_limited',
        message: 'Too many requests. Please try again shortly.',
      },
      429
    );
  }

  const cache = caches.default;
  const cacheUrl = new URL(request.url);
  cacheUrl.search = '';
  cacheUrl.searchParams.set('q', normalizedQuery);
  cacheUrl.searchParams.set('lang', lang);
  cacheUrl.searchParams.set('region', region);
  const cacheKey = makeCacheRequest(cacheUrl.toString(), request);

  const cachedData = await readJsonFromCache(cache, cacheKey);
  if (cachedData) {
    return json({ ...cachedData, cached: true });
  }

  const raw = await fetchGoogleTextSearch({
    apiKey: env.GOOGLE_PLACES_API_KEY,
    query: normalizedQuery,
    language: lang,
    region,
  });

  const payload = {
    ok: true,
    provider: 'google',
    query,
    normalizedQuery,
    results: slimGoogleSearchResults(raw),
    cached: false,
  };

  ctx.waitUntil(writeJsonToCache(cache, cacheKey, payload, SEARCH_TTL_SECONDS));
  return json(payload);
}

async function handleGoogleDetails(request, env, ctx, url) {
  const placeId = String(url.searchParams.get('id') || '').trim();
  const lang = url.searchParams.get('lang') || 'ko';
  const region = url.searchParams.get('region') || 'kr';

  if (!placeId) {
    return json(
      {
        ok: false,
        error: 'missing_place_id',
        message: 'Query param id is required.',
      },
      400
    );
  }

  const clientKey = getClientKey(request);
  if (!checkRateLimit(clientKey)) {
    return json(
      {
        ok: false,
        error: 'rate_limited',
        message: 'Too many requests. Please try again shortly.',
      },
      429
    );
  }

  const cache = caches.default;
  const cacheUrl = new URL(request.url);
  cacheUrl.search = '';
  cacheUrl.searchParams.set('id', placeId);
  cacheUrl.searchParams.set('lang', lang);
  cacheUrl.searchParams.set('region', region);
  const cacheKey = makeCacheRequest(cacheUrl.toString(), request);

  const cachedData = await readJsonFromCache(cache, cacheKey);
  if (cachedData) {
    return json({ ...cachedData, cached: true });
  }

  const raw = await fetchGooglePlaceDetails({
    apiKey: env.GOOGLE_PLACES_API_KEY,
    placeId,
    language: lang,
    region,
  });

  const payload = {
    ok: true,
    provider: 'google',
    placeId,
    result: slimGoogleDetails(raw),
    cached: false,
  };

  ctx.waitUntil(writeJsonToCache(cache, cacheKey, payload, DETAILS_TTL_SECONDS));
  return json(payload);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/api/search/google') {
        return await handleGoogleSearch(request, env, ctx, url);
      }

      if (url.pathname === '/api/place/google/details') {
        return await handleGoogleDetails(request, env, ctx, url);
      }

      if (url.pathname === '/health') {
        return json({
          ok: true,
          service: 'miomi-google-proxy',
          now: new Date().toISOString(),
        });
      }

      return json({ ok: false, error: 'not_found' }, 404);
    } catch (error) {
      return json(
        {
          ok: false,
          error: 'internal_error',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
        500
      );
    }
  },
};
