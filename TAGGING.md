# Tagging and Publishing Releases

## Create and Push a New Tag

### Annotated Tag (Recommended)
```bash
# Create an annotated tag with a message
git tag -a v0.4.0 -m "Your release message here"

# Push the tag to remote
git push origin v0.4.0
```

### Lightweight Tag
```bash
# Create a lightweight tag
git tag v0.4.0

# Push the tag to remote
git push origin v0.4.0
```

### One-liner
```bash
git tag -a v0.4.0 -m "Release message" && git push origin v0.4.0
```

## Useful Commands

### List all tags
```bash
git tag -l
```

### List tags sorted by version
```bash
git tag -l | sort -V
```

### Delete a tag
```bash
# Delete locally
git tag -d v0.4.0

# Delete on remote
git push origin --delete v0.4.0
```

## Versioning Guidelines

Use semantic versioning:
- **Patch** (v0.3.0 → v0.3.1): Bug fixes, small changes
- **Minor** (v0.3.0 → v0.4.0): New features, backwards compatible
- **Major** (v0.3.0 → v1.0.0): Breaking changes

Once a tag is pushed, users can reference the action with:
```yaml
- uses: odrori1997/cloudcost-gh-action@v0.4.0
```

