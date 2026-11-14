---
name: update-nix-paseo
user-invocable: true
---

# Update Nix-managed Paseo (macOS)




```zsh
repo=$(git rev-parse --show-toplevel)
git -C "$repo" fetch -q origin dev
updater_dir=$(mktemp -d /tmp/paseo-updater.XXXXXX)
git -C "$repo" archive origin/dev 'scripts/paseo-nix-update*.mjs' packages/protocol/src |
  tar -x -C "$updater_dir"
upd() { (cd "$updater_dir" && mise exec -C "$repo" -- node scripts/paseo-nix-update.mjs "$@") }
```



Run `upd status --json` and `upd check --json`. Report active, staged, latest and

```zsh
upd stage --json
upd activate --json
```





```zsh
```





## Recovery


- `reactivate-high-water` returns to the highest activated release.

