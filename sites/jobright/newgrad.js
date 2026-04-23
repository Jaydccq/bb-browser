/* @meta
{
  "name": "jobright/newgrad",
  "description": "获取 JobRight newgrad 职位列表 (jobs: title, company, location, salary, detailUrl)",
  "domain": "jobright.ai",
  "args": {
    "limit": {"required": false, "description": "Max rows to return (default 200, max 2500)"},
    "path": {"required": false, "description": "Minisite path after /minisites-jobs/newgrad/ (default us/swe), or a full JobRight minisite URL"},
    "maxAgeHours": {"required": false, "description": "Only return jobs posted within this many hours"},
    "pageSize": {"required": false, "description": "JobRight API page size (default 50, max 100)"},
    "offset": {"required": false, "description": "Start position for paginated API reads (default 0)"}
  },
  "capabilities": ["jobs", "fetch"],
  "readOnly": true,
  "example": "bb-browser site jobright/newgrad 2500 us/swe 24"
}
*/

async function jobrightNewgrad(args) {
  const limit = clampInt(args.limit, 200, 1, 2500);
  const maxAgeHours = optionalPositiveNumber(args.maxAgeHours);
  const pageSize = clampInt(args.pageSize, 50, 1, 100);
  const offset = nonNegativeInt(args.offset, 0);
  const url = buildUrl(args.path || "us/swe");

  try {
    const api = await fetchApiJobs(url, { limit, maxAgeHours, pageSize, offset });
    if (api.jobs.length > 0 || maxAgeHours !== null || offset > 0) {
      return {
        source: "jobright.ai",
        sourceMode: "api",
        url,
        count: api.jobs.length,
        totalAvailable: api.totalAvailable,
        maxAgeHours,
        pageSize,
        offset,
        jobs: api.jobs
      };
    }
  } catch (error) {
    if (offset > 0) {
      return {
        error: "JobRight API failed for paginated offset " + offset,
        hint: "initialJobs fallback cannot honor offset; retry without offset or fix API access.",
        apiError: error instanceof Error ? error.message : String(error)
      };
    }
    const fallback = await fetchInitialJobs(url, limit, maxAgeHours);
    if (fallback.error) {
      return {
        ...fallback,
        apiError: error instanceof Error ? error.message : String(error)
      };
    }
    return {
      ...fallback,
      sourceMode: "initialJobs",
      warning: "JobRight API failed; returned initialJobs fallback. API error: " +
        (error instanceof Error ? error.message : String(error))
    };
  }

  return fetchInitialJobs(url, limit, maxAgeHours);

  async function fetchApiJobs(sourceUrl, options) {
    const category = categoryFromUrl(sourceUrl);
    if (!category) {
      throw new Error("Could not derive JobRight category from minisite URL");
    }

    const now = Date.now();
    const jobs = [];
    const seen = new Set();
    let position = options.offset;
    let total = Number.POSITIVE_INFINITY;

    while (position < total && jobs.length < options.limit) {
      const apiUrl = new URL("/swan/mini-sites/list", sourceUrl);
      apiUrl.searchParams.set("position", String(position));
      apiUrl.searchParams.set("count", String(options.pageSize));

      const response = await fetch(apiUrl.toString(), {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/json"
        },
        body: JSON.stringify({ category })
      });
      if (!response.ok) {
        throw new Error("JobRight list API returned HTTP " + response.status);
      }

      const data = await response.json();
      if (data?.success === false) {
        throw new Error(
          "JobRight list API failed: " +
          (stringify(data.errorMessage) || stringify(data.errorCode) || "unknown error")
        );
      }

      const result = record(data?.result);
      const rawJobs = Array.isArray(result.jobList) ? result.jobList : [];
      const apiTotal = Number(result.total);
      if (Number.isFinite(apiTotal) && apiTotal >= 0) total = apiTotal;
      if (rawJobs.length === 0) break;

      let reachedStale = false;
      for (const [index, rawJob] of rawJobs.entries()) {
        const ageHours = ageHoursFromPostedDate(rawJob?.postedAt, now);
        if (options.maxAgeHours !== null && ageHours !== null && ageHours > options.maxAgeHours) {
          reachedStale = true;
          break;
        }

        const job = normalizeApiJob(rawJob, position + index + 1, now, sourceUrl);
        if (!job) continue;
        const key = job.detailUrl || `${job.company}|${job.title}|${job.location}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push(job);
        if (jobs.length >= options.limit) break;
      }

      if (reachedStale || rawJobs.length < options.pageSize || jobs.length >= options.limit) break;
      position += rawJobs.length;
    }

    return {
      jobs,
      totalAvailable: Number.isFinite(total) ? total : jobs.length
    };
  }

  async function fetchInitialJobs(sourceUrl, rowLimit, ageLimitHours) {
    let response;
    try {
      response = await fetch(sourceUrl, { credentials: "include" });
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        hint: "无法访问 JobRight。请先确认浏览器能打开 jobright.ai。",
        action: "bb-browser open https://jobright.ai/minisites-jobs/newgrad/us/swe"
      };
    }

    if (!response.ok) {
      return {
        error: "HTTP " + response.status,
        hint: "JobRight 页面获取失败。若需要登录，请先在浏览器中登录 JobRight 后重试。",
        action: "bb-browser open https://jobright.ai/"
      };
    }

    const html = await response.text();
    const parsed = parseInitialJobs(html);
    if (parsed.error) {
      return parsed;
    }

    const now = Date.now();
    const jobs = parsed.jobs
      .map((job, index) => normalizeInitialJob(job, index + 1, now))
      .filter((job) => ageLimitHours === null || job.ageHours === null || job.ageHours <= ageLimitHours)
      .slice(0, rowLimit);

    return {
      source: "jobright.ai",
      sourceMode: "initialJobs",
      url: sourceUrl,
      count: jobs.length,
      totalAvailable: parsed.jobs.length,
      maxAgeHours: ageLimitHours,
      offset: 0,
      jobs
    };
  }

  function categoryFromUrl(sourceUrl) {
    const parsed = new URL(sourceUrl);
    const marker = "/minisites-jobs/";
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex < 0) return "";
    const rawPath = parsed.pathname.slice(markerIndex + marker.length);
    const parts = rawPath
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    return parts.length > 0 ? parts.join(":") : "";
  }

  function normalizeApiJob(job, position, nowMs, sourceUrl) {
    const props = record(job?.properties);
    const id = stringify(job?.jobId) || stringify(job?.id);
    const title = stringify(props.title);
    const company = stringify(props.company);
    if (!title && !company) return null;

    const postedAt = Number(job?.postedAt);
    const postedDate = Number.isFinite(postedAt) && postedAt > 0 ? postedAt : null;
    const detailUrl = id ? jobDetailUrl(id, sourceUrl) : "";

    return {
      position,
      id,
      title,
      company,
      location: stringify(props.location),
      workModel: stringify(props.workModel),
      salary: stringify(props.salary),
      postedAt: postedDate === null ? null : new Date(postedDate).toISOString(),
      postedAgo: formatPostedAgo(postedDate, nowMs),
      ageHours: ageHoursFromPostedDate(postedDate, nowMs),
      companySize: stringify(props.companySize),
      industry: listStrings(props.industry),
      qualifications: stringify(props.qualifications).slice(0, 600),
      h1bSponsored: stringify(props.h1bSponsored),
      sponsorshipSupport: parseSponsorshipStatus(stringify(props.h1bSponsored)),
      isNewGrad: parseBoolean(props.isNewGrad),
      detailUrl,
      applyUrl: detailUrl,
      url: detailUrl
    };
  }

  function buildUrl(pathOrUrl) {
    const raw = String(pathOrUrl || "").trim();
    try {
      const parsed = new URL(raw);
      if (parsed.hostname !== "jobright.ai" && !parsed.hostname.endsWith(".jobright.ai")) {
        return "https://jobright.ai/minisites-jobs/newgrad/us/swe";
      }
      return parsed.toString();
    } catch {
      const cleanPath = raw.replace(/^\/+/, "").replace(/^minisites-jobs\/newgrad\/?/, "") || "us/swe";
      return "https://jobright.ai/minisites-jobs/newgrad/" + cleanPath;
    }
  }

  function parseInitialJobs(htmlText) {
    const doc = new DOMParser().parseFromString(htmlText, "text/html");
    const script = doc.querySelector("script#__NEXT_DATA__");
    const raw = script?.textContent?.trim();
    if (!raw) {
      return {
        error: "NEXT_DATA not found",
        hint: "JobRight 页面结构可能已变化；没有找到 __NEXT_DATA__。",
        action: "bb-browser open https://jobright.ai/minisites-jobs/newgrad/us/swe"
      };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      return {
        error: "NEXT_DATA parse failed",
        hint: error instanceof Error ? error.message : String(error),
        action: "bb-browser open https://jobright.ai/minisites-jobs/newgrad/us/swe"
      };
    }

    const jobs = data?.props?.pageProps?.initialJobs;
    if (!Array.isArray(jobs)) {
      return {
        error: "initialJobs not found",
        hint: "JobRight 页面没有暴露 props.pageProps.initialJobs。",
        action: "bb-browser open https://jobright.ai/minisites-jobs/newgrad/us/swe"
      };
    }

    return { jobs };
  }

  function normalizeInitialJob(job, position, nowMs) {
    const postedDate = typeof job.postedDate === "number" ? job.postedDate : null;
    const detailUrl = normalizeUrl(job.applyUrl) || (
      job.id ? "https://jobright.ai/jobs/info/" + encodeURIComponent(job.id) : ""
    );

    return {
      position,
      id: stringify(job.id),
      title: stringify(job.title),
      company: stringify(job.company),
      location: stringify(job.location),
      workModel: stringify(job.workModel),
      salary: stringify(job.salary),
      postedAt: postedDate === null ? null : new Date(postedDate).toISOString(),
      postedAgo: formatPostedAgo(postedDate, nowMs),
      ageHours: ageHoursFromPostedDate(postedDate, nowMs),
      companySize: stringify(job.companySize),
      industry: listStrings(job.industry),
      qualifications: stringify(job.qualifications).slice(0, 600),
      h1bSponsored: stringify(job.h1bSponsored),
      sponsorshipSupport: parseSponsorshipStatus(stringify(job.h1bSponsored)),
      isNewGrad: Boolean(job.isNewGrad),
      detailUrl,
      applyUrl: detailUrl,
      url: detailUrl
    };
  }

  function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  }

  function optionalPositiveNumber(value) {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function nonNegativeInt(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return parsed;
  }

  function normalizeUrl(value) {
    if (!value) return "";
    try {
      const parsed = new URL(String(value), "https://jobright.ai");
      if (!/^https?:$/.test(parsed.protocol)) return "";
      return parsed.toString();
    } catch {
      return "";
    }
  }

  function stringify(value) {
    return value === undefined || value === null ? "" : String(value).trim();
  }

  function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function listStrings(value) {
    if (Array.isArray(value)) return value.map(stringify).filter(Boolean);
    const text = stringify(value);
    return text ? [text] : [];
  }

  function parseBoolean(value) {
    if (typeof value === "boolean") return value;
    const normalized = stringify(value).toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "1";
  }

  function parseSponsorshipStatus(text) {
    const normalized = text.trim().toLowerCase();
    if (!normalized) return "unknown";
    if (/\b(not sure|unknown|n\/a|unclear)\b/.test(normalized)) return "unknown";
    if (
      /\b(no|false)\b/.test(normalized) ||
      normalized.includes("no sponsorship") ||
      normalized.includes("without sponsorship") ||
      normalized.includes("unable to sponsor") ||
      normalized.includes("cannot sponsor") ||
      normalized.includes("can't sponsor")
    ) {
      return "no";
    }
    if (
      /\b(yes|true)\b/.test(normalized) ||
      normalized.includes("sponsor") ||
      normalized.includes("visa support") ||
      normalized.includes("work authorization support")
    ) {
      return "yes";
    }
    return "unknown";
  }

  function jobDetailUrl(jobId, sourceUrl) {
    const id = String(jobId).replace(/"/g, "").trim();
    if (!id) return "";
    const source = new URL(sourceUrl);
    const params = source.searchParams;
    const detail = new URL("/jobs/info/" + encodeURIComponent(id), source.origin);
    detail.searchParams.set("utm_source", params.get("utm_source") || "1100");
    detail.searchParams.set("utm_campaign", params.get("utm_campaign") || "Software Engineering");
    return detail.toString();
  }

  function ageHoursFromPostedDate(postedDate, nowMs) {
    const timestamp = Number(postedDate);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    return round((nowMs - timestamp) / 3600000, 2);
  }

  function formatPostedAgo(postedDate, nowMs) {
    const timestamp = Number(postedDate);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
    const minutes = Math.max(0, Math.floor((nowMs - timestamp) / 60000));
    if (minutes <= 0) return "just now";
    if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;
    const weeks = Math.floor(days / 7);
    return `${weeks} ${weeks === 1 ? "week" : "weeks"} ago`;
  }

  function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }
}
