// Force immediate output - this should appear even if everything else fails
process.stdout.write('=== CLOUDCOST ACTION SCRIPT LOADED ===\n');
process.stdout.write(`Node version: ${process.version}\n`);
process.stdout.write(`Platform: ${process.platform} ${process.arch}\n`);
process.stdout.write(`Working directory: ${process.cwd()}\n`);

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
  core.info(`[CMD] Executing: ${cmdName}`);
  core.info(`[CMD] Full command: ${cmd.replace(/(--api-key\s+)"[^"]+"/g, '$1"***"')}`);
  core.info(`[CMD] Working directory: ${options.cwd || process.cwd()}`);
  core.info(`[CMD] Environment variables present: ${Object.keys(options.env || {}).length > 0 ? 'Yes' : 'No'}`);
  
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
    core.info(`[CMD] ✓ Command succeeded: ${cmdName} (took ${duration}ms)`);
    
    // Note: With stdio: 'inherit', result will be undefined for most commands
    // but that's okay - we see the output in real-time which is more important
    if (result && result.length > 0) {
      core.info(`[CMD] Command returned output (length: ${result.length} chars)`);
      if (result.length > 500) {
        core.info(`[CMD] Output preview: ${result.substring(0, 500)}...`);
      } else {
        core.info(`[CMD] Output: ${result}`);
      }
    }
    
    return result;
  } catch (err) {
    core.error(`[CMD] ✗ Command failed: ${cmdName}`);
    core.error(`[CMD] Error message: ${err.message || String(err)}`);
    core.error(`[CMD] Error code: ${err.status || err.code || 'N/A'}`);
    core.error(`[CMD] Error signal: ${err.signal || 'N/A'}`);
    
    // execSync with stdio: 'inherit' doesn't capture stdout/stderr in err
    // but we try to get what we can
    if (err.stdout) {
      core.error(`[CMD] Stdout: ${err.stdout}`);
    }
    if (err.stderr) {
      core.error(`[CMD] Stderr: ${err.stderr}`);
    }
    if (err.output && Array.isArray(err.output)) {
      core.error(`[CMD] Output array length: ${err.output.length}`);
      err.output.forEach((output, idx) => {
        if (output) {
          const outputStr = output.toString();
          if (outputStr.length > 0) {
            core.error(`[CMD] Output[${idx}]: ${outputStr.substring(0, 500)}${outputStr.length > 500 ? '...' : ''}`);
          }
        }
      });
    }
    
    throw new Error(`Command failed: ${cmdName} - ${err.message || String(err)}`);
  }
}

