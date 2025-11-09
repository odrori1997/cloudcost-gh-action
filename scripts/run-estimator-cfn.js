#!/usr/bin/env node
// node:18
// Usage: run-estimator-cfn.js cfn_diff_payload.json.gz > cloudcost_comment.md

import fs from "fs";
import https from "https";

const apiKey = process.env.YOUR_API_KEY;
const repo = process.env.REPO;
const pr = process.env.PR_NUMBER;
const sha = process.env.SHA;
const file = process.argv[2];

if (!apiKey) { console.error("YOUR_API_KEY missing"); process.exit(2); }
if (!file) { console.error("payload .gz path missing"); process.exit(2); }

const buf = fs.readFileSync(file);

function postGzip(url, buffer, headers={}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: "POST",
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        ...headers
      }
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    req.write(buffer);
    req.end();
  });
}

const endpoint = `https://cloudcost-action-api.vercel.app/api/v1/analyze/cfn?repo=${encodeURIComponent(repo)}&pr=${encodeURIComponent(pr)}&sha=${encodeURIComponent(sha)}`;

const res = await postGzip(endpoint, buf, { Authorization: `Bearer ${apiKey}` });

// Expect { md: "..." }
let md = "⚠️ CloudCost: no content returned.";
try { md = JSON.parse(res.body || "{}").md || md; } catch {}
process.stdout.write(md);
