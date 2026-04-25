/* @meta
{
  "name": "builtin/jobs",
  "description": "搜索 Built In 职位 (jobs: title, company, location, salary, url)",
  "domain": "builtin.com",
  "args": {
    "query": {"required": false, "description": "Search keyword (default: current page search or Software Engineer)"},
    "limit": {"required": false, "description": "Max rows to return (default 20, max 100)"},
    "path": {"required": false, "description": "Built In jobs path or full URL (default: /jobs/hybrid/national/dev-engineering)"},
    "page": {"required": false, "description": "Page number (default: current URL page or 1)"}
  },
  "capabilities": ["jobs", "search"],
  "readOnly": true,
  "example": "bb-browser site builtin/jobs \"Software Engineer\" 20"
}
*/

async function builtinJobs(args) {
  const limit = clampInt(args.limit, 20, 1, 100);
  const url = buildSearchUrl(args);

  let response;
  try {
    response = await fetch(url, { credentials: "include" });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      hint: "无法访问 Built In。请先确认浏览器能打开 builtin.com。",
      action: "bb-browser open https://builtin.com/jobs"
    };
  }

  if (!response.ok) {
    return {
      error: "HTTP " + response.status,
      hint: "Built In 页面获取失败。若需要登录，请先在浏览器中打开 Built In 后重试。",
      action: "bb-browser open https://builtin.com/jobs"
    };
  }

  const html = await response.text();
  const parsed = parseJobs(html, url, limit);
  if (parsed.error) return parsed;

  return {
    source: "builtin.com",
    url,
    query: new URL(url).searchParams.get("search") || "",
    page: Number(new URL(url).searchParams.get("page") || 1),
    count: parsed.jobs.length,
    totalParsed: parsed.totalParsed,
    jobs: parsed.jobs
  };

  function buildSearchUrl(values) {
    const current = new URL(location.href);
    const rawPath = stringValue(values.path);
    const base = rawPath ? parseBuiltInUrl(rawPath) : defaultBuiltInUrl(current);
    const query = stringValue(values.query) || base.searchParams.get("search") || current.searchParams.get("search") || "Software Engineer";
    const page = clampInt(values.page || base.searchParams.get("page") || current.searchParams.get("page"), 1, 1, 1000);

    base.searchParams.set("search", query);
    base.searchParams.delete("page");
    if (page > 1) base.searchParams.set("page", String(page));
    return base.toString();
  }

  function defaultBuiltInUrl(current) {
    if (current.hostname === "builtin.com" && current.pathname.startsWith("/jobs")) {
      return new URL(current.href);
    }
    return new URL("/jobs/hybrid/national/dev-engineering", "https://builtin.com");
  }

  function parseBuiltInUrl(value) {
    const url = new URL(value, "https://builtin.com");
    if (url.hostname !== "builtin.com" && !url.hostname.endsWith(".builtin.com")) {
      return new URL("/jobs/hybrid/national/dev-engineering", "https://builtin.com");
    }
    return url;
  }

  function parseJobs(htmlText, pageUrl, maxRows) {
    const doc = new DOMParser().parseFromString(htmlText, "text/html");
    const cards = Array.from(doc.querySelectorAll('[data-id="job-card"], [id^="job-card-"]'));
    const seen = new Set();
    const jobs = [];

    for (const card of cards) {
      const titleLink = card.querySelector('a[data-id="job-card-title"], a[href^="/job/"]');
      const title = cleanText(titleLink?.textContent || titleLink?.getAttribute("title"));
      const jobUrl = normalizeUrl(titleLink?.getAttribute("href"));
      if (!title || !jobUrl || seen.has(jobUrl)) continue;
      seen.add(jobUrl);

      const attrs = unique(Array.from(card.querySelectorAll(".font-barlow.text-gray-04"))
        .map((node) => cleanText(node.textContent))
        .filter(Boolean));
      const text = visibleText(card);
      const id = cleanText(card.getAttribute("data-job-id") || card.id.replace(/^job-card-/, ""));

      jobs.push({
        position: jobs.length + 1,
        id,
        title,
        company: cleanText(card.querySelector('a[data-id="company-title"]')?.textContent) || companyFromLogo(card),
        postedAgo: firstMatch(text, /\b(?:Reposted\s+)?(?:An|\d+)\s+\w+\s+Ago\b|\bYesterday\b/i),
        workModel: attrs.find(looksLikeWorkModel) || "",
        location: attrs.find((value) => !looksLikeWorkModel(value) && !looksLikeSalary(value) && !looksLikeLevel(value)) || "",
        salary: attrs.find(looksLikeSalary) || "",
        seniority: attrs.find(looksLikeLevel) || "",
        easyApply: /\bEasy Apply\b/i.test(text),
        summary: extractSummary(card),
        url: jobUrl
      });

      if (jobs.length >= maxRows) break;
    }

    if (cards.length > 0 && jobs.length === 0) {
      return {
        error: "No Built In jobs parsed",
        hint: "Built In 页面结构可能已变化；找到了职位卡片但没有解析出职位链接。",
        action: "bb-browser open " + pageUrl
      };
    }

    if (cards.length === 0) {
      const pageText = cleanText(doc.body?.textContent || "");
      if (/captcha|verify|robot|blocked|access denied/i.test(pageText)) {
        return {
          error: "Built In verification required",
          hint: "Built In 要求人机验证或阻止了自动读取。请先在浏览器中完成验证后重试。",
          action: "bb-browser open " + pageUrl
        };
      }
    }

    return { totalParsed: cards.length, jobs };
  }

  function companyFromLogo(card) {
    const alt = card.querySelector('img[alt$=" Logo"]')?.getAttribute("alt") || "";
    return cleanText(alt.replace(/\s+Logo$/, ""));
  }

  function extractSummary(card) {
    const summary = cleanText(card.querySelector(".fs-sm.fw-regular.mb-md.text-gray-04")?.textContent);
    if (summary) return summary.slice(0, 500);
    return "";
  }

  function normalizeUrl(value) {
    if (!value) return "";
    try {
      const parsed = new URL(value, "https://builtin.com");
      if (!/^https?:$/.test(parsed.protocol)) return "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return "";
    }
  }

  function looksLikeSalary(value) {
    return /\$|\b\d+\s*K\b|\bAnnually\b|\bHourly\b|\bper\s+(?:year|hour|month)\b/i.test(value);
  }

  function looksLikeWorkModel(value) {
    return /^(remote|hybrid|on-?site|in-?office)(?:\s+or\s+(?:remote|hybrid|on-?site|in-?office))*$/i.test(value);
  }

  function looksLikeLevel(value) {
    return /\b(?:intern|entry|junior|mid|senior|lead|staff|principal|director|manager|level)\b/i.test(value);
  }

  function firstMatch(value, pattern) {
    const match = String(value || "").match(pattern);
    return match ? cleanText(match[0].replace(/^Reposted\s+/i, "")) : "";
  }

  function unique(values) {
    const seenValues = new Set();
    const result = [];
    for (const value of values) {
      const key = value.toLowerCase();
      if (!key || seenValues.has(key)) continue;
      seenValues.add(key);
      result.push(value);
    }
    return result;
  }

  function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  }

  function stringValue(value) {
    return value === undefined || value === null ? "" : String(value).trim();
  }

  function visibleText(node) {
    const clone = node.cloneNode(true);
    for (const hidden of clone.querySelectorAll("script, style, noscript, svg")) {
      hidden.remove();
    }
    const parts = [];
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const value = cleanText(walker.currentNode.nodeValue);
      if (value) parts.push(value);
    }
    return parts.join(" ");
  }

  function cleanText(value) {
    return stringValue(value).replace(/\s+/g, " ").trim();
  }
}
