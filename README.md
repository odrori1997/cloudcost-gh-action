# CloudCost GitHub Action

Get instant CloudFormation cost estimates in your Pull Requests. CloudCost analyzes infrastructure cost changes before deployment, enabling engineering teams to make informed decisions about cloud spending within their existing workflow.

## Why CloudCost?

- **AWS Native** - Specializes in CloudFormation and CDK best practices
- **Zero configuration** - No cloud credentials or dashboards to set up, works out of the box
- **Prevent costly infra changes** - Get alerted before your surprise $47K AWS Bill
- **Resource-Level Cost Breakdowns** - Precise cost deltas on storage lifecycle policies, instance sizing, volume types


![CloudCost GitHub Action](screenshot.png)

*CloudCost comment in a Pull Request, showing the cost of an infrastructure change before it is made*

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

## How It Works

1. **Change Capture** - When you push a PR, scans for CloudFormation template changes
2. **Accurate Estimate** - Maps resource deltas to the latest AWS pricing 
3. **PR Integration** - Posts a single, updated comment with cost breakdown

## Requirements

- Node.js 18+ (included in `ubuntu-latest` runners)
- Valid CloudCost license key
- Repository with CloudFormation templates
- `pull-requests: write` permission in workflow

## Troubleshooting

### "License required" error

The action will set commit status to "error" and post a PR comment with instructions.

**Fix:** Add `CLOUDCOST_API_KEY` secret to your repository settings.

### No cost estimate appears

Verify that:
- Your PR modifies CloudFormation template files
- Files match the detection patterns above
- Workflow has `pull-requests: write` permission
- API key is valid and not expired

## Support

- **Issues:** [Open an issue](https://github.com/odrori1997/cloudcost-gh-action/issues)
- **Email:** omerdrori.business@gmail.com
- **Documentation:** [Full documentation](https://cloudcost.io/docs)

## License

Proprietary software for licensed CloudCost users only. All rights reserved.