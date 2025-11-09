#!/usr/bin/env node
// node:18
import https from "https";
import fs from "fs";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.REPO;
const [owner, name] = repo.split("/");
const pr = process.env.PR_NUMBER;
const mdPath = process.env.COMMENT_MD || "cloudcost_comment.md";
const body = fs.readFileSync(mdPath, "utf8");

// Marker to upsert on subsequent runs
const MARK = "<!-- cloudcost-cfn-comment -->";
const finalBody = `${body}\n\n${MARK}`;

async function gh(path, method="GET", data=null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method,
      hostname: "api.github.com",
      path,
      headers: {
        "authorization": `Bearer ${token}`,
        "user-agent": "CloudCost",
        "accept": "application/vnd.github+json",
        ...(data ? { "content-type": "application/json" } : {})
      }
    }, res => {
      let d=""; res.on("data", c=>d+=c); res.on("end", ()=>resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

// Find existing comment
const list = await gh(`/repos/${owner}/${name}/issues/${pr}/comments`);
const comments = JSON.parse(list.body || "[]");
const mine = comments.find(c => (c.body || "").includes(MARK));

if (mine) {
  await gh(`/repos/${owner}/${name}/issues/comments/${mine.id}`, "PATCH", { body: finalBody });
  console.log("Updated existing PR comment.");
} else {
  await gh(`/repos/${owner}/${name}/issues/${pr}/comments`, "POST", { body: finalBody });
  console.log("Created PR comment.");
}
