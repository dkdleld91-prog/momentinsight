// Menu placement only. Never boots the application, a collector, or a database.
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

const read = (page) => fs.readFileSync(`src/pages/${page}.html`, "utf8");
const original = (page) => execFileSync("git", ["show", `HEAD:src/pages/${page}.html`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const anchors = (html) => [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gu)].map((match) => match[0]);
const c30Links = (html) => anchors(html).filter((anchor) => /\bdata-coupang-rank-nav(?:\s|>)/u.test(anchor));
const rankGroup = (html) => html.match(/<div class="mi-nav-group">\s*<p class="mi-nav-title">순위 조회·추적<\/p>([\s\S]*?)<\/div>/u)?.[1] || "";
const labItems = (html, page) => html.match(new RegExp(`<div class="mi-nav-lab-items" id="mi-${page}-nav-lab">([\\s\\S]*?)<\\/div>`, "u"))?.[1] || "";

test("C30 is a single development-labelled item only inside the existing collapsed admin lab", () => {
  const html = read("admin");
  const links = c30Links(html);
  assert.equal(links.length, 1, "the menu move must not duplicate C30");
  assert.equal(c30Links(rankGroup(html)).length, 0, "unfinished C30 no longer belongs to the regular ranking group");
  assert.deepEqual(c30Links(labItems(html, "admin")), links);
  assert.match(links[0], />C 30일 순위\s*<small>\(개발중\)<\/small><\/a>$/u);
  assert.match(html, /class="mi-nav-group mi-nav-lab" data-mi-nav-lab/u, "the lab is not made open by default");
  assert.match(html, /data-mi-nav-lab-toggle aria-expanded="false" aria-controls="mi-admin-nav-lab"/u);
});

test("the C30 link preserves the exact existing hidden access gate and route attributes", () => {
  const current = c30Links(read("admin"));
  const previous = c30Links(original("admin"));
  assert.equal(previous.length, 1);
  assert.equal(current.length, 1);
  assert.equal(current[0].match(/^<a\b[^>]*>/u)[0], previous[0].match(/^<a\b[^>]*>/u)[0]);
  assert.match(current[0], /href="#mi-admin-coupang-rank-tracking"/u);
  assert.match(current[0], /data-mi-admin-screen="coupang-rank-tracking"/u);
  assert.match(current[0], /\shidden(?:\s|>)/u);
});

test("N30/P30 ordering and existing client role visibility are unchanged", () => {
  for (const page of ["admin", "client"]) {
    const current = read(page), previous = original(page);
    const existingRanks = anchors(rankGroup(previous)).filter((anchor) => !/\bdata-coupang-rank-nav(?:\s|>)/u.test(anchor));
    assert.deepEqual(anchors(rankGroup(current)), existingRanks, `${page}: all existing N30/P30 rank navigation is byte-identical and ordered`);
    assert.equal(existingRanks.length, 2);
  }
  assert.equal(c30Links(original("client")).length, 0);
  assert.equal(c30Links(read("client")).length, 0, "moving admin C30 must not newly expose it to clients");
  assert.doesNotMatch(labItems(read("client"), "client"), /coupang-rank-tracking/u);
});

test("C30 view and both inline applications remain byte-identical to HEAD", () => {
  const view = (html) => html.match(/<section\b[^>]*data-mi-admin-view="coupang-rank-tracking"[^>]*>[\s\S]*?<\/section>/u)?.[0];
  assert.ok(view(original("admin")));
  assert.equal(view(read("admin")), view(original("admin")), "the C30 screen and collector mount point are untouched");
  const inlineHashes = (html) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)].filter((match) => !/\bsrc\s*=/iu.test(match[1])).map((match) => createHash("sha256").update(match[2]).digest("hex"));
  for (const page of ["admin", "client"]) assert.deepEqual(inlineHashes(read(page)), inlineHashes(original(page)), `${page}: runtime, role gates and CSP hashes remain unchanged`);
});