function readJson(filePath) {
  core.info(`Reading JSON file: ${filePath}`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  core.info(`File size: ${raw.length} bytes`);
  const parsed = JSON.parse(raw);
  core.info(`✓ Successfully parsed JSON from ${filePath}`);
  return parsed;
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
  core.info('=== Starting PR comment upsert ===');
  const context = github.context;
  const { owner, repo } = context.repo;
  core.info(`Repository: ${owner}/${repo}`);
  core.info(`Event name: ${context.eventName}`);
  core.info(`Action: ${context.action}`);
  
  const pull = context.payload.pull_request;
  if (!pull) {
    core.warning('Not a pull_request event; skipping PR comment.');
    core.info(`Context payload keys: ${Object.keys(context.payload).join(', ')}`);
    return;
  }
  
  const issue_number = pull.number;
  core.info(`PR number: ${issue_number}`);
  core.info(`PR head SHA: ${pull.head?.sha}`);
  core.info(`PR base SHA: ${pull.base?.sha}`);
  core.info(`Comment body length: ${commentBody.length} characters`);

  const marker = '<!-- cloudcostgh-comment -->';
  core.info(`Fetching existing comments for PR #${issue_number}...`);
  
  try {
    const comments = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number,
      per_page: 100,
    });
    
    core.info(`Found ${comments.data.length} total comments on PR #${issue_number}`);

    const existing = comments.data.find((c) =>
      c.body && c.body.includes(marker),
    );

    if (existing && updateExisting) {
      core.info(`Updating existing CloudCost comment (ID: ${existing.id}).`);
      const result = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body: commentBody,
      });
      core.info(`✓ Successfully updated comment. Comment URL: ${result.data.html_url}`);
    } else {
      if (existing) {
        core.info(`Found existing comment but updateExisting is false, skipping update.`);
      } else {
        core.info('No existing CloudCost comment found, creating new one.');
      }
      const result = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number,
        body: commentBody,
      });
      core.info(`✓ Successfully created comment. Comment URL: ${result.data.html_url}`);
    }
    core.info('=== PR comment upsert completed successfully ===');
  } catch (error) {
    core.error(`✗ Failed to upsert PR comment: ${error.message || String(error)}`);
    if (error.status) {
      core.error(`HTTP status: ${error.status}`);
    }
    if (error.response) {
      core.error(`Response data: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function main() {
  // Force immediate output using multiple methods
  process.stdout.write('========================================\n');
  process.stdout.write('CloudCost GitHub Action - Starting\n');
  process.stdout.write('========================================\n');
  process.stdout.write(`[INIT] Node version: ${process.version}\n`);
  process.stdout.write(`[INIT] Platform: ${process.platform} ${process.arch}\n`);
  
  // Use both console.log and core.info to ensure logs appear
  console.log('========================================');
  console.log('CloudCost GitHub Action - Starting');
  console.log('========================================');
  core.info('========================================');
  core.info('CloudCost GitHub Action - Starting');
  core.info('========================================');
  console.log(`[INIT] Node version: ${process.version}`);
  core.info(`[INIT] Node version: ${process.version}`);
  console.log(`[INIT] Platform: ${process.platform} ${process.arch}`);
  core.info(`[INIT] Platform: ${process.platform} ${process.arch}`);
  console.log(`[INIT] Working directory: ${process.cwd()}`);
  core.info(`[INIT] Working directory: ${process.cwd()}`);
  console.log(`[INIT] Process PID: ${process.pid}`);
  core.info(`[INIT] Process PID: ${process.pid}`);
  console.log(`[INIT] Environment variables:`);
  core.info(`[INIT] Environment variables:`);
  const envLog = `  - GITHUB_TOKEN: ${process.env.GITHUB_TOKEN ? `Set (${process.env.GITHUB_TOKEN.length} chars)` : 'NOT SET'}`;
  console.log(envLog);
  core.info(envLog);
  const apiKeyLog = `  - CLOUDCOST_API_KEY: ${process.env.CLOUDCOST_API_KEY ? `Set (${process.env.CLOUDCOST_API_KEY.length} chars)` : 'NOT SET'}`;
  console.log(apiKeyLog);
  core.info(apiKeyLog);
  const appConfigLog = `  - APP_CONFIG: ${process.env.APP_CONFIG || 'NOT SET'}`;
  console.log(appConfigLog);
  core.info(appConfigLog);
  const runnerTempLog = `  - RUNNER_TEMP: ${process.env.RUNNER_TEMP || 'NOT SET'}`;
  console.log(runnerTempLog);
  core.info(runnerTempLog);
  const workspaceLog = `  - GITHUB_WORKSPACE: ${process.env.GITHUB_WORKSPACE || 'NOT SET'}`;
  console.log(workspaceLog);
  core.info(workspaceLog);
  
  try {
    core.info('=== Reading configuration ===');
    const backendUrl = 'https://cloudcost-action-api.vercel.app/';
    core.info(`[CONFIG] Backend URL: ${backendUrl}`);
    console.log(`[CONFIG] Backend URL: ${backendUrl}`);
    core.info(`[CONFIG] [BACKEND] All backend requests will be made to: ${backendUrl}`);
    core.info(`[CONFIG] [BACKEND] The analyzer binary will make pricing API requests to this backend`);
    core.info(`[CONFIG] [BACKEND] Usage reporting will be sent to: ${backendUrl}/api/v1/usage`);
    
    const region = core.getInput('region') || 'us-east-1';
    core.info(`Region: ${region}`);
    
    const usageProfile = core.getInput('usage_profile') || 'small';
    core.info(`Usage profile: ${usageProfile}`);
    
    const analyzerVersion = core.getInput('analyzer_version') || 'v0.1.0';
    core.info(`Analyzer version: ${analyzerVersion}`);
    
    const commentTitle =
      core.getInput('comment_title') || 'Cloud Cost Impact';
    core.info(`Comment title: ${commentTitle}`);
    
    const updateExistingInput = core.getInput('update_existing_comment');
    const updateExisting =
      updateExistingInput === '' ? true : updateExistingInput !== 'false';
    core.info(`Update existing comment: ${updateExisting}`);
    
    const enableUsageReportingInput = core.getInput('enable_usage_reporting');
    const enableUsageReporting =
      enableUsageReportingInput && enableUsageReportingInput !== 'false';
    core.info(`Enable usage reporting: ${enableUsageReporting}`);
    
    const githubToken =
      core.getInput('github_token') || process.env.GITHUB_TOKEN;

    if (!githubToken) {
      core.error('✗ GitHub token is missing');
      core.setFailed(
        'GitHub token is required to post PR comments. Provide github_token input (usually secrets.GITHUB_TOKEN) or set GITHUB_TOKEN env.',
      );
      return;
    }
    core.info(`✓ GitHub token is set (length: ${githubToken.length} chars)`);

    const apiKeyInput = core.getInput('api_key');
    const apiKey = apiKeyInput || process.env.CLOUDCOST_API_KEY;
    if (!apiKey) {
      core.error('✗ API key is missing');
      core.setFailed(
        'api_key input (or CLOUDCOST_API_KEY env) is required but not set.',
      );
      return;
    }
    core.info(`✓ API key is set (length: ${apiKey.length} chars)`);

    core.info('=== Checking GitHub context ===');
    const context = github.context;
    core.info(`[CONTEXT] Event name: ${context.eventName}`);
    core.info(`[CONTEXT] Action: ${context.action || 'N/A'}`);
    core.info(`[CONTEXT] Repository: ${context.repo.owner}/${context.repo.repo}`);
    core.info(`[CONTEXT] Workflow: ${context.workflow || 'N/A'}`);
    core.info(`[CONTEXT] Run ID: ${context.runId}`);
    core.info(`[CONTEXT] SHA: ${context.sha}`);
    core.info(`[CONTEXT] Ref: ${context.ref}`);
    core.info(`[CONTEXT] Actor: ${context.actor || 'N/A'}`);
    core.info(`[CONTEXT] Payload keys: ${Object.keys(context.payload || {}).join(', ')}`);
    
    const pull = context.payload.pull_request;
    if (!pull) {
      core.error('[CONTEXT] ✗ No pull_request found in context');
      core.error(`[CONTEXT] Available payload keys: ${Object.keys(context.payload || {}).join(', ')}`);
      core.error(`[CONTEXT] Payload structure: ${JSON.stringify(context.payload, null, 2).substring(0, 1000)}`);
      core.setFailed('This action must be run on a pull_request event.');
      return;
    }
    
    core.info(`[CONTEXT] ✓ Pull request found: #${pull.number}`);
    core.info(`[CONTEXT] PR state: ${pull.state || 'N/A'}`);
    core.info(`[CONTEXT] PR title: ${pull.title || 'N/A'}`);
    core.info(`[CONTEXT] PR head ref: ${pull.head?.ref || 'N/A'}`);
    core.info(`[CONTEXT] PR base ref: ${pull.base?.ref || 'N/A'}`);
    const headSha = pull.head.sha;
    const baseSha = pull.base.sha;
    core.info(`[CONTEXT] Head SHA: ${headSha}`);
    core.info(`[CONTEXT] Base SHA: ${baseSha}`);
    
    if (!headSha || !baseSha) {
      core.error(`[CONTEXT] ✗ Missing SHA information`);
      core.error(`[CONTEXT] Head object: ${JSON.stringify(pull.head)}`);
      core.error(`[CONTEXT] Base object: ${JSON.stringify(pull.base)}`);
      throw new Error('Pull request is missing head or base SHA information');
    }

    core.info('=== Setting up working directories ===');
    const tmpDir = process.env.RUNNER_TEMP || os.tmpdir();
    const workDir = process.cwd();
    core.info(`Temporary directory: ${tmpDir}`);
    core.info(`Working directory: ${workDir}`);
    
    const analyzerDir = path.join(tmpDir, 'cloudcost-analyzer');
    const analyzerPath = path.join(analyzerDir, 'analyzer');
    const headJson = path.join(tmpDir, 'cloudcost-head-report.json');
    const baseJson = path.join(tmpDir, 'cloudcost-base-report.json');
    
    core.info(`Analyzer directory: ${analyzerDir}`);
    core.info(`Analyzer path: ${analyzerPath}`);
    core.info(`Head report JSON: ${headJson}`);
    core.info(`Base report JSON: ${baseJson}`);

    core.info('Creating analyzer directory...');
    fs.mkdirSync(analyzerDir, { recursive: true });
    core.info(`✓ Analyzer directory created`);

    const analyzerUrl = `https://github.com/odrori1997/cloudcost-analyzer/releases/download/${analyzerVersion}/analyzer`;
    core.info(`=== Downloading analyzer ===`);
    core.info(`[DOWNLOAD] Analyzer URL: ${analyzerUrl}`);
    core.info(`[DOWNLOAD] Target path: ${analyzerPath}`);
    core.info(`[DOWNLOAD] Analyzer directory exists: ${fs.existsSync(analyzerDir)}`);
    
    if (fs.existsSync(analyzerPath)) {
      core.info(`[DOWNLOAD] Analyzer already exists, removing old version...`);
      fs.unlinkSync(analyzerPath);
    }
    
    core.info(`[DOWNLOAD] Starting download...`);
    const downloadStartTime = Date.now();
    runCmd(`curl -sSL "${analyzerUrl}" -o "${analyzerPath}"`);
    const downloadDuration = Date.now() - downloadStartTime;
    core.info(`[DOWNLOAD] Download command completed (took ${downloadDuration}ms)`);
    
    if (fs.existsSync(analyzerPath)) {
      const stats = fs.statSync(analyzerPath);
      core.info(`[DOWNLOAD] ✓ Analyzer downloaded (size: ${stats.size} bytes)`);
      if (stats.size === 0) {
        throw new Error(`Downloaded analyzer file is empty!`);
      }
    } else {
      throw new Error(`Analyzer file not found after download: ${analyzerPath}`);
    }
    
    core.info(`[DOWNLOAD] Making analyzer executable...`);
    runCmd(`chmod +x "${analyzerPath}"`);
    const chmodStats = fs.statSync(analyzerPath);
    const isExecutable = (chmodStats.mode & parseInt('111', 8)) !== 0;
    if (isExecutable) {
      core.info(`[DOWNLOAD] ✓ Analyzer made executable`);
    } else {
      core.warning(`[DOWNLOAD] WARNING: Analyzer may not be executable (mode: ${chmodStats.mode.toString(8)})`);
    }

    const startTime = Date.now();
    core.info(`Start time: ${new Date(startTime).toISOString()}`);

    // Head analysis
    core.info('=== Starting head commit analysis ===');
    core.startGroup('Analyze head commit');
    core.info(`[HEAD] Current git SHA: ${headSha}`);
    core.info(`[HEAD] Verifying git state...`);
    try {
      const gitStatus = runCmd('git status --short', { cwd: workDir, encoding: 'utf8' });
      core.info(`[HEAD] Git status: ${gitStatus || '(clean)'}`);
    } catch (e) {
      core.warning(`[HEAD] Could not get git status: ${e.message}`);
    }
    
    core.info(`[HEAD] Checking if cdk.out exists before synth...`);
    const cdkOutPath = path.join(workDir, 'cdk.out');
    if (fs.existsSync(cdkOutPath)) {
      core.info(`[HEAD] cdk.out exists, listing contents...`);
      try {
        const cdkOutContents = fs.readdirSync(cdkOutPath);
        core.info(`[HEAD] cdk.out contains: ${cdkOutContents.join(', ')}`);
      } catch (e) {
        core.warning(`[HEAD] Could not list cdk.out: ${e.message}`);
      }
    } else {
      core.info(`[HEAD] cdk.out does not exist yet (will be created by synth)`);
    }
    
    core.info('[HEAD] Running CDK synth for head commit...');
    const synthStartTime = Date.now();
    runCmd('npx cdk synth --quiet', { cwd: workDir });
    const synthDuration = Date.now() - synthStartTime;
    core.info(`[HEAD] ✓ CDK synth completed for head (took ${synthDuration}ms)`);
    
    core.info(`[HEAD] Verifying cdk.out after synth...`);
    if (fs.existsSync(cdkOutPath)) {
      try {
        const cdkOutContents = fs.readdirSync(cdkOutPath);
        core.info(`[HEAD] cdk.out now contains: ${cdkOutContents.join(', ')}`);
      } catch (e) {
        core.warning(`[HEAD] Could not list cdk.out after synth: ${e.message}`);
      }
    } else {
      core.error(`[HEAD] ✗ cdk.out still does not exist after synth!`);
      throw new Error('CDK synth did not create cdk.out directory');
    }
    
    core.info('[HEAD] Verifying analyzer binary exists...');
    if (!fs.existsSync(analyzerPath)) {
      throw new Error(`Analyzer binary not found at: ${analyzerPath}`);
    }
    const analyzerStats = fs.statSync(analyzerPath);
    core.info(`[HEAD] Analyzer binary exists (${analyzerStats.size} bytes, executable: ${(analyzerStats.mode & parseInt('111', 8)) !== 0})`);
    
    core.info('[HEAD] Running analyzer for head commit...');
    const headAnalyzerCmd = `"${analyzerPath}" ` +
      `--cdk-out ./cdk.out ` +
      `--region ${region} ` +
      `--usage-profile ${usageProfile} ` +
      `--out-json "${headJson}" ` +
      `--out-md "${path.join(tmpDir, 'cloudcost-head-report.md')}" ` +
      `--api-key "${apiKey}" ` +
      `--backend-url "${backendUrl}"`;
    core.info(`[HEAD] Analyzer command (sanitized): ${headAnalyzerCmd.replace(apiKey, '***')}`);
    core.info(`[HEAD] Backend URL: ${backendUrl}`);
    core.info(`[HEAD] Expected output JSON: ${headJson}`);
    
    // Log what backend requests the analyzer will make
    core.info(`[HEAD] [BACKEND] Analyzer will make requests to backend:`);
    core.info(`[HEAD] [BACKEND]   - Base URL: ${backendUrl}`);
    core.info(`[HEAD] [BACKEND]   - API Key: Set (${apiKey.length} chars, starts with: ${apiKey.substring(0, 4)}...)`);
    core.info(`[HEAD] [BACKEND]   - Region: ${region}`);
    core.info(`[HEAD] [BACKEND]   - Usage Profile: ${usageProfile}`);
    core.info(`[HEAD] [BACKEND]   - The analyzer will query pricing data from the backend API`);
    core.info(`[HEAD] [BACKEND]   - Watch for analyzer's HTTP request logs above`);
    
    const analyzerStartTime = Date.now();
    core.info(`[HEAD] [BACKEND] Starting analyzer execution (will make backend requests)...`);
    runCmd(headAnalyzerCmd, { cwd: workDir });
    const analyzerDuration = Date.now() - analyzerStartTime;
    core.info(`[HEAD] Analyzer command completed (took ${analyzerDuration}ms)`);
    core.info(`[HEAD] [BACKEND] Analyzer execution finished - check above for any HTTP request logs from the analyzer`);
    
    core.info(`[HEAD] Checking for head report file...`);
    if (fs.existsSync(headJson)) {
      const stats = fs.statSync(headJson);
      core.info(`[HEAD] ✓ Head report generated (size: ${stats.size} bytes)`);
      if (stats.size === 0) {
        core.error(`[HEAD] ✗ Head report file is empty!`);
        throw new Error(`Head report file is empty: ${headJson}`);
      }
      // Log first few lines of the report for debugging
      try {
        const reportPreview = fs.readFileSync(headJson, 'utf8').substring(0, 500);
        core.info(`[HEAD] Report preview: ${reportPreview}...`);
      } catch (e) {
        core.warning(`[HEAD] Could not read report preview: ${e.message}`);
      }
    } else {
      core.error(`[HEAD] ✗ Head report file not found: ${headJson}`);
      core.error(`[HEAD] Listing temp directory contents...`);
      try {
        const tempContents = fs.readdirSync(tmpDir);
        core.error(`[HEAD] Temp directory contains: ${tempContents.join(', ')}`);
      } catch (e) {
        core.error(`[HEAD] Could not list temp directory: ${e.message}`);
      }
      throw new Error(`Head report file not found: ${headJson}`);
    }
    core.endGroup();

    // Base analysis
    core.info('=== Starting base commit analysis ===');
    core.startGroup('Analyze base commit');
    core.info(`[BASE] Checking out base SHA: ${baseSha}`);
    const checkoutStartTime = Date.now();
    runCmd(`git checkout ${baseSha}`, { cwd: workDir });
    const checkoutDuration = Date.now() - checkoutStartTime;
    core.info(`[BASE] ✓ Checked out base commit (took ${checkoutDuration}ms)`);
    
    core.info(`[BASE] Verifying git state after checkout...`);
    try {
      const currentSha = runCmd('git rev-parse HEAD', { cwd: workDir, encoding: 'utf8' }).trim();
      core.info(`[BASE] Current HEAD SHA: ${currentSha}`);
      if (currentSha !== baseSha) {
        core.warning(`[BASE] WARNING: Current SHA (${currentSha}) does not match expected base SHA (${baseSha})`);
      }
    } catch (e) {
      core.warning(`[BASE] Could not verify git SHA: ${e.message}`);
    }
    
    core.info(`[BASE] Cleaning up old cdk.out if exists...`);
    const baseCdkOutPath = path.join(workDir, 'cdk.out');
    if (fs.existsSync(baseCdkOutPath)) {
      try {
        fs.rmSync(baseCdkOutPath, { recursive: true, force: true });
        core.info(`[BASE] Removed old cdk.out`);
      } catch (e) {
        core.warning(`[BASE] Could not remove old cdk.out: ${e.message}`);
      }
    }
    
    core.info('[BASE] Running CDK synth for base commit...');
    const baseSynthStartTime = Date.now();
    runCmd('npx cdk synth --quiet', { cwd: workDir });
    const baseSynthDuration = Date.now() - baseSynthStartTime;
    core.info(`[BASE] ✓ CDK synth completed for base (took ${baseSynthDuration}ms)`);
    
    core.info(`[BASE] Verifying cdk.out after synth...`);
    if (fs.existsSync(baseCdkOutPath)) {
      try {
        const cdkOutContents = fs.readdirSync(baseCdkOutPath);
        core.info(`[BASE] cdk.out contains: ${cdkOutContents.join(', ')}`);
      } catch (e) {
        core.warning(`[BASE] Could not list cdk.out after synth: ${e.message}`);
      }
    } else {
      core.error(`[BASE] ✗ cdk.out does not exist after synth!`);
      throw new Error('CDK synth did not create cdk.out directory for base');
    }
    
    core.info('[BASE] Running analyzer for base commit...');
    const baseAnalyzerCmd = `"${analyzerPath}" ` +
      `--cdk-out ./cdk.out ` +
      `--region ${region} ` +
      `--usage-profile ${usageProfile} ` +
      `--out-json "${baseJson}" ` +
      `--out-md "${path.join(tmpDir, 'cloudcost-base-report.md')}" ` +
      `--api-key "${apiKey}" ` +
      `--backend-url "${backendUrl}"`;
    core.info(`[BASE] Analyzer command (sanitized): ${baseAnalyzerCmd.replace(apiKey, '***')}`);
    core.info(`[BASE] Backend URL: ${backendUrl}`);
    core.info(`[BASE] Expected output JSON: ${baseJson}`);
    
    // Log what backend requests the analyzer will make
    core.info(`[BASE] [BACKEND] Analyzer will make requests to backend:`);
    core.info(`[BASE] [BACKEND]   - Base URL: ${backendUrl}`);
    core.info(`[BASE] [BACKEND]   - API Key: Set (${apiKey.length} chars, starts with: ${apiKey.substring(0, 4)}...)`);
    core.info(`[BASE] [BACKEND]   - Region: ${region}`);
    core.info(`[BASE] [BACKEND]   - Usage Profile: ${usageProfile}`);
    core.info(`[BASE] [BACKEND]   - The analyzer will query pricing data from the backend API`);
    core.info(`[BASE] [BACKEND]   - Watch for analyzer's HTTP request logs above`);
    
    const baseAnalyzerStartTime = Date.now();
    core.info(`[BASE] [BACKEND] Starting analyzer execution (will make backend requests)...`);
    runCmd(baseAnalyzerCmd, { cwd: workDir });
    const baseAnalyzerDuration = Date.now() - baseAnalyzerStartTime;
    core.info(`[BASE] Analyzer command completed (took ${baseAnalyzerDuration}ms)`);
    core.info(`[BASE] [BACKEND] Analyzer execution finished - check above for any HTTP request logs from the analyzer`);
    
    core.info(`[BASE] Checking for base report file...`);
    if (fs.existsSync(baseJson)) {
      const stats = fs.statSync(baseJson);
      core.info(`[BASE] ✓ Base report generated (size: ${stats.size} bytes)`);
      if (stats.size === 0) {
        core.error(`[BASE] ✗ Base report file is empty!`);
        throw new Error(`Base report file is empty: ${baseJson}`);
      }
      // Log first few lines of the report for debugging
      try {
        const reportPreview = fs.readFileSync(baseJson, 'utf8').substring(0, 500);
        core.info(`[BASE] Report preview: ${reportPreview}...`);
      } catch (e) {
        core.warning(`[BASE] Could not read report preview: ${e.message}`);
      }
    } else {
      core.error(`[BASE] ✗ Base report file not found: ${baseJson}`);
      core.error(`[BASE] Listing temp directory contents...`);
      try {
        const tempContents = fs.readdirSync(tmpDir);
        core.error(`[BASE] Temp directory contains: ${tempContents.join(', ')}`);
      } catch (e) {
        core.error(`[BASE] Could not list temp directory: ${e.message}`);
      }
      throw new Error(`Base report file not found: ${baseJson}`);
    }
    
    core.info(`Checking out head SHA: ${headSha}`);
    runCmd(`git checkout ${headSha}`, { cwd: workDir });
    core.info('✓ Checked out head commit');
    core.endGroup();

    core.info('=== Computing cost delta ===');
    const baseReport = readJson(baseJson);
    core.info(`Base report total: $${baseReport.grand_total_usd || 'N/A'}`);
    core.info(`Base report stacks: ${(baseReport.stacks || []).length}`);
    
    const headReport = readJson(headJson);
    core.info(`Head report total: $${headReport.grand_total_usd || 'N/A'}`);
    core.info(`Head report stacks: ${(headReport.stacks || []).length}`);
    
    const delta = computeDelta(baseReport, headReport);
    core.info(`Delta computed:`);
    core.info(`  Base total: $${delta.total.base.toFixed(2)}`);
    core.info(`  Head total: $${delta.total.head.toFixed(2)}`);
    core.info(`  Delta: $${delta.total.diff.toFixed(2)}`);
    core.info(`  Stacks with changes: ${delta.stacks.length}`);
    
    const markdown = renderMarkdown(delta, commentTitle);
    core.info(`Markdown generated (length: ${markdown.length} chars)`);

    core.info('=== Setting action outputs ===');
    core.setOutput('delta-json', JSON.stringify(delta));
    core.setOutput('delta-md', markdown);
    core.setOutput('head-total', delta.total.head);
    core.setOutput('base-total', delta.total.base);
    core.setOutput('delta-total', delta.total.diff);
    core.info('✓ Action outputs set');

    core.info('=== Posting PR comment ===');
    core.info(`[PR] Creating Octokit client...`);
    const octokit = github.getOctokit(githubToken);
    core.info(`[PR] ✓ Octokit client created`);
    core.info(`[PR] Markdown length: ${markdown.length} chars`);
    core.info(`[PR] Update existing: ${updateExisting}`);
    core.info(`[PR] Comment title: ${commentTitle}`);
    
    const commentStartTime = Date.now();
    await upsertPrComment(octokit, markdown, updateExisting, commentTitle);
    const commentDuration = Date.now() - commentStartTime;
    core.info(`[PR] ✓ PR comment posted successfully (took ${commentDuration}ms)`);

    if (enableUsageReporting) {
      const durationMs = Date.now() - startTime;
      core.info(`=== Sending usage record ===`);
      core.info(`Total duration: ${durationMs}ms (${(durationMs / 1000).toFixed(2)}s)`);
      
      try {
        core.startGroup('Send usage record');
        const usageUrl = `${backendUrl.replace(/\/$/, '')}/api/v1/usage`;
        core.info(`Usage URL: ${usageUrl}`);
        
        const usagePayload = {
          repo: context.repo.owner + '/' + context.repo.repo,
          commit: headSha,
          pr: pull.number,
          duration_ms: durationMs,
          head_total: delta.total.head,
          base_total: delta.total.base,
          delta_total: delta.total.diff,
        };
        core.info(`Usage payload: ${JSON.stringify(usagePayload, null, 2)}`);
        
        core.info(`[USAGE] [BACKEND] Preparing to send POST request to backend...`);
        core.info(`[USAGE] [BACKEND] Request URL: ${usageUrl}`);
        core.info(`[USAGE] [BACKEND] Request method: POST`);
        core.info(`[USAGE] [BACKEND] Request headers:`);
        core.info(`[USAGE] [BACKEND]   - Content-Type: application/json`);
        core.info(`[USAGE] [BACKEND]   - Authorization: Bearer *** (${apiKey.length} chars)`);
        core.info(`[USAGE] [BACKEND] Request payload: ${JSON.stringify(usagePayload, null, 2)}`);
        core.info(`[USAGE] [BACKEND] Payload size: ${JSON.stringify(usagePayload).length} bytes`);
        
        const fetchStartTime = Date.now();
        core.info(`[USAGE] [BACKEND] Sending POST request to ${usageUrl}...`);
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
          core.info(`[USAGE] [BACKEND] Request options: ${JSON.stringify({...requestOptions, headers: {...requestOptions.headers, Authorization: 'Bearer ***'}}, null, 2)}`);
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
          core.error(`[USAGE] [BACKEND] ✗ Fetch request failed`);
          core.error(`[USAGE] [BACKEND] Error message: ${fetchError.message}`);
          core.error(`[USAGE] [BACKEND] Error type: ${fetchError.constructor.name}`);
          core.error(`[USAGE] [BACKEND] Error name: ${fetchError.name || 'N/A'}`);
          console.error(`[USAGE] [BACKEND] Fetch error:`, errorDetails);
          if (fetchError.cause) {
            core.error(`[USAGE] [BACKEND] Error cause: ${JSON.stringify(fetchError.cause)}`);
          }
          if (fetchError.code) {
            core.error(`[USAGE] [BACKEND] Error code: ${fetchError.code}`);
          }
          if (fetchError.errno) {
            core.error(`[USAGE] [BACKEND] Error errno: ${fetchError.errno}`);
          }
          throw fetchError;
        }
        
        const fetchDuration = Date.now() - fetchStartTime;
        core.info(`[USAGE] [BACKEND] Request completed (took ${fetchDuration}ms)`);
        console.log(`[USAGE] [BACKEND] Request duration: ${fetchDuration}ms`);
        core.info(`[USAGE] [BACKEND] Response status: ${response.status} ${response.statusText}`);
        core.info(`[USAGE] [BACKEND] Response ok: ${response.ok}`);
        core.info(`[USAGE] [BACKEND] Response redirected: ${response.redirected}`);
        core.info(`[USAGE] [BACKEND] Response type: ${response.type}`);
        core.info(`[USAGE] [BACKEND] Response URL: ${response.url}`);
        
        const responseHeaders = Object.fromEntries(response.headers.entries());
        core.info(`[USAGE] [BACKEND] Response headers: ${JSON.stringify(responseHeaders, null, 2)}`);
        console.log(`[USAGE] [BACKEND] Response headers:`, responseHeaders);
        
        const responseText = await response.text();
        core.info(`[USAGE] [BACKEND] Response body length: ${responseText.length} chars`);
        console.log(`[USAGE] [BACKEND] Response body length: ${responseText.length} chars`);
        if (responseText.length > 0) {
          if (responseText.length > 1000) {
            core.info(`[USAGE] [BACKEND] Response body preview: ${responseText.substring(0, 1000)}...`);
            console.log(`[USAGE] [BACKEND] Response body preview: ${responseText.substring(0, 1000)}...`);
          } else {
            core.info(`[USAGE] [BACKEND] Response body: ${responseText}`);
            console.log(`[USAGE] [BACKEND] Response body:`, responseText);
          }
        } else {
          core.info(`[USAGE] [BACKEND] Response body is empty`);
          console.log(`[USAGE] [BACKEND] Response body is empty`);
        }
        
        if (!response.ok) {
          throw new Error(`Usage API returned ${response.status}: ${responseText}`);
        }
        
        core.info('✓ Usage record sent successfully');
        core.endGroup();
      } catch (err) {
        core.error(`✗ Failed to send usage record: ${err.message || String(err)}`);
        if (err.stack) {
          core.error(`Stack trace: ${err.stack}`);
        }
        core.warning(`Usage reporting failed, but continuing...`);
      }
    } else {
      core.info('Usage reporting is disabled, skipping...');
    }
    
    core.info('========================================');
    core.info('CloudCost GitHub Action - Completed Successfully');
    core.info('========================================');
  } catch (error) {
    core.error('========================================');
    core.error('CloudCost GitHub Action - Failed');
    core.error('========================================');
    core.error(`[ERROR] Error type: ${error.constructor.name}`);
    core.error(`[ERROR] Error message: ${error.message || String(error)}`);
    core.error(`[ERROR] Error name: ${error.name || 'N/A'}`);
    
    if (error.stack) {
      core.error(`[ERROR] Stack trace:`);
      core.error(error.stack);
    }
    
    if (error.status) {
      core.error(`[ERROR] HTTP status: ${error.status}`);
    }
    
    if (error.code) {
      core.error(`[ERROR] Error code: ${error.code}`);
    }
    
    if (error.response) {
      core.error(`[ERROR] Response status: ${error.response.status}`);
      core.error(`[ERROR] Response data: ${JSON.stringify(error.response.data)}`);
      core.error(`[ERROR] Response headers: ${JSON.stringify(error.response.headers)}`);
    }
    
    if (error.cause) {
      core.error(`[ERROR] Error cause: ${JSON.stringify(error.cause)}`);
    }
    
    // Log current state for debugging
    core.error(`[ERROR] Current working directory: ${process.cwd()}`);
    core.error(`[ERROR] Node version: ${process.version}`);
    core.error(`[ERROR] Platform: ${process.platform} ${process.arch}`);
    
    core.setFailed(error.message || String(error));
  }
}

