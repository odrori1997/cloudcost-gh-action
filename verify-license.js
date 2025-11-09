#!/usr/bin/env node
// node:18
import https from "https";

const [repo, sha] = process.argv.slice(2);
const [owner, name] = repo.split("/");
const token = process.env.GITHUB_TOKEN;
const key = process.env.YOUR_API_KEY;
const payUrl = "https://cloudcost-action-api.vercel.app/pricing";

function postJSON(url, body, headers={}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: "POST", hostname: u.hostname, path: u.pathname + u.search,
      headers: { "content-type":"application/json", ...headers }
    }, res => {
      let data=""; res.on("data", c=>data+=c);
      res.on("end", ()=>resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(JSON.stringify(body)); req.end();
  });
}

async function setStatus(state, description, target_url) {
  const opts = {
    method: "POST",
    hostname: "api.github.com",
    path: `/repos/${owner}/${name}/statuses/${sha}`,
    headers: { authorization: `Bearer ${token}`, "user-agent":"CloudCost", accept:"application/vnd.github+json", "content-type":"application/json" }
  };
  const body = JSON.stringify({ state, description, target_url, context: "CloudCost" });
  await new Promise((res, rej) => { const r = https.request(opts, _=>{_.on("data",()=>{}); _.on("end",res);}); r.on("error",rej); r.write(body); r.end(); });
}

async function commentPR(message){
  const getPRs = {
    method:"GET", hostname:"api.github.com",
    path: `/repos/${owner}/${name}/commits/${sha}/pulls`,
    headers:{ authorization:`Bearer ${token}`, "user-agent":"CloudCost", accept:"application/vnd.github+json" }
  };
  const pulls = await new Promise((res,rej)=>{ const r=https.request(getPRs,resp=>{let d=""; resp.on("data",c=>d+=c); resp.on("end",()=>res(JSON.parse(d||"[]")));}); r.on("error",rej); r.end();});
  if(!pulls.length) return;
  const pr = pulls[0];
  const post = {
    method:"POST", hostname:"api.github.com",
    path:`/repos/${owner}/${name}/issues/${pr.number}/comments`,
    headers:{ authorization:`Bearer ${token}`, "user-agent":"CloudCost", accept:"application/vnd.github+json", "content-type":"application/json" }
  };
  await new Promise((res,rej)=>{ const r=https.request(post,resp=>{resp.on("data",()=>{}); resp.on("end",res);}); r.on("error",rej); r.write(JSON.stringify({body:message})); r.end();});
}

(async () => {
  const res = await postJSON("https://cloudcost-action-api.vercel.app/api/v1/license/verify",
    { repo_id: repo, sha },
    { Authorization: `Bearer ${key}` }
  );

  if (res.status === 200) {
    await setStatus("success", "License verified", "https://cloudcost-action-api.vercel.app/dashboard");
    console.log("License OK"); return;
  }

  const msg = `🔒 **CloudCost requires a license**
No active license detected for \`${repo}\`.

**Fix:** [Purchase a license](${payUrl}), add \`YOUR_API_KEY\` as a repo secret, then rerun the workflow.`;
  await setStatus("error", "License required – click to purchase", payUrl);
  await commentPR(msg);
  console.error("License required.");
  process.exit(1);
})();
