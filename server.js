// Jumping Train — backend łączący appkę z otwartym API PLK (pdp-api.plk-sa.pl)
//
// Klucz API NIGDY nie trafia do frontendu — żyje wyłącznie tutaj, jako zmienna
// środowiskowa PLK_API_KEY. Frontend (appka) rozmawia tylko z tym serwerem.

import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const PLK_API_KEY = process.env.PLK_API_KEY;
const PLK_BASE_URL = "https://pdp-api.plk-sa.pl";

if (!PLK_API_KEY) {
  console.error(
    "BŁĄD: brak zmiennej środowiskowej PLK_API_KEY. Ustaw ją w pliku .env (patrz .env.example) przed uruchomieniem serwera."
  );
  process.exit(1);
}

// ---------- Prosty cache w pamięci, żeby nie zużywać limitu API na powtarzane zapytania ----------
// Limit Basic to 100/godz., 1000/dzień — cache jest tu koniecznością, nie luksusem.
const cache = new Map(); // key -> { data, expiresAt }

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data, ttlMs) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

const TTL_STATIONS_MS = 24 * 60 * 60 * 1000; // słownik stacji zmienia się rzadko — cache na dobę
const TTL_SCHEDULES_MS = 10 * 60 * 1000; // rozkład planowy — 10 minut wystarczy
const TTL_ROUTE_MS = 10 * 60 * 1000;

// ---------- Wywołanie API PLK z obsługą błędów zgodną z ich dokumentacją ----------
async function plkFetch(path, params = {}) {
  const url = new URL(PLK_BASE_URL + path);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  let response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        "X-API-Key": PLK_API_KEY,
        "Content-Type": "application/json",
      },
    });
  } catch (networkErr) {
    const err = new Error("Nie udało się połączyć z API PLK (błąd sieci).");
    err.status = 502;
    err.cause = networkErr;
    throw err;
  }

  if (response.status === 429) {
    const err = new Error(
      "Przekroczono limit zapytań do API PLK (429). Poczekaj chwilę albo rozważ wyższy poziom klucza."
    );
    err.status = 429;
    throw err;
  }

  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch (_) {
      /* odpowiedź mogła nie być JSON-em, np. przy 500 */
    }
    const err = new Error(
      (body && body.message) || `API PLK zwróciło błąd HTTP ${response.status}`
    );
    err.status = response.status;
    err.plkError = body;
    throw err;
  }

  return response.json();
}

