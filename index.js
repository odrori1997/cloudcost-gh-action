import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const require = createRequire(import.meta.url);
const core = require('@actions/core');
const github = require('@actions/github');

function runCmd(cmd, options = {}) {
  core.info(`$ ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', ...options });
  } catch (err) {
    throw new Error(`Command failed: ${cmd}`);
  }
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function computeDelta(baseReport, headReport) {
  function indexReport(report) {
    const stacks = new Map();
    for (const s of report.stacks || []) {
      const itemMap = new Map();
      for (const item of s.items || []) {
        const key = `${item.service}|${item.logical_id}`;
        itemMap.set(key, item);
      }
      stacks.set(s.name, {
        name: s.name,
        total: s.total_monthly_usd ?? 0,
        items: itemMap,
      });
    }
    const total =
      report.grand_total_usd ??
      Array.from(stacks.values()).reduce((sum, s) => sum + (s.total || 0), 0);
    return { stacks, total };
  }

  const base = indexReport(baseReport);
  const head = indexReport(headReport);

  const stackNames = new Set([
    ...base.stacks.keys(),
    ...head.stacks.keys(),
  ]);

  const stacksDelta = [];
  for (const stackName of stackNames) {
    const baseStack = base.stacks.get(stackName);
    const headStack = head.stacks.get(stackName);
    const baseTotal = baseStack?.total ?? 0;
    const headTotal = headStack?.total ?? 0;
    const diff = headTotal - baseTotal;

    const itemKeys = new Set([
      ...(baseStack ? baseStack.items.keys() : []),
      ...(headStack ? headStack.items.keys() : []),
    ]);

    const items = [];
    for (const key of itemKeys) {
      const baseItem = baseStack?.items.get(key);
      const headItem = headStack?.items.get(key);
      const baseVal = baseItem?.monthly_usd ?? 0;
      const headVal = headItem?.monthly_usd ?? 0;
      const itemDiff = headVal - baseVal;
      if (itemDiff === 0) continue;
      const [service, logicalId] = key.split('|');
      items.push({
        service,
        logicalId,
        cdkPath: headItem?.cdk_path || baseItem?.cdk_path || undefined,
        base: baseVal,
        head: headVal,
        diff: itemDiff,
        notes: headItem?.notes || baseItem?.notes || [],
        stackName,
      });
    }

    items.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    stacksDelta.push({
      stackName,
      base: baseTotal,
      head: headTotal,
      diff,
      items,
    });
  }

  stacksDelta.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  return {
    total: {
      base: base.total,
      head: head.total,
      diff: head.total - base.total,
    },
    stacks: stacksDelta,
  };
}

function formatUsd(value) {
  return `$${value.toFixed(2)}`;
}

function renderMarkdown(delta, commentTitle) {
  const lines = [];
  lines.push('<!-- cloudcostgh-comment -->');
  lines.push(`## ${commentTitle}`);
  lines.push('');

  const total = delta.total;
  lines.push('**Total monthly cost**');
  lines.push('');
  lines.push('|        | Base | Head | Δ |');
  lines.push('|--------|------|------|---|');
  lines.push(
    `| Amount | ${formatUsd(total.base)} | ${formatUsd(
      total.head,
    )} | ${formatUsd(total.diff)} |`,
  );
  lines.push('');

  const allItems = [];
  for (const stack of delta.stacks) {
    for (const item of stack.items) {
      allItems.push(item);
    }
  }

  allItems.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const topItems = allItems.slice(0, 10);

  if (topItems.length > 0) {
    lines.push('**Top resource deltas**');
    lines.push('');
    lines.push('| Stack | Service | Logical ID | Base | Head | Δ |');
    lines.push('|-------|---------|-----------|------|------|---|');
    for (const item of topItems) {
      lines.push(
        `| ${item.stackName} | ${item.service} | ${item.logicalId} | ${formatUsd(
          item.base,
        )} | ${formatUsd(item.head)} | ${formatUsd(item.diff)} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function upsertPrComment(octokit, commentBody, updateExisting, commentTitle) {
  const context = github.context;
  const { owner, repo } = context.repo;
  const pull = context.payload.pull_request;
  if (!pull) {
    core.info('Not a pull_request event; skipping PR comment.');
    return;
  }
  const issue_number = pull.number;

  const marker = '<!-- cloudcostgh-comment -->';
  const comments = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number,
    per_page: 100,
  });

  const existing = comments.data.find((c) =>
    c.body && c.body.includes(marker),
  );

  if (existing && updateExisting) {
    core.info('Updating existing CloudCost comment.');
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body: commentBody,
    });
  } else {
    core.info('Creating new CloudCost comment.');
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number,
      body: commentBody,
    });
  }
}

async function main() {
  try {
    const backendUrl = 'https://cloudcost-action-api.vercel.app/';
    const region = core.getInput('region') || 'us-east-1';
    const usageProfile = core.getInput('usage_profile') || 'small';
    const analyzerVersion = core.getInput('analyzer_version') || 'v0.1.0';
    const commentTitle =
      core.getInput('comment_title') || 'Cloud Cost Impact';
    const updateExistingInput = core.getInput('update_existing_comment');
    const updateExisting =
      updateExistingInput === '' ? true : updateExistingInput !== 'false';
    const enableUsageReportingInput = core.getInput('enable_usage_reporting');
    const enableUsageReporting =
      enableUsageReportingInput && enableUsageReportingInput !== 'false';
    const githubToken = core.getInput('github_token') || process.env.GITHUB_TOKEN;

    if (!githubToken) {
      core.setFailed(
        'GitHub token is required to post PR comments. Provide GITHUB_TOKEN in env or github_token input.',
      );
      return;
    }

    const apiKeyInput = core.getInput('api_key');
    const apiKey = apiKeyInput || process.env.CLOUDCOST_API_KEY;
    if (!apiKey) {
      core.setFailed(
        'api_key input (or CLOUDCOST_API_KEY env) is required but not set.',
      );
      return;
    }

    const context = github.context;
    const pull = context.payload.pull_request;
    if (!pull) {
      core.setFailed('This action must be run on a pull_request event.');
      return;
    }

    const headSha = pull.head.sha;
    const baseSha = pull.base.sha;

    const tmpDir = process.env.RUNNER_TEMP || os.tmpdir();
    const workDir = process.cwd();
    const analyzerDir = path.join(tmpDir, 'cloudcost-analyzer');
    const analyzerPath = path.join(analyzerDir, 'analyzer');
    const headJson = path.join(tmpDir, 'cloudcost-head-report.json');
    const baseJson = path.join(tmpDir, 'cloudcost-base-report.json');

    fs.mkdirSync(analyzerDir, { recursive: true });

    const analyzerUrl = `https://github.com/odrori1997/cloudcost-analyzer/archive/refs/tags/${analyzerVersion}.tar.gz`;
    const archivePath = path.join(analyzerDir, 'analyzer.tar.gz');

    core.info(`Downloading analyzer from ${analyzerUrl}`);
    runCmd(`curl -sSL "${analyzerUrl}" -o "${archivePath}"`);
    runCmd(`tar -xzf "${archivePath}" -C "${analyzerDir}"`);
    runCmd(`chmod +x "${analyzerPath}"`);

    const startTime = Date.now();

    // Head analysis
    core.startGroup('Analyze head commit');
    runCmd('npx cdk synth --quiet', { cwd: workDir });
    runCmd(
      `"${analyzerPath}" ` +
        `--cdk-out ./cdk.out ` +
        `--region ${region} ` +
        `--usage-profile ${usageProfile} ` +
        `--out-json "${headJson}" ` +
        `--out-md "${path.join(tmpDir, 'cloudcost-head-report.md')}" ` +
        `--api-key "${apiKey}" ` +
        `--backend-url "${backendUrl}"`,
      { cwd: workDir },
    );
    core.endGroup();

    // Base analysis
    core.startGroup('Analyze base commit');
    runCmd(`git checkout ${baseSha}`, { cwd: workDir });
    runCmd('npx cdk synth --quiet', { cwd: workDir });
    runCmd(
      `"${analyzerPath}" ` +
        `--cdk-out ./cdk.out ` +
        `--region ${region} ` +
        `--usage-profile ${usageProfile} ` +
        `--out-json "${baseJson}" ` +
        `--out-md "${path.join(tmpDir, 'cloudcost-base-report.md')}" ` +
        `--api-key "${apiKey}" ` +
        `--backend-url "${backendUrl}"`,
      { cwd: workDir },
    );
    runCmd(`git checkout ${headSha}`, { cwd: workDir });
    core.endGroup();

    const baseReport = readJson(baseJson);
    const headReport = readJson(headJson);
    const delta = computeDelta(baseReport, headReport);
    const markdown = renderMarkdown(delta, commentTitle);

    core.setOutput('delta-json', JSON.stringify(delta));
    core.setOutput('delta-md', markdown);
    core.setOutput('head-total', delta.total.head);
    core.setOutput('base-total', delta.total.base);
    core.setOutput('delta-total', delta.total.diff);

    const octokit = github.getOctokit(githubToken);
    await upsertPrComment(octokit, markdown, updateExisting, commentTitle);

    if (enableUsageReporting) {
      const durationMs = Date.now() - startTime;
      try {
        core.startGroup('Send usage record');
        const usageUrl = `${backendUrl.replace(/\\/$/, '')}/api/v1/usage`;
        await fetch(usageUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            repo: context.repo.owner + '/' + context.repo.repo,
            commit: headSha,
            pr: pull.number,
            duration_ms: durationMs,
            head_total: delta.total.head,
            base_total: delta.total.base,
            delta_total: delta.total.diff,
          }),
        });
        core.endGroup();
      } catch (err) {
        core.warning(`Failed to send usage record: ${err.message || err}`);
      }
    }
  } catch (error) {
    core.setFailed(error.message || String(error));
  }
}

await main();


