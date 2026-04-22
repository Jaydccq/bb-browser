/* @meta
{
  "name": "indeed/jobs",
  "description": "搜索 Indeed 职位 (jobs: title, company, location, salary, url)",
  "domain": "www.indeed.com",
  "args": {
    "query": {"required": false, "description": "Search keyword (default: Software Engineer)"},
    "location": {"required": false, "description": "Location filter (default: Remote)"},
    "limit": {"required": false, "description": "Max rows to return (default 20, max 100)"},
    "page": {"required": false, "description": "Page number; maps to Indeed start offset (default 1)"},
    "radius": {"required": false, "description": "Radius in miles"},
    "fromage": {"required": false, "description": "Only jobs posted within N days"},
    "url": {"required": false, "description": "Full Indeed search URL; preserves q, l, fromage, sc, and other filters"}
  },
  "capabilities": ["jobs", "search"],
  "readOnly": true,
  "example": "bb-browser site indeed/jobs \"Software Engineer\" Remote 20"
}
*/

async function indeedJobs(args) {
  const query = stringValue(args.query) || "Software Engineer";
  const locationName = stringValue(args.location) || "Remote";
  const limit = clampInt(args.limit, 20, 1, 100);
  const page = clampInt(args.page, 1, 1, 1000);
  const url = buildSearchUrl(query, locationName, page, args);

  let response;
  try {
    response = await fetch(url, { credentials: "include" });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      hint: "无法访问 Indeed。请先确认浏览器能打开 indeed.com。",
      action: "bb-browser open https://www.indeed.com"
    };
  }

  if (!response.ok) {
    return {
      error: "HTTP " + response.status,
      hint: "Indeed 页面获取失败。若需要登录或验证，请先在浏览器中打开 Indeed 后重试。",
      action: "bb-browser open " + url
    };
  }

  const html = await response.text();
  const parsed = parseJobs(html, url, limit);
  if (parsed.error) return parsed;

  return {
    source: "indeed.com",
    url,
    query,
    location: locationName,
    page,
    count: parsed.jobs.length,
    totalParsed: parsed.totalParsed,
    jobs: parsed.jobs
  };

  function buildSearchUrl(searchQuery, searchLocation, pageNumber, values) {
    const explicitUrl = stringValue(values.url);
    const target = explicitUrl
      ? parseIndeedUrl(explicitUrl)
      : new URL("/jobs", "https://www.indeed.com");

    if (!explicitUrl) {
      target.searchParams.set("q", searchQuery);
      target.searchParams.set("l", searchLocation);
      if (stringValue(values.radius)) target.searchParams.set("radius", stringValue(values.radius));
      if (stringValue(values.fromage)) target.searchParams.set("fromage", stringValue(values.fromage));
    }

    if (pageNumber > 1) {
      target.searchParams.set("start", String((pageNumber - 1) * 10));
    } else {
      target.searchParams.delete("start");
    }
    return target.toString();
  }

  function parseIndeedUrl(value) {
    const parsed = new URL(value, "https://www.indeed.com");
    if (parsed.hostname !== "www.indeed.com" && parsed.hostname !== "indeed.com") {
      return new URL("/jobs", "https://www.indeed.com");
    }
    if (parsed.hostname === "indeed.com") parsed.hostname = "www.indeed.com";
    return parsed;
  }

  function parseJobs(htmlText, pageUrl, maxRows) {
    const doc = new DOMParser().parseFromString(htmlText, "text/html");
    const cards = Array.from(doc.querySelectorAll(".job_seen_beacon"));
    const seen = new Set();
    const jobs = [];

    for (const card of cards) {
      const link = card.querySelector("a[data-jk]");
      const jk = cleanText(link?.getAttribute("data-jk"));
      const title = extractTitle(link);
      if (!jk || !title || seen.has(jk)) continue;
      seen.add(jk);

      const lines = visibleTextLines(card);
      const company = cleanText(card.querySelector("[data-testid='company-name']")?.textContent) || lineAfterTitle(lines, title);
      const locationText = cleanText(card.querySelector("[data-testid='text-location']")?.textContent) || "";
      const attributes = unique(Array.from(card.querySelectorAll("[data-testid='attribute_snippet_testid']"))
        .map((node) => cleanText(node.textContent))
        .filter(Boolean));

      jobs.push({
        position: jobs.length + 1,
        id: jk,
        title,
        company,
        location: locationText,
        salary: findSalary(lines),
        attributes,
        postedAgo: findPostedAgo(lines),
        urgentlyHiring: lines.some((line) => /^Urgently hiring$/i.test(line)),
        sponsored: String(link?.getAttribute("href") || "").includes("/pagead/"),
        snippet: extractSnippet(card, lines, title, company, locationText),
        url: "https://www.indeed.com/viewjob?jk=" + encodeURIComponent(jk)
      });

      if (jobs.length >= maxRows) break;
    }

    if (jobs.length === 0) {
      const pageText = cleanText(doc.body?.textContent || "");
      if (/captcha|verify|robot|security check|additional verification|access denied/i.test(pageText)) {
        return {
          error: "Indeed verification required",
          hint: "Indeed 要求登录、人机验证或阻止了自动读取。请先在浏览器中完成验证后重试。",
          action: "bb-browser open " + pageUrl
        };
      }
      return {
        error: "No Indeed jobs parsed",
        hint: "Indeed 页面没有可解析的职位卡片，可能是页面结构变化或搜索没有结果。",
        action: "bb-browser open " + pageUrl
      };
    }

    return { totalParsed: cards.length, jobs };
  }

  function extractTitle(link) {
    const titleNode = link?.querySelector("span[title]");
    return cleanText(titleNode?.getAttribute("title") || titleNode?.textContent || link?.textContent);
  }

  function lineAfterTitle(lines, title) {
    const index = lines.findIndex((line) => line.toLowerCase() === title.toLowerCase());
    if (index === -1) return "";
    return lines.slice(index + 1).find((line) => !/^(new|urgently hiring)$/i.test(line)) || "";
  }

  function findSalary(lines) {
    return lines.find((line) =>
      /(?:\$|USD)\s*\d|(?:up to|from)\s+\$?\d/i.test(line)
    ) || "";
  }

  function findPostedAgo(lines) {
    return lines.find((line) =>
      /\b(?:just posted|today|new|\d+\s+(?:day|days|hour|hours)\s+ago|posted\s+\d+\s+(?:day|days|hour|hours)\s+ago)\b/i.test(line)
    ) || "";
  }

  function extractSnippet(card, lines, title, company, locationText) {
    const explicit = cleanText(card.querySelector("[data-testid='job-snippet'], .job-snippet")?.textContent);
    if (explicit) return explicit.slice(0, 500);

    const ignored = new Set([title, company, locationText].map((value) => value.toLowerCase()).filter(Boolean));
    const candidate = lines.find((line) => {
      const key = line.toLowerCase();
      return line.length > 60 && !ignored.has(key) && !/similar jobs|upload your resume/i.test(line);
    });
    return (candidate || "").slice(0, 500);
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

  function visibleTextLines(node) {
    const clone = node.cloneNode(true);
    for (const hidden of clone.querySelectorAll("script, style, noscript, svg")) {
      hidden.remove();
    }
    const lines = [];
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const value = cleanText(walker.currentNode.nodeValue);
      if (value) lines.push(value);
    }
    return lines;
  }

  function cleanText(value) {
    return stringValue(value).replace(/\s+/g, " ").trim();
  }
}
