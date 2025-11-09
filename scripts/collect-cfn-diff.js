#!/usr/bin/env node
// node:18
// Usage: collect-cfn-diff.js origin/main > cfn_diff_payload.json.gz

import { execSync } from "node:child_process";
import zlib from "zlib";

const baseRef = process.argv[2];
if (!baseRef) { console.error("Usage: collect-cfn-diff.js <baseRef>"); process.exit(2); }

const run = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString();

const changed = run(`git diff --name-status ${baseRef}...HEAD`)
  .trim().split("\n").filter(Boolean).map(line => {
    // e.g. "M\tpath/to/file"
    const [status, ...rest] = line.split(/\s+/);
    const path = rest.pop();
    return { status, path };
  });

// Heuristics: filenames + content sniff
const looksLikeCFNPath = (p) => {
  const lower = p.toLowerCase();
  return (
    lower.endsWith(".template.json") ||
    lower.endsWith(".template.yml") ||
    lower.endsWith(".template.yaml") ||
    lower.endsWith("template.json") ||
    lower.endsWith("template.yml") ||
    lower.endsWith("template.yaml") ||
    lower.includes("/cdk.out/") && lower.endsWith(".json")
  );
};

const headContent = (p) => {
  try { return execSync(`git show HEAD:"${p}"`, { stdio: ["ignore", "pipe", "ignore"] }).toString(); }
  catch { return null; }
};
const baseContent = (p, base) => {
  try { return execSync(`git show ${base}:"${p}"`, { stdio: ["ignore", "pipe", "ignore"] }).toString(); }
  catch { return null; }
};

const sniffCFN = (txt) => {
  if (!txt) return false;
  const head = txt.slice(0, 4000);
  return /AWSTemplateFormatVersion/.test(head) || /(^|\n)Resources\s*:\s*/.test(head);
};

const items = [];

for (const { status, path } of changed) {
  if (!looksLikeCFNPath(path)) {
    // If filename doesn't match, we'll sniff content before skipping
    const hc = headContent(path);
    const bc = baseContent(path, baseRef);
    if (!sniffCFN(hc) && !sniffCFN(bc)) continue;
  }

  const obj = { path, status };

  const base = baseContent(path, baseRef);
  const head = headContent(path);

  obj.base = base || null;
  obj.head = head || null;

  // Also include a tiny summary for your backend (optional)
  obj.meta = {
    base_present: !!obj.base,
    head_present: !!obj.head,
  };

  items.push(obj);
}

const payload = {
  repo: process.env.REPO || "",
  pr: process.env.PR_NUMBER || "",
  sha: process.env.GITHUB_SHA || "",
  actor: process.env.GITHUB_ACTOR || "",
  files: items,
  signature: "cloudcost-cfn-diff-v1"
};

const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
process.stdout.write(gz);
