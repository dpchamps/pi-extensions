/**
 * web-fetch extension — fetches URLs and extracts structured content.
 *
 * Supports domain-specific processors when available, plus generic HTML and
 * plain-text extraction for everything else.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, readdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// --- Domain config system ---

interface DomainConfig {
  match: string;
  fetch?: { urlTransform?: string; headers?: Record<string, string> };
  processor?: string;
  _pattern?: RegExp;
  _source?: string;
}

const processorCache = new Map<string, Function>();

function loadDomainConfigs(): DomainConfig[] {
  const domainsDir = join(__dirname, "domains");
  try {
    const files = readdirSync(domainsDir).filter((f) => f.endsWith(".json"));
    return files.map((f) => {
      const config = JSON.parse(
        readFileSync(join(domainsDir, f), "utf-8"),
      ) as DomainConfig;
      config._pattern = new RegExp(config.match);
      config._source = f;
      return config;
    });
  } catch {
    return [];
  }
}

function matchDomain(
  url: string,
  configs: DomainConfig[],
): DomainConfig | null {
  for (const config of configs) {
    if (config._pattern!.test(url)) return config;
  }
  return null;
}

async function loadProcessor(processorPath: string): Promise<Function> {
  if (processorCache.has(processorPath))
    return processorCache.get(processorPath)!;
  const absPath = processorPath.startsWith(".")
    ? join(__dirname, processorPath)
    : processorPath;
  const mod = await import(absPath);
  processorCache.set(processorPath, mod.default);
  return mod.default;
}

function transformUrl(
  url: string,
  fetchConfig: NonNullable<DomainConfig["fetch"]>,
): string {
  if (!fetchConfig.urlTransform) return url;
  return fetchConfig.urlTransform.replace("{url}", url);
}

// --- Domain pipeline ---

async function fetchDomainPipeline(
  url: string,
  domainConfig: DomainConfig,
  signal?: AbortSignal,
): Promise<{ content: string; type: string }> {
  const processor = domainConfig.processor
    ? await loadProcessor(domainConfig.processor)
    : null;

  // No fetch config — processor handles everything
  if (!domainConfig.fetch) {
    if (processor) {
      const result = await processor(url, url);
      return { content: JSON.stringify(result, null, 2), type: "json" };
    }
    throw new Error("Domain matched but has no fetch config or processor.");
  }

  const fetchConfig = domainConfig.fetch;
  const fetchUrl = transformUrl(url, fetchConfig);
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    ...fetchConfig.headers,
  };

  const response = await fetch(fetchUrl, {
    headers,
    signal: signal ?? AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const json = await response.json();

  if (processor) {
    const result = await processor(json, url);
    return { content: JSON.stringify(result, null, 2), type: "json" };
  }

  return { content: JSON.stringify(json, null, 2), type: "json" };
}

// --- HTML pipeline ---

async function fetchHtmlPipeline(
  url: string,
  signal?: AbortSignal,
): Promise<{ content: string; type: string }> {
  // Dynamic imports — these need npm install in the extension dir
  const { Readability } = await import("@mozilla/readability");
  const { JSDOM } = await import("jsdom");
  const TurndownService = (await import("turndown")).default;
  const { gfm } = await import("turndown-plugin-gfm");

  function htmlToMarkdown(html: string): string {
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    turndown.use(gfm);
    turndown.addRule("removeEmptyLinks", {
      filter: (node: any) => node.nodeName === "A" && !node.textContent?.trim(),
      replacement: () => "",
    });
    return turndown
      .turndown(html)
      .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
      .replace(/ +/g, " ")
      .replace(/\s+,/g, ",")
      .replace(/\s+\./g, ".")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: signal ?? AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";

  // Plain text / non-HTML
  if (!contentType.includes("html")) {
    const text = await response.text();
    return { content: text, type: "text" };
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (article && article.content) {
    let output = "";
    if (article.title) output += `# ${article.title}\n\n`;
    if (article.byline) output += `> ${article.byline}\n\n`;
    output += htmlToMarkdown(article.content);
    return { content: output, type: "markdown" };
  }

  // Fallback
  const fallbackDoc = new JSDOM(html, { url });
  const body = fallbackDoc.window.document;
  body
    .querySelectorAll("script, style, noscript, nav, header, footer, aside")
    .forEach((el: any) => el.remove());

  const title = body.querySelector("title")?.textContent?.trim();
  const main =
    body.querySelector("main, article, [role='main'], .content, #content") ||
    body.body;

  let output = "";
  if (title) output += `# ${title}\n\n`;

  const text = main?.innerHTML || "";
  if (text.trim().length > 100) {
    output += htmlToMarkdown(text);
    return { content: output, type: "markdown" };
  }

  throw new Error("Could not extract readable content from this page.");
}

// --- Main fetch logic ---

async function webFetch(
  url: string,
  signal?: AbortSignal,
): Promise<{ content: string; type: string }> {
  const domainConfigs = loadDomainConfigs();
  const matchedDomain = matchDomain(url, domainConfigs);

  if (matchedDomain) {
    return fetchDomainPipeline(url, matchedDomain, signal);
  }

  return fetchHtmlPipeline(url, signal);
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and extract its content as markdown or structured JSON. " +
      "Uses domain-specific processors when available, with generic extraction as a fallback. " +
      "No API key or browser required.",
    promptSnippet: "Fetch and extract content from a URL",
    promptGuidelines: [
      "Use web_fetch when you need to read a webpage, documentation, or other URL-based content.",
      "web_fetch returns structured JSON for supported domains and markdown or text for generic pages.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        const result = await webFetch(params.url, signal ?? undefined);
        return {
          content: [{ type: "text" as const, text: result.content }],
          details: { url: params.url, type: result.type },
        };
      } catch (err: any) {
        throw new Error(`web_fetch failed: ${err.message}`);
      }
    },
  });
}