// Force immediate output to ensure logs appear
process.stdout.write('=== CLOUDCOST ACTION STARTING ===\n');
process.stderr.write('=== CLOUDCOST ACTION STARTING (stderr) ===\n');

// Ensure we catch any errors during startup
try {
  process.stdout.write('[STARTUP] Calling main()...\n');
  console.log('[STARTUP] Calling main()...');
  core.info('[STARTUP] Calling main()...');
  
  const mainPromise = main();
  if (mainPromise && typeof mainPromise.then === 'function') {
    mainPromise.catch((error) => {
      process.stderr.write(`[STARTUP] Unhandled error in main(): ${error.message || String(error)}\n`);
      console.error('[STARTUP] Unhandled error in main():', error);
      core.error(`[STARTUP] Unhandled error in main(): ${error.message || String(error)}`);
      if (error.stack) {
        process.stderr.write(`[STARTUP] Stack trace: ${error.stack}\n`);
        console.error('[STARTUP] Stack trace:', error.stack);
        core.error(`[STARTUP] Stack trace: ${error.stack}`);
      }
      process.exit(1);
    });
  }
} catch (error) {
  process.stderr.write(`[STARTUP] Error calling main(): ${error.message || String(error)}\n`);
  console.error('[STARTUP] Error calling main():', error);
  core.error(`[STARTUP] Error calling main(): ${error.message || String(error)}`);
  if (error.stack) {
    process.stderr.write(`[STARTUP] Stack trace: ${error.stack}\n`);
    console.error('[STARTUP] Stack trace:', error.stack);
    core.error(`[STARTUP] Stack trace: ${error.stack}`);
  }
  process.exit(1);
}

