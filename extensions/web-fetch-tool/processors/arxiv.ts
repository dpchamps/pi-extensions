/**
 * arXiv processor — normalizes abstract and PDF URLs into structured metadata.
 *
 * Extracts title, authors, abstract, subjects, comments, DOI, canonical URLs,
 * and submission history from arXiv abstract pages.
 */

import { JSDOM } from "jsdom";

interface ArxivSubmissionVersion {
  version: string;
  date: string;
  size?: string;
  url?: string;
}

interface ArxivResult {
  source: "arxiv";
  id: string;
  version?: string;
  title?: string;
  authors: string[];
  abstract?: string;
  comments?: string;
  subjects: string[];
  primary_subject?: string;
  cite_as?: string;
  doi?: string;
  abs_url: string;
  pdf_url: string;
  html_url?: string;
  submission_history: {
    submitted_by?: string;
    versions: ArxivSubmissionVersion[];
  };
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function normalizeWhitespace(text: string | null | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function withoutDescriptorText(selector: Element | null): string | undefined {
  if (!selector) return undefined;
  const clone = selector.cloneNode(true) as Element;
  clone.querySelectorAll(".descriptor").forEach((node) => node.remove());
  return normalizeWhitespace(clone.textContent);
}

function absoluteUrl(href: string | null | undefined, baseUrl: string): string | undefined {
  if (!href) return undefined;
  return new URL(href, baseUrl).toString();
}

function parseArxivUrl(url: string): {
  id: string;
  version?: string;
  absUrl: string;
  pdfUrl: string;
} {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\.pdf$/i, "").replace(/\/+$/, "");
  const match = path.match(/^\/(abs|pdf)\/(.+)$/);
  if (!match) {
    throw new Error("Unsupported arXiv URL format");
  }

  const rawId = decodeURIComponent(match[2]);
  const versionMatch = rawId.match(/^(.*?)(v\d+)$/i);
  const id = versionMatch ? versionMatch[1] : rawId;
  const version = versionMatch ? versionMatch[2] : undefined;
  const versionedId = version ? `${id}${version}` : id;

  return {
    id,
    version,
    absUrl: `https://arxiv.org/abs/${versionedId}`,
    pdfUrl: `https://arxiv.org/pdf/${versionedId}.pdf`,
  };
}

function extractAuthors(doc: Document): string[] {
  return [...doc.querySelectorAll(".authors a")]
    .map((node) => normalizeWhitespace(node.textContent))
    .filter((value): value is string => Boolean(value));
}

function extractSubjects(doc: Document): {
  subjects: string[];
  primary?: string;
} {
  const subjectsCell = doc.querySelector("td.subjects");
  const primary = normalizeWhitespace(
    doc.querySelector(".primary-subject")?.textContent,
  );

  const subjects = normalizeWhitespace(subjectsCell?.textContent)
    ?.split(/\s*;\s*/)
    .map((subject) => subject.trim())
    .filter(Boolean) || [];

  return { subjects, primary };
}

function extractSubmissionHistory(
  doc: Document,
  baseUrl: string,
): { submitted_by?: string; versions: ArxivSubmissionVersion[] } {
  const block = doc.querySelector(".submission-history");
  if (!block) return { versions: [] };

  const blockText = normalizeWhitespace(block.textContent) || "";
  const submittedBy =
    blockText.match(/From:\s*(.*?)\s*\[view email\]/i)?.[1] ||
    blockText.match(/From:\s*(.*?)\s*\[v\d+\]/i)?.[1] ||
    undefined;

  const html = block.innerHTML;
  const versions = [
    ...html.matchAll(
      /<a[^>]*href="([^"]*\/abs\/[^"#]+)"[^>]*>\[(v\d+)\]<\/a>[\s\S]*?([A-Z][a-z]{2},\s+\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+UTC)(?:\s*\(([^)]+)\))?/g,
    ),
  ].map((match) => ({
    url: absoluteUrl(match[1], baseUrl),
    version: match[2],
    date: match[3],
    size: match[4] || undefined,
  }));

  return {
    submitted_by: submittedBy,
    versions,
  };
}

export default async function processArxiv(
  _input: unknown,
  originalUrl: string,
): Promise<ArxivResult> {
  const { id, version, absUrl, pdfUrl } = parseArxivUrl(originalUrl);

  const response = await fetch(absUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();
  const doc = new JSDOM(html, { url: absUrl }).window.document;

  const title = withoutDescriptorText(doc.querySelector("h1.title"));
  const abstract = withoutDescriptorText(doc.querySelector("blockquote.abstract"));
  const comments = normalizeWhitespace(doc.querySelector("td.comments")?.textContent);
  const citeAs = normalizeWhitespace(doc.querySelector("td.arxivid")?.textContent);
  const doi = absoluteUrl(doc.querySelector("#arxiv-doi-link")?.getAttribute("href"), absUrl);
  const htmlUrl = absoluteUrl(
    [...doc.querySelectorAll("a")].find((a) =>
      normalizeWhitespace(a.textContent) === "HTML (experimental)"
    )?.getAttribute("href"),
    absUrl,
  );
  const authors = extractAuthors(doc);
  const { subjects, primary } = extractSubjects(doc);
  const submission_history = extractSubmissionHistory(doc, absUrl);

  return {
    source: "arxiv",
    id,
    version,
    title,
    authors,
    abstract,
    comments,
    subjects,
    primary_subject: primary,
    cite_as: citeAs,
    doi,
    abs_url: absUrl,
    pdf_url: pdfUrl,
    html_url: htmlUrl,
    submission_history,
  };
}
