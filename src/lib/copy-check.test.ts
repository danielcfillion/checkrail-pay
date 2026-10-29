import { describe, expect, it } from "vitest";
import { forbiddenCopy, readableFragments } from "./copy-check";

/**
 * DS2-5: no page says "obligation" or shows an internal id. The first block tests the reader of the HTML. The last
 * test renders the main routes of a running server and fails on any finding; it runs when CHECK_COPY_BASE is set:
 *
 *   CHECK_COPY_BASE=http://localhost:3402 CHECK_COPY_AUTH=judge:demo-pass npx vitest run src/lib/copy-check.test.ts
 *
 * (scripts/check-copy.ts runs the same crawl from the command line and prints every finding.)
 */

describe("reading a page as a person does", () => {
  it("counts text and spoken attributes, not URLs, scripts or data", () => {
    const html = `<html><head><meta name="description" content="Checks every request"><script>self.__next_f.push([1,"obligationId obl_abc123def"])</script></head>
      <body><a href="/obligations/obl_4fbc2b0094b54704" title="Open the request">Phuong Transport</a><div data-id="obl_4fbc2b0094b54704">USD 960.00</div><details><summary>Detail</summary><pre>{"message": "used by obligation obl_ef58fe3eeb7e4973"}</pre></details></body></html>`;
    expect(readableFragments(html)).toEqual(["Checks every request", "Open the request", "Phuong Transport", "USD 960.00", "Detail"]);
    expect(forbiddenCopy(html)).toEqual([]);
  });

  it("finds the word and internal ids wherever a person would read them", () => {
    expect(forbiddenCopy(`<p>Every obligation the business has been asked to pay</p>`).map((f) => f.word)).toEqual(["obligation"]);
    expect(forbiddenCopy(`<button aria-label="New obligation">+</button>`).map((f) => f.word)).toEqual(["obligation"]);
    expect(forbiddenCopy(`<span>Same job as obl_4fbc2b0094b54704 (settled)</span>`).map((f) => [f.word, f.severity])).toEqual([["internal id", "warning"]]);
    expect(forbiddenCopy(`<a title="obl_4fbc2b0094b54704">an earlier payment</a>`).map((f) => f.word)).toEqual(["internal id"]);
    expect(forbiddenCopy(`<p>Obligations</p>`)).toHaveLength(1);
  });
});

const BASE = process.env.CHECK_COPY_BASE;

describe.runIf(Boolean(BASE))("the running app (CHECK_COPY_BASE)", () => {
  it("never says obligation on any main route", async () => {
    const { crawlCopy } = await import("../../scripts/check-copy-lib");
    const findings = await crawlCopy(BASE!, process.env.CHECK_COPY_AUTH ?? "judge:demo-pass");
    expect(findings.filter((f) => f.severity === "error").map((f) => `${f.path}: ${f.word}: ${f.context}`)).toEqual([]);
  }, 120_000);
});
