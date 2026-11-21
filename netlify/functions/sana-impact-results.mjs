const API_BASE = "https://api.netlify.com/api/v1";
const FORM_NAME = "sana-rating";
const PER_PAGE = 100;
const MAX_PAGES = 100;
const CACHE_TTL_MS = 45_000;

const IMPACT_CATEGORIES = [
  "تعلمت مهارة جديدة",
  "تدربت على مهارة",
  "راجعت معلوماتي",
  "لم أستفد بعد",
];
const ROLE_CATEGORIES = [
  "طالب أو طالبة",
  "معلم أو معلمة",
  "ولي أمر",
  "زائر آخر",
  "غير محدد",
];

let memoryCache = { expiresAt: 0, payload: null, promise: null };

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "same-origin",
    },
  });
}

function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(/,\s*(?=<)/)) {
    const match = part.match(/<([^>]+)>;\s*rel="?next"?/i);
    if (match) return match[1];
  }
  return null;
}

async function fetchNetlifyPage(urlString, token) {
  const url = new URL(urlString);
  if (url.origin !== API_BASE || !url.pathname.startsWith("/api/v1/")) {
    throw new Error("Unexpected pagination URL");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error("Netlify API request failed");
      error.status = response.status;
      throw error;
    }
    const items = await response.json();
    if (!Array.isArray(items)) throw new Error("Unexpected Netlify API response");
    return { items, next: nextPageUrl(response.headers.get("link")) };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAllPages(firstUrl, token) {
  let next = firstUrl;
  let pageCount = 0;
  const rows = [];
  while (next) {
    pageCount += 1;
    if (pageCount > MAX_PAGES) throw new Error("Submission page limit exceeded");
    const result = await fetchNetlifyPage(next, token);
    rows.push(...result.items);
    next = result.next;
  }
  return rows;
}

function emptyStats(formFound) {
  return {
    ok: true,
    formFound,
    formName: FORM_NAME,
    total: 0,
    averageRating: null,
    ratingCounts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
    impactCounts: Object.fromEntries(IMPACT_CATEGORIES.map((x) => [x, 0])),
    roleCounts: Object.fromEntries(ROLE_CATEGORIES.map((x) => [x, 0])),
    impactResponses: 0,
    benefitCount: 0,
    benefitRate: 0,
    firstSubmissionDate: null,
    lastSubmissionDate: null,
    generatedAt: new Date().toISOString(),
  };
}

function normalizeStats(submissions) {
  const stats = emptyStats(true);
  let ratingTotal = 0;
  const dates = [];

  for (const submission of submissions) {
    const data = submission && submission.data && typeof submission.data === "object"
      ? submission.data
      : {};
    const ratingText = String(data.rating ?? "").trim();
    if (!/^[1-5]$/.test(ratingText)) continue;

    stats.total += 1;
    ratingTotal += Number(ratingText);
    stats.ratingCounts[ratingText] += 1;

    const impact = String(data.impact ?? "").trim();
    if (Object.prototype.hasOwnProperty.call(stats.impactCounts, impact)) {
      stats.impactCounts[impact] += 1;
      stats.impactResponses += 1;
      if (impact !== "لم أستفد بعد") stats.benefitCount += 1;
    }

    const roleValue = String(data.role ?? "غير محدد").trim();
    const role = ROLE_CATEGORIES.includes(roleValue) ? roleValue : "غير محدد";
    stats.roleCounts[role] += 1;

    const createdAt = submission && submission.created_at;
    if (typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt))) {
      dates.push(Date.parse(createdAt));
    }
  }

  stats.averageRating = stats.total ? Math.round((ratingTotal / stats.total) * 100) / 100 : null;
  stats.benefitRate = stats.impactResponses
    ? Math.round((stats.benefitCount / stats.impactResponses) * 100)
    : 0;

  if (dates.length) {
    dates.sort((a, b) => a - b);
    stats.firstSubmissionDate = new Date(dates[0]).toISOString().slice(0, 10);
    stats.lastSubmissionDate = new Date(dates[dates.length - 1]).toISOString().slice(0, 10);
  }

  stats.generatedAt = new Date().toISOString();
  return stats;
}

async function loadStats() {
  const token = process.env.NETLIFY_API_TOKEN;
  const siteId = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  if (!token) {
    const error = new Error("Missing required server environment variable");
    error.kind = "configuration";
    throw error;
  }
  if (!siteId) {
    const error = new Error("Missing Netlify site id");
    error.kind = "configuration";
    throw error;
  }

  const formsUrl = new URL(API_BASE + "/sites/" + encodeURIComponent(siteId) + "/forms");
  formsUrl.searchParams.set("page", "1");
  formsUrl.searchParams.set("per_page", String(PER_PAGE));
  const forms = await fetchAllPages(formsUrl.toString(), token);
  const form = forms.find((item) => item && item.name === FORM_NAME);
  if (!form || !form.id) return emptyStats(false);

  const submissionsUrl = new URL(
    API_BASE + "/forms/" + encodeURIComponent(String(form.id)) + "/submissions"
  );
  submissionsUrl.searchParams.set("page", "1");
  submissionsUrl.searchParams.set("per_page", String(PER_PAGE));
  const submissions = await fetchAllPages(submissionsUrl.toString(), token);
  return normalizeStats(submissions);
}

export default async function sanaImpactResults(request) {
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, message: "الطريقة غير مسموحة." }, 405);
  }

  if (memoryCache.payload && Date.now() < memoryCache.expiresAt) {
    return jsonResponse(memoryCache.payload);
  }

  if (!memoryCache.promise) {
    memoryCache.promise = loadStats()
      .then((payload) => {
        memoryCache.payload = payload;
        memoryCache.expiresAt = Date.now() + CACHE_TTL_MS;
        return payload;
      })
      .finally(() => {
        memoryCache.promise = null;
      });
  }

  try {
    return jsonResponse(await memoryCache.promise);
  } catch (error) {
    if (error && error.status) {
      console.error("[sana-impact] Netlify Forms API status:", error.status);
    } else if (error && error.kind === "configuration") {
      console.error("[sana-impact] Netlify function configuration is incomplete.");
    } else {
      console.error("[sana-impact] Unable to load Netlify form results.");
    }
    return jsonResponse(
      { ok: false, message: "تعذر تحميل نتائج التقييمات من Netlify." },
      error && error.kind === "configuration" ? 503 : 502
    );
  }
}
