/* @meta
{
  "name": "jobright/newgrad",
  "description": "获取 JobRight newgrad 职位列表 (jobs: title, company, location, salary, detailUrl)",
  "domain": "jobright.ai",
  "args": {
    "limit": {"required": false, "description": "Max rows to return (default 20, max 100)"},
    "path": {"required": false, "description": "Minisite path after /minisites-jobs/newgrad/ (default us/swe), or a full JobRight minisite URL"},
    "maxAgeHours": {"required": false, "description": "Only return jobs posted within this many hours"}
  },
  "capabilities": ["jobs", "fetch"],
  "readOnly": true,
  "example": "bb-browser site jobright/newgrad 10"
}
*/

async function jobrightNewgrad(args) {
  const limit = clampInt(args.limit, 20, 1, 100);
  const maxAgeHours = optionalPositiveNumber(args.maxAgeHours);
  const url = buildUrl(args.path || "us/swe");

  let response;
  try {
    response = await fetch(url, { credentials: "include" });
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
    .map((job, index) => normalizeJob(job, index + 1, now))
    .filter((job) => maxAgeHours === null || job.ageHours === null || job.ageHours <= maxAgeHours)
    .slice(0, limit);

  return {
    source: "jobright.ai",
    url,
    count: jobs.length,
    totalAvailable: parsed.jobs.length,
    maxAgeHours,
    jobs
  };

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

  function normalizeJob(job, position, nowMs) {
    const postedDate = typeof job.postedDate === "number" ? job.postedDate : null;
    const ageHours = postedDate === null ? null : round((nowMs - postedDate) / 3600000, 2);
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
      ageHours,
      companySize: stringify(job.companySize),
      industry: Array.isArray(job.industry) ? job.industry.map(stringify).filter(Boolean) : [],
      qualifications: stringify(job.qualifications).slice(0, 600),
      h1bSponsored: stringify(job.h1bSponsored),
      isNewGrad: Boolean(job.isNewGrad),
      detailUrl,
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

  function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }
}