// ---------- Middleware obsługi błędów dla tras async ----------
function asyncRoute(handler) {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

// ---------- GET /api/health ----------
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ---------- GET /api/stations?search=Gdynia ----------
// Proxy do słownika stacji PLK, z cache na 24h (słownik stacji prawie się nie zmienia).
app.get(
  "/api/stations",
  asyncRoute(async (req, res) => {
    const search = (req.query.search || "").trim();
    if (search.length < 2) {
      return res.json({ stations: [] });
    }
    const cacheKey = `stations:${search.toLowerCase()}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await plkFetch("/api/v1/dictionaries/stations", {
      search,
      pageSize: 20,
    });
    setCached(cacheKey, data, TTL_STATIONS_MS);
    res.json(data);
  })
);

// ---------- GET /api/schedules?stations=ID1,ID2&date=YYYY-MM-DD ----------
// Surowy przelot do rozkładu planowego PLK dla podanych stacji/daty.
app.get(
  "/api/schedules",
  asyncRoute(async (req, res) => {
    const { stations, date } = req.query;
    if (!stations || !date) {
      const err = new Error("Wymagane parametry: stations, date");
      err.status = 400;
      throw err;
    }
    const cacheKey = `schedules:${stations}:${date}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await plkFetch("/api/v1/schedules", {
      dateFrom: date,
      dateTo: date,
      stations,
    });
    setCached(cacheKey, data, TTL_SCHEDULES_MS);
    res.json(data);
  })
);

// ---------- GET /api/route/:scheduleId/:orderId ----------
// Pełna trasa konkretnego pociągu (lista przystanków z godzinami).
app.get(
  "/api/route/:scheduleId/:orderId",
  asyncRoute(async (req, res) => {
    const { scheduleId, orderId } = req.params;
    const cacheKey = `route:${scheduleId}:${orderId}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await plkFetch(`/api/v1/schedules/route/${scheduleId}/${orderId}`);
    setCached(cacheKey, data, TTL_ROUTE_MS);
    res.json(data);
  })
);

// ---------- GET /api/connections?from=ID&to=ID&date=YYYY-MM-DD&fromName=..&toName=.. ----------
// Wyższego poziomu endpoint zbudowany specjalnie pod appkę Jumping Train:
// znajduje pociągi jadące z from do to danego dnia.
//
// Potwierdzone na żywo (25.08.2026) prawdziwe pola odpowiedzi /api/v1/schedules:
// { schedules: [ { scheduleId, orderId, trainOrderId, name, carrierCode,
//     nationalNumber, commercialCategorySymbol, operatingDates: [...],
//     stations: [ { stationId, orderNumber, arrivalTime, departureTime,
//       arrivalTrainNumber, departureTrainNumber, departurePlatform, departureTrack, ... } ]
// } ] }
// UWAGA: "stations" w każdym wpisie zawiera TYLKO te przystanki, które pasują
// do parametru ?stations=... w zapytaniu (czyli tu: from i to), nie całą trasę.
// To appce w zupełności wystarcza do wyszukiwarki połączeń.
// Domyślnie pytamy tylko o PKP Intercity (IC obejmuje kategorie IC/EIC/EIP/TLK) —
// wycina to pociągi podmiejskie/aglomeracyjne (SKM, Koleje Mazowieckie, regionalne),
// które i tak nie nadają się pod ideę appki (zbyt krótkie trasy, częste przystanki).
// Można nadpisać parametrem ?carriers=IC,KM itd., jeśli ktoś kiedyś zechce inaczej.
const DEFAULT_LONG_DISTANCE_CARRIERS = "IC";

app.get(
  "/api/connections",
  asyncRoute(async (req, res) => {
    const { from, to, date, fromName, toName, carriers } = req.query;
    if (!from || !to || !date) {
      const err = new Error("Wymagane parametry: from, to, date (ID stacji i data YYYY-MM-DD)");
      err.status = 400;
      throw err;
    }

    const carriersInclude = carriers || DEFAULT_LONG_DISTANCE_CARRIERS;
    const cacheKey = `connections:${from}:${to}:${date}:${carriersInclude}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const scheduleData = await plkFetch("/api/v1/schedules", {
      dateFrom: date,
      dateTo: date,
      stations: `${from},${to}`,
      carriersInclude,
    });

    // Prawdziwe pole-kontener nazywa się "routes" (potwierdzone na żywo 25.08.2026),
    // nie "schedules" — mimo że pojedynczy element w środku ma pole "scheduleId".
    const entries = scheduleData?.routes || [];

    const connections = [];
    for (const train of entries) {
      const stops = train.stations || [];
      const fromStop = stops.find((s) => String(s.stationId) === String(from));
      const toStop = stops.find((s) => String(s.stationId) === String(to));
      if (!fromStop || !toStop) continue;
      // upewnij się, że "from" jest wcześniej na trasie niż "to"
      if (fromStop.orderNumber >= toStop.orderNumber) continue;

      connections.push({
        number: `${train.carrierCode || ""} ${train.nationalNumber || ""}`.trim(),
        name: train.name || "",
        scheduleId: train.scheduleId,
        orderId: train.orderId,
        fromStop: {
          station: fromName || `Stacja ${from}`,
          time: (fromStop.departureTime || "").slice(0, 5),
        },
        toStop: {
          station: toName || `Stacja ${to}`,
          time: (toStop.arrivalTime || "").slice(0, 5),
        },
      });
    }

    // sortuj po godzinie odjazdu
    connections.sort((a, b) => (a.fromStop.time || "").localeCompare(b.fromStop.time || ""));

    const result = { connections };
    setCached(cacheKey, result, TTL_SCHEDULES_MS);
    res.json(result);
  })
);

// ---------- Globalny error handler ----------
app.use((err, req, res, next) => {
  const status = err.status || 500;
  console.error(`[${status}] ${req.method} ${req.path} — ${err.message}`);
  res.status(status).json({
    error: true,
    message: err.message,
    plkError: err.plkError || undefined,
  });
});

app.listen(PORT, () => {
  console.log(`Jumping Train backend działa na porcie ${PORT}`);
});
