import { beforeEach, describe, expect, it, vi } from "vitest";
import processArxiv from "./arxiv";

const mockFetch = vi.fn();
global.fetch = mockFetch as typeof fetch;

beforeEach(() => {
  mockFetch.mockReset();
});

const sampleHtml = `
<html>
  <body>
    <h1 class="title mathjax"><span class="descriptor">Title:</span>Attention Is All You Need</h1>
    <div class="authors"><span class="descriptor">Authors:</span><a href="/search/?searchtype=author&amp;query=Vaswani,+A">Ashish Vaswani</a>, <a href="/search/?searchtype=author&amp;query=Shazeer,+N">Noam Shazeer</a></div>
    <blockquote class="abstract mathjax">
      <span class="descriptor">Abstract:</span>The Transformer replaces recurrence.
    </blockquote>
    <div class="metatable">
      <table summary="Additional metadata">
        <tr>
          <td class="tablecell label">Comments:</td>
          <td class="tablecell comments mathjax">15 pages, 5 figures</td>
        </tr>
        <tr>
          <td class="tablecell label">Subjects:</td>
          <td class="tablecell subjects"><span class="primary-subject">Computation and Language (cs.CL)</span>; Machine Learning (cs.LG)</td>
        </tr>
        <tr>
          <td class="tablecell label">Cite as:</td>
          <td class="tablecell arxivid"><span class="arxivid"><a href="https://arxiv.org/abs/1706.03762">arXiv:1706.03762</a> [cs.CL]</span></td>
        </tr>
        <tr>
          <td class="tablecell label">&nbsp;</td>
          <td class="tablecell arxivdoi"><a href="https://doi.org/10.48550/arXiv.1706.03762" id="arxiv-doi-link">https://doi.org/10.48550/arXiv.1706.03762</a></td>
        </tr>
      </table>
    </div>
    <a href="https://arxiv.org/pdf/1706.03762">View PDF</a>
    <a href="https://arxiv.org/html/1706.03762v7">HTML (experimental)</a>
    <div class="submission-history">
      <h2>Submission history</h2>
      From: Llion Jones [<a href="/show-email/f53b7360/1706.03762">view email</a>]
      <br/>
      <strong><a href="/abs/1706.03762v1">[v1]</a></strong>
      Mon, 12 Jun 2017 17:57:34 UTC (1,102 KB)<br/>
      <strong><a href="/abs/1706.03762v7">[v7]</a></strong>
      Wed, 2 Aug 2023 00:41:18 UTC (1,124 KB)
    </div>
  </body>
</html>`;

describe("processArxiv", () => {
  it("extracts structured metadata from abs URLs", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(sampleHtml),
    });

    const result = await processArxiv({}, "https://arxiv.org/abs/1706.03762");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://arxiv.org/abs/1706.03762",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: expect.stringContaining("text/html") }) }),
    );
    expect(result).toMatchObject({
      source: "arxiv",
      id: "1706.03762",
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      abstract: "The Transformer replaces recurrence.",
      comments: "15 pages, 5 figures",
      subjects: ["Computation and Language (cs.CL)", "Machine Learning (cs.LG)"],
      primary_subject: "Computation and Language (cs.CL)",
      cite_as: "arXiv:1706.03762 [cs.CL]",
      doi: "https://doi.org/10.48550/arXiv.1706.03762",
      abs_url: "https://arxiv.org/abs/1706.03762",
      pdf_url: "https://arxiv.org/pdf/1706.03762.pdf",
      html_url: "https://arxiv.org/html/1706.03762v7",
      submission_history: {
        submitted_by: "Llion Jones",
        versions: [
          {
            version: "v1",
            date: "Mon, 12 Jun 2017 17:57:34 UTC",
            size: "1,102 KB",
            url: "https://arxiv.org/abs/1706.03762v1",
          },
          {
            version: "v7",
            date: "Wed, 2 Aug 2023 00:41:18 UTC",
            size: "1,124 KB",
            url: "https://arxiv.org/abs/1706.03762v7",
          },
        ],
      },
    });
  });

  it("normalizes PDF URLs and preserves explicit versions", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(sampleHtml),
    });

    const result = await processArxiv({}, "https://arxiv.org/pdf/1706.03762v7.pdf");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://arxiv.org/abs/1706.03762v7",
      expect.any(Object),
    );
    expect(result.id).toBe("1706.03762");
    expect(result.version).toBe("v7");
    expect(result.abs_url).toBe("https://arxiv.org/abs/1706.03762v7");
    expect(result.pdf_url).toBe("https://arxiv.org/pdf/1706.03762v7.pdf");
  });

  it("returns empty optional fields when metadata is absent", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(`
          <h1 class="title mathjax"><span class="descriptor">Title:</span>Minimal</h1>
          <div class="authors"><span class="descriptor">Authors:</span></div>
          <blockquote class="abstract mathjax"><span class="descriptor">Abstract:</span>Minimal abstract.</blockquote>
        `),
    });

    const result = await processArxiv({}, "https://arxiv.org/abs/2401.00001");

    expect(result).toMatchObject({
      title: "Minimal",
      authors: [],
      abstract: "Minimal abstract.",
      comments: undefined,
      subjects: [],
      primary_subject: undefined,
      cite_as: undefined,
      doi: undefined,
      submission_history: { versions: [] },
    });
  });

  it("throws on non-ok responses", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await expect(processArxiv({}, "https://arxiv.org/abs/does-not-exist")).rejects.toThrow(
      "HTTP 404: Not Found",
    );
  });
});
