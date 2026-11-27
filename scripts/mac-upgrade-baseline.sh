#!/usr/bin/env bash
set -euo pipefail

version=$(jq -er .version package.json)
echo "version=$version" >> "$GITHUB_OUTPUT"
run=${BASELINE_OVERRIDE:-$(jq -r .baseline payload/build.json)}

# The first updater version has no installable predecessor. Later builds use
# the nearest earlier version with a verified artifact on the packaging branch.
if [[ -z "$run" ]]; then
  versions=$(git log --first-parent --format=%H -- package.json |
    while read -r commit; do git show "$commit:package.json" | jq -er .version; done |
    awk -v target="$version" '$0 != target && !seen[$0]++')
  if [[ -z "$versions" ]]; then
    echo "Initial version $version: checked the disk image; no earlier version for an upgrade." >> "$GITHUB_STEP_SUMMARY"
    exit 0
  fi
  while read -r previous; do
    name=$(jq -rn --arg n "mac-verified-$previous" '$n|@uri')
    run=$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/artifacts?name=$name&per_page=100" |
      jq -sr '[.[].artifacts[] | select(.expired == false and .workflow_run.head_branch == "codex/desktop-packaging")] | max_by(.created_at) | .workflow_run.id // empty')
    [[ -z "$run" ]] || break
  done <<< "$versions"
  if [[ -z "$run" ]]; then
    echo "Provide baseline_run with a previous verified Mac installer when resuming this build." >&2
    exit 1
  fi
fi

[[ "$run" =~ ^[0-9]+$ ]]
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run" |
  jq -e --arg repo "$GITHUB_REPOSITORY" '.head_repository.full_name == $repo and .head_branch == "codex/desktop-packaging" and .path == ".github/workflows/desktop-installers.yml" and (.event == "push" or .event == "workflow_dispatch")'
gh run download "$run" --repo "$GITHUB_REPOSITORY" -n AI-Laike-mac-arm64 -D baseline
echo "run=$run" >> "$GITHUB_OUTPUT"
