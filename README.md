# CloudCost GitHub Action

Get instant CloudFormation cost estimates in your Pull Requests. CloudCost analyzes infrastructure cost changes before deployment, enabling engineering teams to make informed decisions about cloud spending within their existing workflow.

## Why CloudCost?

- **AWS Native** - Specializes in CloudFormation and CDK best practices
- **Zero configuration** - No cloud credentials or dashboards to set up, works out of the box
- **One-line setup** - Just add the action to your workflow; Node.js setup, dependency installation, and CDK synthesis are handled automatically
- **Smart defaults** - Auto-detects Node.js version from your `.nvmrc` or `.node-version` files
- **Prevent costly infra changes** - Get alerted before your surprise $47K AWS Bill
- **Resource-Level Cost Breakdowns** - Precise cost deltas on storage lifecycle policies, instance sizing, volume types


![CloudCost GitHub Action](screenshot.png)

*CloudCost comment shows the cost of an infrastructure change before it is made*

## Quick Start

### 1. Get Your API Key

Visit [cloudcostgh.com](https://cloudcostgh.com/pricing) to purchase a license.

### 2. Add Secret to Repository

1. Go to your repository → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `CLOUDCOST_API_KEY`
4. Value: `<your-license-key>`

### 3. Create Workflow

Add `.github/workflows/cloudcost.yml` to your repository:
```yaml
name: CloudCost Analysis

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  cost-analysis:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: odrori1997/cloudcost-gh-action@v0
        with:
          api_key: ${{ secrets.CLOUDCOST_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

That's it! The action automatically:
- Sets up Node.js (auto-detects version from `.nvmrc` or `.node-version`, or uses LTS)
- Installs your project dependencies (`npm ci`)
- Runs `cdk synth` to generate CloudFormation templates
- Analyzes cost changes and posts results to your PR

## How It Works

1. **Change Capture** - When you push a PR, scans for CloudFormation template changes
2. **Accurate Estimate** - Maps resource deltas to the latest AWS pricing 
3. **PR Integration** - Posts a single, updated comment with cost breakdown

## Configuration Options

The action supports the following inputs:

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `api_key` | CloudCost API key from your dashboard | Yes | - |
| `github_token` | GitHub token for posting PR comments | No | `${{ secrets.GITHUB_TOKEN }}` |
| `node_version` | Node.js version to use (auto-detects from `.nvmrc` or `.node-version` if not specified) | No | `lts/*` |
| `region` | AWS region to price in | No | `us-east-1` |
| `usage_profile` | Usage profile (`small`, `med`, or `large`) | No | `small` |
| `analyzer_version` | Analyzer release tag (e.g. `v0.1.0`) | No | `v0.1.0` |
| `comment_title` | Heading for the PR comment | No | `Cloud Cost Impact` |
| `update_existing_comment` | Update existing CloudCost comment if present | No | `true` |
| `enable_usage_reporting` | Send a usage record to the backend after successful analysis | No | `false` |

### Node.js Version Detection

The action automatically detects your Node.js version from:
1. `.nvmrc` file (if present)
2. `.node-version` file (if present)
3. Falls back to LTS if neither exists

You can override this by specifying `node_version`:
```yaml
- uses: odrori1997/cloudcost-gh-action@v0
  with:
    api_key: ${{ secrets.CLOUDCOST_API_KEY }}
    node_version: '18'  # Use Node 18 instead of auto-detection
```

## Requirements

- Valid CloudCost license key
- Repository with CloudFormation templates (CDK or raw CloudFormation)
- `pull-requests: write` permission in workflow
- Node.js project with `package.json` and `package-lock.json` (for dependency installation)

## Troubleshooting

### "License required" error

The action will set commit status to "error" and post a PR comment with instructions.

**Fix:** Add `CLOUDCOST_API_KEY` secret to your repository settings.

### No cost estimate appears

Verify that:
- Your PR modifies CloudFormation template files
- Workflow has `pull-requests: write` permission
- API key is valid and not expired
- `cdk synth` runs successfully in your repository

### Node.js version issues

If you encounter Node.js version compatibility errors:

1. **Check your version files**: Ensure `.nvmrc` or `.node-version` contains a valid Node.js version (e.g., `18.16.0` or `lts/*`)
2. **Override manually**: Specify the version explicitly in your workflow:
   ```yaml
   - uses: odrori1997/cloudcost-gh-action@v0
     with:
       api_key: ${{ secrets.CLOUDCOST_API_KEY }}
       node_version: '18'  # or '20', 'lts/*', etc.
   ```
3. **Verify package-lock.json**: Ensure `package-lock.json` exists in your repository root for dependency caching

## Support

- **Issues:** [Open an issue](https://github.com/odrori1997/cloudcost-gh-action/issues)
- **Email:** omerdrori.business@gmail.com
- **Documentation:** [Full documentation](https://cloudcost.io/docs)

## License

Proprietary software for licensed CloudCost users only. All rights reserved.