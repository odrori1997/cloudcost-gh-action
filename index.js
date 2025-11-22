// Force immediate output - this should appear even if everything else fails
// Write to both stdout and stderr to ensure visibility
process.stdout.write('=== CLOUDCOST ACTION SCRIPT LOADED ===\n');
process.stderr.write('=== CLOUDCOST ACTION SCRIPT LOADED (stderr) ===\n');
process.stdout.write(`Node version: ${process.version}\n`);
process.stderr.write(`Node version (stderr): ${process.version}\n`);
process.stdout.write(`Platform: ${process.platform} ${process.arch}\n`);
process.stderr.write(`Platform (stderr): ${process.platform} ${process.arch}\n`);
process.stdout.write(`Working directory: ${process.cwd()}\n`);
process.stderr.write(`Working directory (stderr): ${process.cwd()}\n`);

// Force flush stdout/stderr (if available)
if (process.stdout.flush) process.stdout.flush();
if (process.stderr.flush) process.stderr.flush();

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

process.stdout.write('Loading @actions/core...\n');
const core = require('@actions/core');
process.stdout.write('Loading @actions/github...\n');
const github = require('@actions/github');
process.stdout.write('All modules loaded successfully\n');

function runCmd(cmd, options = {}) {
  const cmdName = cmd.split(' ')[0];
  console.log(`[CMD] Executing: ${cmdName}`);
  console.log(`[CMD] Full command: ${cmd.replace(/(--api-key\s+)"[^"]+"/g, '$1"***"')}`);
  console.log(`[CMD] Working directory: ${options.cwd || process.cwd()}`);
  console.log(`[CMD] Environment variables present: ${Object.keys(options.env || {}).length > 0 ? 'Yes' : 'No'}`);
  
  try {
    const startTime = Date.now();
    
    // Use 'inherit' so output shows in real-time in GitHub Actions logs
    // This is important for debugging, even though we can't capture the output
    const result = execSync(cmd, { 
      stdio: 'inherit',
      encoding: 'utf8',
      ...options 
    });
    
    const duration = Date.now() - startTime;
    console.log(`[CMD] ✓ Command succeeded: ${cmdName} (took ${duration}ms)`);
    
    // Note: With stdio: 'inherit', result will be undefined for most commands
    // but that's okay - we see the output in real-time which is more important
    if (result && result.length > 0) {
      console.log(`[CMD] Command returned output (length: ${result.length} chars)`);
      if (result.length > 500) {
        console.log(`[CMD] Output preview: ${result.substring(0, 500)}...`);
      } else {
        console.log(`[CMD] Output: ${result}`);
      }
    }
    
    return result;
  } catch (err) {
    console.error(`[CMD] ✗ Command failed: ${cmdName}`);
    console.error(`[CMD] Error message: ${err.message || String(err)}`);
    console.error(`[CMD] Error code: ${err.status || err.code || 'N/A'}`);
    console.error(`[CMD] Error signal: ${err.signal || 'N/A'}`);
    
    // execSync with stdio: 'inherit' doesn't capture stdout/stderr in err
    // but we try to get what we can
    if (err.stdout) {
      console.error(`[CMD] Stdout: ${err.stdout}`);
    }
    if (err.stderr) {
      console.error(`[CMD] Stderr: ${err.stderr}`);
    }
    if (err.output && Array.isArray(err.output)) {
      console.error(`[CMD] Output array length: ${err.output.length}`);
      err.output.forEach((output, idx) => {
        if (output) {
          const outputStr = output.toString();
          if (outputStr.length > 0) {
            console.error(`[CMD] Output[${idx}]: ${outputStr.substring(0, 500)}${outputStr.length > 500 ? '...' : ''}`);
          }
        }
      });
    }
    
    throw new Error(`Command failed: ${cmdName} - ${err.message || String(err)}`);
  }
}

