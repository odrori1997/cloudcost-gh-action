# CloudCost GitHub Action

Paywalled CloudFormation cost delta analysis for Pull Requests. No CDK synth required - analyzes only the CloudFormation templates changed in your PR.

## Features

- **Automatic CloudFormation Detection**: Finds CFN templates by filename patterns and content sniffing
- **Base vs Head Diff**: Compares costs between PR base and head for accurate delta reporting
- **License-Gated**: Requires a valid API key from CloudCost
- **Smart Comment Updates**: Creates or updates a single PR comment (no spam)
- **Zero Dependencies**: Pure Node.js with no npm packages required

## Installation

### 1. Purchase a License

Visit [https://cloudcost-action-api.vercel.app/pricing](https://cloudcost-action-api.vercel.app/pricing) to get your `YOUR_API_KEY`.

### 2. Add Secret to Repository

Add `YOUR_API_KEY` as a repository secret:
- Go to your repo → Settings → Secrets and variables → Actions
- Click "New repository secret"
- Name: `YOUR_API_KEY`
- Value: `<your-license-key>`

### 3. Add Workflow

Create `.github/workflows/cloudcost.yml` in your repository:

```yaml
name: CloudCost
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  cfn-cost:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # needed for base branch diffing

      - uses: odrori1997/cloudcost-gh-action@v0
        with:
          api_key: ${{ secrets.YOUR_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

## How It Works

1. **License Verification**: Validates your API key before proceeding
2. **Fetch Base Branch**: Ensures git can diff against the PR base
3. **Collect CFN Diffs**:
   - Finds changed files via `git diff`
   - Detects CloudFormation templates by filename and content
   - Collects both base and head versions
4. **Request Estimate**: Sends gzipped payload to CloudCost API
5. **Post Comment**: Creates or updates a single PR comment with cost analysis

## Supported CloudFormation Files

The action detects CloudFormation templates by:

**Filename patterns:**
- `*.template.json`, `*.template.yml`, `*.template.yaml`
- `template.json`, `template.yml`, `template.yaml`
- Files in `cdk.out/` ending with `.json`

**Content sniffing:**
- Files containing `AWSTemplateFormatVersion`
- Files with `Resources:` block (YAML)

## Requirements

- Node.js 18+ on the GitHub Actions runner (ubuntu-latest includes this)
- Valid CloudCost license key
- Repository with CloudFormation templates

## Troubleshooting

### "License required" error

The action will:
- Set commit status to "error" with link to purchase
- Post a PR comment with instructions

Fix by adding `YOUR_API_KEY` secret to your repository.

### No cost estimate appears

Check that:
- Your PR modifies CloudFormation template files
- Files match the detection patterns above
- The workflow has `pull-requests: write` permission

## License

All Rights Reserved. This is proprietary software for licensed CloudCost users only.

## Support

For issues or questions, contact support or open an issue on this repository.