function readJson(filePath) {
  console.log(`Reading JSON file: ${filePath}`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  console.log(`File size: ${raw.length} bytes`);
  const parsed = JSON.parse(raw);
  console.log(`Successfully parsed JSON from ${filePath}`);
  return parsed;
}

function hasAwsCredentials() {
  const env = process.env;
  return !!(
    env.AWS_ACCESS_KEY_ID ||
    env.AWS_ROLE_ARN ||
    env.AWS_WEB_IDENTITY_TOKEN_FILE
  );
}

/**
 * Determines the CDK CLI command to use based on the user's repository.
 * Uses the latest CDK CLI, with two modes:
 * - If AWS credentials are present: run with lookups enabled
 * - If no credentials: run with --no-lookups (requires committed cdk.context.json)
 */
function getCdkSynthCommand(workDir) {
  const hasCreds = hasAwsCredentials();
  if (hasCreds) {
    console.log('[CDK] AWS credentials detected; running synth with lookups enabled');
    return 'npx --yes aws-cdk@latest synth --quiet';
  } else {
    console.log('[CDK] No AWS credentials detected; running synth with --no-lookups');
    console.log('[CDK] To use lookups without credentials, commit cdk.context.json from a prior synth run');
    return 'npx --yes aws-cdk@latest synth --quiet --no-lookups';
  }
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

function logCostEstimate(report, label) {
  const total = report.grand_total_usd || 0;
  console.log(`\n[${label}] Cost Estimate: ${formatUsd(total)}`);
  
  const resources = [];
  for (const stack of report.stacks || []) {
    for (const item of stack.items || []) {
      resources.push({
        stack: stack.name,
        service: item.service,
        logicalId: item.logical_id,
        cost: item.monthly_usd || 0,
      });
    }
  }
  
  resources.sort((a, b) => b.cost - a.cost);
  
  console.log(`[${label}] Resource Breakdown (${resources.length} resources):`);
  for (const res of resources) {
    console.log(`  ${res.service} | ${res.logicalId} | ${res.stack} | ${formatUsd(res.cost)}`);
  }
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
  console.log('=== Starting PR comment upsert ===');
  const context = github.context;
  const { owner, repo } = context.repo;
  console.log(`Repository: ${owner}/${repo}`);
  console.log(`Event name: ${context.eventName}`);
  console.log(`Action: ${context.action}`);
  
  const pull = context.payload.pull_request;
  if (!pull) {
    console.warn('Not a pull_request event; skipping PR comment.');
    console.log(`Context payload keys: ${Object.keys(context.payload).join(', ')}`);
    return;
  }
  
  const issue_number = pull.number;
  console.log(`PR number: ${issue_number}`);
  console.log(`PR head SHA: ${pull.head?.sha}`);
  console.log(`PR base SHA: ${pull.base?.sha}`);
  console.log(`Comment body length: ${commentBody.length} characters`);

  const marker = '<!-- cloudcostgh-comment -->';
  console.log(`Fetching existing comments for PR #${issue_number}...`);
  
  try {
    const comments = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number,
      per_page: 100,
    });
    
    console.log(`Found ${comments.data.length} total comments on PR #${issue_number}`);

    const existing = comments.data.find((c) =>
      c.body && c.body.includes(marker),
    );

    if (existing && updateExisting) {
      console.log(`Updating existing CloudCost comment (ID: ${existing.id}).`);
      const result = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body: commentBody,
      });
      console.log(`✓ Successfully updated comment. Comment URL: ${result.data.html_url}`);
    } else {
      if (existing) {
        console.log(`Found existing comment but updateExisting is false, skipping update.`);
      } else {
        console.log('No existing CloudCost comment found, creating new one.');
      }
      const result = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number,
        body: commentBody,
      });
      console.log(`✓ Successfully created comment. Comment URL: ${result.data.html_url}`);
    }
    console.log('=== PR comment upsert completed successfully ===');
  } catch (error) {
    console.error(`✗ Failed to upsert PR comment: ${error.message || String(error)}`);
    if (error.status) {
      console.error(`HTTP status: ${error.status}`);
    }
    if (error.response) {
      console.error(`Response data: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function main() {
  console.log('========================================');
  console.log('CloudCost GitHub Action - Starting');
  console.log('========================================');
  console.log(`[INIT] Node version: ${process.version}`);
  console.log(`[INIT] Platform: ${process.platform} ${process.arch}`);
  console.log(`[INIT] Working directory: ${process.cwd()}`);
  console.log(`[INIT] Process PID: ${process.pid}`);
  console.log(`[INIT] Environment variables:`);
  console.log(`  - GITHUB_TOKEN: ${process.env.GITHUB_TOKEN ? `Set (${process.env.GITHUB_TOKEN.length} chars)` : 'NOT SET'}`);
  console.log(`  - CLOUDCOST_API_KEY: ${process.env.CLOUDCOST_API_KEY ? `Set (${process.env.CLOUDCOST_API_KEY.length} chars)` : 'NOT SET'}`);
  console.log(`  - APP_CONFIG: ${process.env.APP_CONFIG || 'NOT SET'}`);
  console.log(`  - RUNNER_TEMP: ${process.env.RUNNER_TEMP || 'NOT SET'}`);
  console.log(`  - GITHUB_WORKSPACE: ${process.env.GITHUB_WORKSPACE || 'NOT SET'}`);
  
  try {
    console.log('=== Reading configuration ===');
    const backendUrl = 'https://cloudcost-action-api.vercel.app/';
    console.log(`[CONFIG] Backend URL: ${backendUrl}`);
    console.log(`[CONFIG] [BACKEND] All backend requests will be made to: ${backendUrl}`);
    console.log(`[CONFIG] [BACKEND] The analyzer binary will make pricing API requests to this backend`);
    console.log(`[CONFIG] [BACKEND] Usage reporting will be sent to: ${backendUrl}/api/v1/usage`);
    
    const region = core.getInput('region') || 'us-east-1';
    console.log(`Region: ${region}`);
    
    const usageProfile = core.getInput('usage_profile') || 'small';
    console.log(`Usage profile: ${usageProfile}`);
    
    const analyzerVersion = core.getInput('analyzer_version') || 'v0.1.0';
    console.log(`Analyzer version: ${analyzerVersion}`);
    
    const commentTitle =
      core.getInput('comment_title') || 'Cloud Cost Impact';
    console.log(`Comment title: ${commentTitle}`);
    
    const updateExistingInput = core.getInput('update_existing_comment');
    const updateExisting =
      updateExistingInput === '' ? true : updateExistingInput !== 'false';
    console.log(`Update existing comment: ${updateExisting}`);
    
    const enableUsageReportingInput = core.getInput('enable_usage_reporting');
    const enableUsageReporting =
      enableUsageReportingInput && enableUsageReportingInput !== 'false';
    console.log(`Enable usage reporting: ${enableUsageReporting}`);
    
    const githubToken =
      core.getInput('github_token') || process.env.GITHUB_TOKEN;

    if (!githubToken) {
      console.error('✗ GitHub token is missing');
      core.setFailed(
        'GitHub token is required to post PR comments. Provide github_token input (usually secrets.GITHUB_TOKEN) or set GITHUB_TOKEN env.',
      );
      return;
    }
    console.log(`✓ GitHub token is set (length: ${githubToken.length} chars)`);

    const apiKeyInput = core.getInput('api_key');
    const apiKey = apiKeyInput || process.env.CLOUDCOST_API_KEY;
    if (!apiKey) {
      console.error('✗ API key is missing');
      core.setFailed(
        'api_key input (or CLOUDCOST_API_KEY env) is required but not set.',
      );
      return;
    }
    console.log(`✓ API key is set (length: ${apiKey.length} chars)`);

    console.log('=== Checking GitHub context ===');
    const context = github.context;
    console.log(`[CONTEXT] Event name: ${context.eventName}`);
    console.log(`[CONTEXT] Action: ${context.action || 'N/A'}`);
    console.log(`[CONTEXT] Repository: ${context.repo.owner}/${context.repo.repo}`);
    console.log(`[CONTEXT] Workflow: ${context.workflow || 'N/A'}`);
    console.log(`[CONTEXT] Run ID: ${context.runId}`);
    console.log(`[CONTEXT] SHA: ${context.sha}`);
    console.log(`[CONTEXT] Ref: ${context.ref}`);
    console.log(`[CONTEXT] Actor: ${context.actor || 'N/A'}`);
    console.log(`[CONTEXT] Payload keys: ${Object.keys(context.payload || {}).join(', ')}`);
    
    const pull = context.payload.pull_request;
    if (!pull) {
      console.error('[CONTEXT] ✗ No pull_request found in context');
      console.error(`[CONTEXT] Available payload keys: ${Object.keys(context.payload || {}).join(', ')}`);
      console.error(`[CONTEXT] Payload structure: ${JSON.stringify(context.payload, null, 2).substring(0, 1000)}`);
      core.setFailed('This action must be run on a pull_request event.');
      return;
    }
    
    console.log(`[CONTEXT] ✓ Pull request found: #${pull.number}`);
    console.log(`[CONTEXT] PR state: ${pull.state || 'N/A'}`);
    
    // Force flush to ensure output is visible
    if (process.stdout.flush) process.stdout.flush();
    if (process.stderr.flush) process.stderr.flush();
    
    console.log(`[CONTEXT] PR title: ${pull.title || 'N/A'}`);
    console.log(`[CONTEXT] PR head ref: ${pull.head?.ref || 'N/A'}`);
    console.log(`[CONTEXT] PR base ref: ${pull.base?.ref || 'N/A'}`);
    
    // Safely extract SHA values with better error handling
    console.log(`[CONTEXT] Checking pull.head and pull.base objects...`);
    if (!pull.head) {
      console.error(`[CONTEXT] ✗ Pull request head object is missing`);
      console.error(`[CONTEXT] Pull request object keys: ${Object.keys(pull || {}).join(', ')}`);
      console.error(`[CONTEXT] Pull request object (first 2000 chars): ${JSON.stringify(pull, null, 2).substring(0, 2000)}`);
      throw new Error('Pull request is missing head information');
    }
    
    if (!pull.base) {
      console.error(`[CONTEXT] ✗ Pull request base object is missing`);
      console.error(`[CONTEXT] Pull request object keys: ${Object.keys(pull || {}).join(', ')}`);
      console.error(`[CONTEXT] Pull request object (first 2000 chars): ${JSON.stringify(pull, null, 2).substring(0, 2000)}`);
      throw new Error('Pull request is missing base information');
    }
    
    const headSha = pull.head.sha;
    const baseSha = pull.base.sha;
    console.log(`[CONTEXT] Head SHA: ${headSha || 'MISSING'}`);
    console.log(`[CONTEXT] Base SHA: ${baseSha || 'MISSING'}`);
    console.log(`[CONTEXT] Head object keys: ${Object.keys(pull.head || {}).join(', ')}`);
    console.log(`[CONTEXT] Base object keys: ${Object.keys(pull.base || {}).join(', ')}`);
    
    if (!headSha || !baseSha) {
      console.error(`[CONTEXT] ✗ Missing SHA information`);
      console.error(`[CONTEXT] Head object: ${JSON.stringify(pull.head, null, 2)}`);
      console.error(`[CONTEXT] Base object: ${JSON.stringify(pull.base, null, 2)}`);
      // Force flush before throwing
      if (process.stdout.flush) process.stdout.flush();
      if (process.stderr.flush) process.stderr.flush();
      throw new Error('Pull request is missing head or base SHA information');
    }
    
    // Force flush to ensure output is visible before continuing
    if (process.stdout.flush) process.stdout.flush();
    if (process.stderr.flush) process.stderr.flush();
    
    console.log('=== Setting up working directories ===');
    const tmpDir = process.env.RUNNER_TEMP || os.tmpdir();
    const workDir = process.cwd();
    console.log(`Temporary directory: ${tmpDir}`);
    console.log(`Working directory: ${workDir}`);
    
    const analyzerDir = path.join(tmpDir, 'cloudcost-analyzer');
    const analyzerPath = path.join(analyzerDir, 'analyzer');
    const headJson = path.join(tmpDir, 'cloudcost-head-report.json');
    const baseJson = path.join(tmpDir, 'cloudcost-base-report.json');
    
    console.log(`Analyzer directory: ${analyzerDir}`);
    console.log(`Analyzer path: ${analyzerPath}`);
    console.log(`Head report JSON: ${headJson}`);
    console.log(`Base report JSON: ${baseJson}`);

    console.log('Creating analyzer directory...');
    fs.mkdirSync(analyzerDir, { recursive: true });
    console.log(`✓ Analyzer directory created`);

    const analyzerUrl = `https://github.com/odrori1997/cloudcost-analyzer/releases/download/${analyzerVersion}/analyzer`;
    console.log(`=== Downloading analyzer ===`);
    console.log(`[DOWNLOAD] Analyzer URL: ${analyzerUrl}`);
    console.log(`[DOWNLOAD] Target path: ${analyzerPath}`);
    console.log(`[DOWNLOAD] Analyzer directory exists: ${fs.existsSync(analyzerDir)}`);
    
    if (fs.existsSync(analyzerPath)) {
      console.log(`[DOWNLOAD] Analyzer already exists, removing old version...`);
      fs.unlinkSync(analyzerPath);
    }
    
    console.log(`[DOWNLOAD] Starting download...`);
    const downloadStartTime = Date.now();
    runCmd(`curl -sSL "${analyzerUrl}" -o "${analyzerPath}"`);
    const downloadDuration = Date.now() - downloadStartTime;
    console.log(`[DOWNLOAD] Download command completed (took ${downloadDuration}ms)`);
    
    if (fs.existsSync(analyzerPath)) {
      const stats = fs.statSync(analyzerPath);
      console.log(`[DOWNLOAD] ✓ Analyzer downloaded (size: ${stats.size} bytes)`);
      if (stats.size === 0) {
        throw new Error(`Downloaded analyzer file is empty!`);
      }
    } else {
      throw new Error(`Analyzer file not found after download: ${analyzerPath}`);
    }
    
    console.log(`[DOWNLOAD] Making analyzer executable...`);
    runCmd(`chmod +x "${analyzerPath}"`);
    const chmodStats = fs.statSync(analyzerPath);
    const isExecutable = (chmodStats.mode & parseInt('111', 8)) !== 0;
    if (isExecutable) {
      console.log(`[DOWNLOAD] ✓ Analyzer made executable`);
    } else {
      console.warn(`[DOWNLOAD] WARNING: Analyzer may not be executable (mode: ${chmodStats.mode.toString(8)})`);
    }

    const startTime = Date.now();
    console.log(`Start time: ${new Date(startTime).toISOString()}`);

    // Head analysis
    console.log('=== Starting head commit analysis ===');
    core.startGroup('Analyze head commit');
    console.log(`[HEAD] Current git SHA: ${headSha}`);
    console.log(`[HEAD] Verifying git state...`);
    try {
      const gitStatus = runCmd('git status --short', { cwd: workDir, encoding: 'utf8' });
      console.log(`[HEAD] Git status: ${gitStatus || '(clean)'}`);
    } catch (e) {
      console.warn(`[HEAD] Could not get git status: ${e.message}`);
    }
    
    console.log(`[HEAD] Checking if cdk.out exists before synth...`);
    const cdkOutPath = path.join(workDir, 'cdk.out');
    if (fs.existsSync(cdkOutPath)) {
      console.log(`[HEAD] cdk.out exists, listing contents...`);
      try {
        const cdkOutContents = fs.readdirSync(cdkOutPath);
        console.log(`[HEAD] cdk.out contains: ${cdkOutContents.join(', ')}`);
      } catch (e) {
        console.warn(`[HEAD] Could not list cdk.out: ${e.message}`);
      }
    } else {
      console.log(`[HEAD] cdk.out does not exist yet (will be created by synth)`);
    }
    
    console.log('[HEAD] Running CDK synth for head commit...');
    const cdkCmd = getCdkSynthCommand(workDir);
    const synthStartTime = Date.now();
    try {
      runCmd(cdkCmd, { cwd: workDir });
      const synthDuration = Date.now() - synthStartTime;
      console.log(`[HEAD] ✓ CDK synth completed for head (took ${synthDuration}ms)`);
    } catch (error) {
      console.error(`[HEAD] ✗ CDK synth failed: ${error.message}`);
      if (!hasAwsCredentials()) {
        core.setFailed(
          [
            'CDK synth failed while running without AWS credentials.',
            'Your CDK app is using context lookups (for example Vpc.fromLookup) which require either:',
            '  1) A committed cdk.context.json generated by running "cdk synth" locally with AWS credentials, or',
            '  2) Refactoring your stacks to avoid CDK lookups (e.g. pass VPC / subnet IDs directly instead of using fromLookup).',
            '',
            'Once you have either committed cdk.context.json or removed lookups, re-run this workflow.'
          ].join('\n')
        );
        return;
      }
      throw error;
    }
    
    console.log(`[HEAD] Verifying cdk.out after synth...`);
    if (fs.existsSync(cdkOutPath)) {
      try {
        const cdkOutContents = fs.readdirSync(cdkOutPath);
        console.log(`[HEAD] cdk.out now contains: ${cdkOutContents.join(', ')}`);
      } catch (e) {
        console.warn(`[HEAD] Could not list cdk.out after synth: ${e.message}`);
      }
    } else {
      console.error(`[HEAD] ✗ cdk.out still does not exist after synth!`);
      throw new Error('CDK synth did not create cdk.out directory');
    }
    
    console.log('[HEAD] Verifying analyzer binary exists...');
    if (!fs.existsSync(analyzerPath)) {
      throw new Error(`Analyzer binary not found at: ${analyzerPath}`);
    }
    const analyzerStats = fs.statSync(analyzerPath);
    console.log(`[HEAD] Analyzer binary exists (${analyzerStats.size} bytes, executable: ${(analyzerStats.mode & parseInt('111', 8)) !== 0})`);
    
    console.log('[HEAD] Running analyzer for head commit...');
    const headAnalyzerCmd = `"${analyzerPath}" ` +
      `--cdk-out ./cdk.out ` +
      `--region ${region} ` +
      `--usage-profile ${usageProfile} ` +
      `--out-json "${headJson}" ` +
      `--out-md "${path.join(tmpDir, 'cloudcost-head-report.md')}" ` +
      `--api-key "${apiKey}" ` +
      `--backend-url "${backendUrl}"`;
    console.log(`[HEAD] Analyzer command (sanitized): ${headAnalyzerCmd.replace(apiKey, '***')}`);
    console.log(`[HEAD] Backend URL: ${backendUrl}`);
    console.log(`[HEAD] Expected output JSON: ${headJson}`);
    
    // Log what backend requests the analyzer will make
    console.log(`[HEAD] [BACKEND] Analyzer will make requests to backend:`);
    console.log(`[HEAD] [BACKEND]   - Base URL: ${backendUrl}`);
    console.log(`[HEAD] [BACKEND]   - API Key: Set (${apiKey.length} chars, starts with: ${apiKey.substring(0, 4)}...)`);
    console.log(`[HEAD] [BACKEND]   - Region: ${region}`);
    console.log(`[HEAD] [BACKEND]   - Usage Profile: ${usageProfile}`);
    console.log(`[HEAD] [BACKEND]   - The analyzer will query pricing data from the backend API`);
    console.log(`[HEAD] [BACKEND]   - Watch for analyzer's HTTP request logs above`);
    
    const analyzerStartTime = Date.now();
    console.log(`[HEAD] [BACKEND] Starting analyzer execution (will make backend requests)...`);
    runCmd(headAnalyzerCmd, { cwd: workDir });
    const analyzerDuration = Date.now() - analyzerStartTime;
    console.log(`[HEAD] Analyzer command completed (took ${analyzerDuration}ms)`);
    console.log(`[HEAD] [BACKEND] Analyzer execution finished - check above for any HTTP request logs from the analyzer`);
    
    console.log(`[HEAD] Checking for head report file...`);
    if (fs.existsSync(headJson)) {
      const stats = fs.statSync(headJson);
      console.log(`[HEAD] ✓ Head report generated (size: ${stats.size} bytes)`);
      if (stats.size === 0) {
        console.error(`[HEAD] ✗ Head report file is empty!`);
        throw new Error(`Head report file is empty: ${headJson}`);
      }
      // Log first few lines of the report for debugging
      try {
        const reportPreview = fs.readFileSync(headJson, 'utf8').substring(0, 500);
        console.log(`[HEAD] Report preview: ${reportPreview}...`);
      } catch (e) {
        console.warn(`[HEAD] Could not read report preview: ${e.message}`);
      }
    } else {
      console.error(`[HEAD] ✗ Head report file not found: ${headJson}`);
      console.error(`[HEAD] Listing temp directory contents...`);
      try {
        const tempContents = fs.readdirSync(tmpDir);
        console.error(`[HEAD] Temp directory contains: ${tempContents.join(', ')}`);
      } catch (e) {
        console.error(`[HEAD] Could not list temp directory: ${e.message}`);
      }
      throw new Error(`Head report file not found: ${headJson}`);
    }
    core.endGroup();

    // Base analysis
    console.log('=== Starting base commit analysis ===');
    core.startGroup('Analyze base commit');
    console.log(`[BASE] Checking out base SHA: ${baseSha}`);
    const checkoutStartTime = Date.now();
    runCmd(`git checkout ${baseSha}`, { cwd: workDir });
    const checkoutDuration = Date.now() - checkoutStartTime;
    console.log(`[BASE] ✓ Checked out base commit (took ${checkoutDuration}ms)`);
    
    console.log(`[BASE] Verifying git state after checkout...`);
    try {
      const currentSha = runCmd('git rev-parse HEAD', { cwd: workDir, encoding: 'utf8' }).trim();
      console.log(`[BASE] Current HEAD SHA: ${currentSha}`);
      if (currentSha !== baseSha) {
        console.warn(`[BASE] WARNING: Current SHA (${currentSha}) does not match expected base SHA (${baseSha})`);
      }
    } catch (e) {
      console.warn(`[BASE] Could not verify git SHA: ${e.message}`);
    }
    
    console.log(`[BASE] Cleaning up old cdk.out if exists...`);
    const baseCdkOutPath = path.join(workDir, 'cdk.out');
    if (fs.existsSync(baseCdkOutPath)) {
      try {
        fs.rmSync(baseCdkOutPath, { recursive: true, force: true });
        console.log(`[BASE] Removed old cdk.out`);
      } catch (e) {
        console.warn(`[BASE] Could not remove old cdk.out: ${e.message}`);
      }
    }
    
    console.log('[BASE] Running CDK synth for base commit...');
    const baseCdkCmd = getCdkSynthCommand(workDir);
    const baseSynthStartTime = Date.now();
    try {
      runCmd(baseCdkCmd, { cwd: workDir });
      const baseSynthDuration = Date.now() - baseSynthStartTime;
      console.log(`[BASE] ✓ CDK synth completed for base (took ${baseSynthDuration}ms)`);
    } catch (error) {
      console.error(`[BASE] ✗ CDK synth failed: ${error.message}`);
      if (!hasAwsCredentials()) {
        core.setFailed(
          [
            'CDK synth for the base commit failed while running without AWS credentials.',
            'Your CDK app is using context lookups (for example Vpc.fromLookup) which require either:',
            '  1) A committed cdk.context.json generated by running "cdk synth" locally with AWS credentials, or',
            '  2) Refactoring your stacks to avoid CDK lookups (e.g. pass VPC / subnet IDs directly instead of using fromLookup).',
            '',
            'Once you have either committed cdk.context.json or removed lookups, re-run this workflow.'
          ].join('\n')
        );
        return;
      }
      throw error;
    }
    
    console.log(`[BASE] Verifying cdk.out after synth...`);
    if (fs.existsSync(baseCdkOutPath)) {
      try {
        const cdkOutContents = fs.readdirSync(baseCdkOutPath);
        console.log(`[BASE] cdk.out contains: ${cdkOutContents.join(', ')}`);
      } catch (e) {
        console.warn(`[BASE] Could not list cdk.out after synth: ${e.message}`);
      }
    } else {
      console.error(`[BASE] ✗ cdk.out does not exist after synth!`);
      throw new Error('CDK synth did not create cdk.out directory for base');
    }
    
    console.log('[BASE] Running analyzer for base commit...');
    const baseAnalyzerCmd = `"${analyzerPath}" ` +
      `--cdk-out ./cdk.out ` +
      `--region ${region} ` +
      `--usage-profile ${usageProfile} ` +
      `--out-json "${baseJson}" ` +
      `--out-md "${path.join(tmpDir, 'cloudcost-base-report.md')}" ` +
      `--api-key "${apiKey}" ` +
      `--backend-url "${backendUrl}"`;
    console.log(`[BASE] Analyzer command (sanitized): ${baseAnalyzerCmd.replace(apiKey, '***')}`);
    console.log(`[BASE] Backend URL: ${backendUrl}`);
    console.log(`[BASE] Expected output JSON: ${baseJson}`);
    
    // Log what backend requests the analyzer will make
    console.log(`[BASE] [BACKEND] Analyzer will make requests to backend:`);
    console.log(`[BASE] [BACKEND]   - Base URL: ${backendUrl}`);
    console.log(`[BASE] [BACKEND]   - API Key: Set (${apiKey.length} chars, starts with: ${apiKey.substring(0, 4)}...)`);
    console.log(`[BASE] [BACKEND]   - Region: ${region}`);
    console.log(`[BASE] [BACKEND]   - Usage Profile: ${usageProfile}`);
    console.log(`[BASE] [BACKEND]   - The analyzer will query pricing data from the backend API`);
    console.log(`[BASE] [BACKEND]   - Watch for analyzer's HTTP request logs above`);
    
    const baseAnalyzerStartTime = Date.now();
    console.log(`[BASE] [BACKEND] Starting analyzer execution (will make backend requests)...`);
    runCmd(baseAnalyzerCmd, { cwd: workDir });
    const baseAnalyzerDuration = Date.now() - baseAnalyzerStartTime;
    console.log(`[BASE] Analyzer command completed (took ${baseAnalyzerDuration}ms)`);
    console.log(`[BASE] [BACKEND] Analyzer execution finished - check above for any HTTP request logs from the analyzer`);
    
    console.log(`[BASE] Checking for base report file...`);
    if (fs.existsSync(baseJson)) {
      const stats = fs.statSync(baseJson);
      console.log(`[BASE] ✓ Base report generated (size: ${stats.size} bytes)`);
      if (stats.size === 0) {
        console.error(`[BASE] ✗ Base report file is empty!`);
        throw new Error(`Base report file is empty: ${baseJson}`);
      }
      // Log first few lines of the report for debugging
      try {
        const reportPreview = fs.readFileSync(baseJson, 'utf8').substring(0, 500);
        console.log(`[BASE] Report preview: ${reportPreview}...`);
      } catch (e) {
        console.warn(`[BASE] Could not read report preview: ${e.message}`);
      }
    } else {
      console.error(`[BASE] ✗ Base report file not found: ${baseJson}`);
      console.error(`[BASE] Listing temp directory contents...`);
      try {
        const tempContents = fs.readdirSync(tmpDir);
        console.error(`[BASE] Temp directory contains: ${tempContents.join(', ')}`);
      } catch (e) {
        console.error(`[BASE] Could not list temp directory: ${e.message}`);
      }
      throw new Error(`Base report file not found: ${baseJson}`);
    }
    
    console.log(`Checking out head SHA: ${headSha}`);
    runCmd(`git checkout ${headSha}`, { cwd: workDir });
    console.log('✓ Checked out head commit');
    core.endGroup();

    console.log('=== Computing cost delta ===');
    const baseReport = readJson(baseJson);
    console.log(`Base report total: $${baseReport.grand_total_usd || 'N/A'}`);
    console.log(`Base report stacks: ${(baseReport.stacks || []).length}`);
    
    const headReport = readJson(headJson);
    console.log(`Head report total: $${headReport.grand_total_usd || 'N/A'}`);
    console.log(`Head report stacks: ${(headReport.stacks || []).length}`);

    logCostEstimate(headReport, 'HEAD');
    logCostEstimate(baseReport, 'BASE');
    
    const delta = computeDelta(baseReport, headReport);
    console.log(`Delta computed:`);
    console.log(`  Base total: $${delta.total.base.toFixed(2)}`);
    console.log(`  Head total: $${delta.total.head.toFixed(2)}`);
    console.log(`  Delta: $${delta.total.diff.toFixed(2)}`);
    console.log(`  Stacks with changes: ${delta.stacks.length}`);
    
    const markdown = renderMarkdown(delta, commentTitle);
    console.log(`Markdown generated (length: ${markdown.length} chars)`);

    console.log('=== Setting action outputs ===');
    core.setOutput('delta-json', JSON.stringify(delta));
    core.setOutput('delta-md', markdown);
    core.setOutput('head-total', delta.total.head);
    core.setOutput('base-total', delta.total.base);
    core.setOutput('delta-total', delta.total.diff);
    console.log('✓ Action outputs set');

    console.log('=== Posting PR comment ===');
    console.log(`[PR] Creating Octokit client...`);
    const octokit = github.getOctokit(githubToken);
    console.log(`[PR] ✓ Octokit client created`);
    console.log(`[PR] Markdown length: ${markdown.length} chars`);
    console.log(`[PR] Update existing: ${updateExisting}`);
    console.log(`[PR] Comment title: ${commentTitle}`);
    
    const commentStartTime = Date.now();
    await upsertPrComment(octokit, markdown, updateExisting, commentTitle);
    const commentDuration = Date.now() - commentStartTime;
    console.log(`[PR] ✓ PR comment posted successfully (took ${commentDuration}ms)`);

    if (enableUsageReporting) {
      const durationMs = Date.now() - startTime;
      console.log(`=== Sending usage record ===`);
      console.log(`Total duration: ${durationMs}ms (${(durationMs / 1000).toFixed(2)}s)`);
      
      try {
        core.startGroup('Send usage record');
        const usageUrl = `${backendUrl.replace(/\/$/, '')}/api/v1/usage`;
        console.log(`Usage URL: ${usageUrl}`);
        
        const usagePayload = {
          repo: context.repo.owner + '/' + context.repo.repo,
          commit: headSha,
          pr: pull.number,
          duration_ms: durationMs,
          head_total: delta.total.head,
          base_total: delta.total.base,
          delta_total: delta.total.diff,
        };
        console.log(`Usage payload: ${JSON.stringify(usagePayload, null, 2)}`);
        
        console.log(`[USAGE] [BACKEND] Preparing to send POST request to backend...`);
        console.log(`[USAGE] [BACKEND] Request URL: ${usageUrl}`);
        console.log(`[USAGE] [BACKEND] Request method: POST`);
        console.log(`[USAGE] [BACKEND] Request headers:`);
        console.log(`[USAGE] [BACKEND]   - Content-Type: application/json`);
        console.log(`[USAGE] [BACKEND]   - Authorization: Bearer *** (${apiKey.length} chars)`);
        console.log(`[USAGE] [BACKEND] Request payload: ${JSON.stringify(usagePayload, null, 2)}`);
        console.log(`[USAGE] [BACKEND] Payload size: ${JSON.stringify(usagePayload).length} bytes`);
        
        const fetchStartTime = Date.now();
        console.log(`[USAGE] [BACKEND] Sending POST request to ${usageUrl}...`);
        console.log(`[USAGE] [BACKEND] Sending POST request to ${usageUrl}...`);
        
        let response;
        try {
          const requestOptions = {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(usagePayload),
          };
          console.log(`[USAGE] [BACKEND] Request options: ${JSON.stringify({...requestOptions, headers: {...requestOptions.headers, Authorization: 'Bearer ***'}}, null, 2)}`);
          console.log(`[USAGE] [BACKEND] Making fetch request...`);
          
          response = await fetch(usageUrl, requestOptions);
          
          console.log(`[USAGE] [BACKEND] Fetch request completed, status: ${response.status}`);
        } catch (fetchError) {
          const errorDetails = {
            message: fetchError.message,
            type: fetchError.constructor.name,
            name: fetchError.name,
            cause: fetchError.cause,
            stack: fetchError.stack?.split('\n').slice(0, 5).join('\n'),
          };
          console.error(`[USAGE] [BACKEND] ✗ Fetch request failed`);
          console.error(`[USAGE] [BACKEND] Error message: ${fetchError.message}`);
          console.error(`[USAGE] [BACKEND] Error type: ${fetchError.constructor.name}`);
          console.error(`[USAGE] [BACKEND] Error name: ${fetchError.name || 'N/A'}`);
          console.error(`[USAGE] [BACKEND] Fetch error:`, errorDetails);
          if (fetchError.cause) {
            console.error(`[USAGE] [BACKEND] Error cause: ${JSON.stringify(fetchError.cause)}`);
          }
          if (fetchError.code) {
            console.error(`[USAGE] [BACKEND] Error code: ${fetchError.code}`);
          }
          if (fetchError.errno) {
            console.error(`[USAGE] [BACKEND] Error errno: ${fetchError.errno}`);
          }
          throw fetchError;
        }
        
        const fetchDuration = Date.now() - fetchStartTime;
        console.log(`[USAGE] [BACKEND] Request completed (took ${fetchDuration}ms)`);
        console.log(`[USAGE] [BACKEND] Request duration: ${fetchDuration}ms`);
        console.log(`[USAGE] [BACKEND] Response status: ${response.status} ${response.statusText}`);
        console.log(`[USAGE] [BACKEND] Response ok: ${response.ok}`);
        console.log(`[USAGE] [BACKEND] Response redirected: ${response.redirected}`);
        console.log(`[USAGE] [BACKEND] Response type: ${response.type}`);
        console.log(`[USAGE] [BACKEND] Response URL: ${response.url}`);
        
        const responseHeaders = Object.fromEntries(response.headers.entries());
        console.log(`[USAGE] [BACKEND] Response headers: ${JSON.stringify(responseHeaders, null, 2)}`);
        console.log(`[USAGE] [BACKEND] Response headers:`, responseHeaders);
        
        const responseText = await response.text();
        console.log(`[USAGE] [BACKEND] Response body length: ${responseText.length} chars`);
        console.log(`[USAGE] [BACKEND] Response body length: ${responseText.length} chars`);
        if (responseText.length > 0) {
          if (responseText.length > 1000) {
            console.log(`[USAGE] [BACKEND] Response body preview: ${responseText.substring(0, 1000)}...`);
            console.log(`[USAGE] [BACKEND] Response body preview: ${responseText.substring(0, 1000)}...`);
          } else {
            console.log(`[USAGE] [BACKEND] Response body: ${responseText}`);
            console.log(`[USAGE] [BACKEND] Response body:`, responseText);
          }
        } else {
          console.log(`[USAGE] [BACKEND] Response body is empty`);
          console.log(`[USAGE] [BACKEND] Response body is empty`);
        }
        
        if (!response.ok) {
          throw new Error(`Usage API returned ${response.status}: ${responseText}`);
        }
        
        console.log('✓ Usage record sent successfully');
        core.endGroup();
      } catch (err) {
        console.error(`✗ Failed to send usage record: ${err.message || String(err)}`);
        if (err.stack) {
          console.error(`Stack trace: ${err.stack}`);
        }
        console.warn(`Usage reporting failed, but continuing...`);
      }
    } else {
      console.log('Usage reporting is disabled, skipping...');
    }
    
    console.log('========================================');
    console.log('CloudCost GitHub Action - Completed Successfully');
    console.log('========================================');
  } catch (error) {
    console.error('========================================');
    console.error('CloudCost GitHub Action - Failed');
    console.error('========================================');
    console.error(`[ERROR] Error type: ${error.constructor.name}`);
    console.error(`[ERROR] Error message: ${error.message || String(error)}`);
    console.error(`[ERROR] Error name: ${error.name || 'N/A'}`);
    
    if (error.stack) {
      console.error(`[ERROR] Stack trace:`);
      console.error(error.stack);
    }
    
    if (error.status) {
      console.error(`[ERROR] HTTP status: ${error.status}`);
    }
    
    if (error.code) {
      console.error(`[ERROR] Error code: ${error.code}`);
    }
    
    if (error.response) {
      console.error(`[ERROR] Response status: ${error.response.status}`);
      console.error(`[ERROR] Response data: ${JSON.stringify(error.response.data)}`);
      console.error(`[ERROR] Response headers: ${JSON.stringify(error.response.headers)}`);
    }
    
    if (error.cause) {
      console.error(`[ERROR] Error cause: ${JSON.stringify(error.cause)}`);
    }
    
    // Log current state for debugging
    console.error(`[ERROR] Current working directory: ${process.cwd()}`);
    console.error(`[ERROR] Node version: ${process.version}`);
    console.error(`[ERROR] Platform: ${process.platform} ${process.arch}`);
    
    core.setFailed(error.message || String(error));
  }
}

// Add unhandled error handlers to catch any errors that escape try-catch blocks
process.on('unhandledRejection', (reason, promise) => {
  console.error('========================================');
  console.error('[UNHANDLED] Unhandled Promise Rejection');
  console.error('========================================');
  console.error(`[UNHANDLED] Reason: ${reason}`);
  console.error(`[UNHANDLED] Promise: ${promise}`);
  if (reason && typeof reason === 'object' && reason.stack) {
    console.error(`[UNHANDLED] Stack: ${reason.stack}`);
  }
  if (process.stderr.flush) process.stderr.flush();
  core.setFailed(`Unhandled promise rejection: ${reason}`);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('========================================');
  console.error('[UNHANDLED] Uncaught Exception');
  console.error('========================================');
  console.error(`[UNHANDLED] Error: ${error.message || String(error)}`);
  if (error.stack) {
    console.error(`[UNHANDLED] Stack: ${error.stack}`);
  }
  if (process.stderr.flush) process.stderr.flush();
  core.setFailed(`Uncaught exception: ${error.message || String(error)}`);
  process.exit(1);
});

// Ensure we catch any errors during startup
(async () => {
  try {
    console.log('[STARTUP] Calling main()...');
    
    // Await the main function to ensure it completes before the process exits
    await main();
    
    console.log('[STARTUP] main() completed successfully');
    // Force flush before exit
    if (process.stdout.flush) process.stdout.flush();
    if (process.stderr.flush) process.stderr.flush();
  } catch (error) {
    console.error(`[STARTUP] Error in main(): ${error.message || String(error)}`);
    if (error.stack) {
      console.error(`[STARTUP] Stack trace: ${error.stack}`);
    }
    // Force flush before exit
    if (process.stdout.flush) process.stdout.flush();
    if (process.stderr.flush) process.stderr.flush();
    core.setFailed(error.message || String(error));
    process.exit(1);
  }
})();

