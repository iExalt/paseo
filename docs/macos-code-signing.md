# macOS code signing for the Nix-installed app

macOS stores each privacy grant (Screen & System Audio Recording, Device Control and Data Access, Full Disk Access, Developer Tools, App Management) with the designated requirement of the app it was granted to, and checks it again every time the app asks. For Paseo's processes, including the daemon that runs from the Nix store, the tccd log reads the static code at `/Applications/Paseo.app`, so that copy's signature is the one that matters.

The Nix build (`nix/desktop-package.nix`) is signed ad hoc because the build sandbox cannot reach a keychain. An ad hoc requirement is the build's `cdhash`, which changes with every release, so every update made the grants fail with `Failed to match existing code requirement` in the tccd log while System Settings still showed them enabled.

The updater therefore re-signs the `/Applications/Paseo.app` copy before installing it, with a fixed self-signed identity:

|             |                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| Name        | `Paseo Local Code Signing (iExalt)`                                                                     |
| SHA-1       | `C19E2ACC7E117CDC6F629D23EACF15A6BA588596` (`SIGNING_IDENTITY` in `scripts/paseo-nix-update-macos.mjs`) |
| Valid until | 2051-11-16                                                                                              |
| Certificate | [`nix/paseo-macos-codesign.pem`](../nix/paseo-macos-codesign.pem)                                       |
| Private key | `paseo-macos-codesign.key` in the private `iExalt/keychain` repository                                  |

The signed copy's requirement is `identifier "sh.paseo.desktop" and certificate leaf = H"c19e2acc…"`. It is the same for every release, so grants carry over.

## How the updater uses it

`installAppCopy` signs the staged copy with `codesign --force --deep` and checks it with `codesign --verify --deep --strict` against that requirement before swapping it in.

- If the identity is not in the keychain, it installs the ad hoc build and prints a warning.
- If signing fails or times out, it discards the staged copy, copies the store build again and installs that, so a half-signed bundle is never installed.
- If the installed copy is the active release but lacks the stable signature, the next `install-app` or profile switch replaces it while Paseo is not running.

The Nix build itself, and the store copy the daemon runs from, stay ad hoc.

## Set up a Mac

Each Mac needs the identity in its login keychain once:

```sh
gh repo clone iExalt/keychain ~/keychain-tmp
cd ~/keychain-tmp
pw=$(/usr/bin/openssl rand -hex 16)
/usr/bin/openssl pkcs12 -export -inkey paseo-macos-codesign.key -in paseo-macos-codesign.pem \
  -name "Paseo Local Code Signing (iExalt)" -out paseo.p12 -passout "pass:$pw"
security import paseo.p12 -k ~/Library/Keychains/login.keychain-db -P "$pw" -T /usr/bin/codesign
# Use the system LibreSSL: an OpenSSL 3 p12 can be refused by `security import`.
# Asks for the login keychain password. Without it, codesign prompts, and the
# headless updater times out and installs the ad hoc build.
security set-key-partition-list -S apple-tool:,apple: -s \
  -l "Paseo Local Code Signing (iExalt)" ~/Library/Keychains/login.keychain-db
cd ~ && rm -r ~/keychain-tmp
```

Leave the certificate untrusted: `security find-identity -p codesigning` lists it as `CSSMERR_TP_NOT_TRUSTED`, and `codesign` signs with it anyway. Don't add it as a trusted root.

Then quit Paseo and install a signed copy of the release named in the installed copy (if `paseo-nix-update status` reports a newer active release, run that release's `install-app` instead):

```sh
"$(jq -r .outputPath /Applications/Paseo.app/Contents/Resources/paseo-nix-managed.json)/bin/paseo-nix-update" install-app
```

## Limits

- The updater that installs a release is the one from the release you were running. The first update into a signing-aware release, and any update, rollback or downgrade performed by an older updater, installs an ad hoc copy. Run `install-app` from the new release as above, or the grants break until the next signing-aware install.
- Reset and approve the grants once after the first signed install, since the existing ones name an ad hoc `cdhash`: `tccutil reset All sh.paseo.desktop`, then enable Paseo again in System Settings → Privacy & Security. Full Disk Access and Screen & System Audio Recording are switched on there by hand; macOS doesn't prompt for them.

## Check it

```sh
codesign -d -r- /Applications/Paseo.app
# designated => identifier "sh.paseo.desktop" and certificate leaf = H"c19e2acc7e117cdc6f629d23eacf15a6ba588596"
/usr/bin/log show --last 10m --info --debug --predicate 'process == "tccd" AND eventMessage CONTAINS "Failed to match"'
```

In zsh, call `/usr/bin/log`: a bare `log` runs a shell builtin.

## Rotate the identity

Generate a new self-signed code-signing certificate (`keyUsage=digitalSignature`, `extendedKeyUsage=codeSigning`), store both halves in `iExalt/keychain`, and replace the PEM and `SIGNING_IDENTITY` together; the unit test checks they match. Every Mac then needs the setup above and one more grant reset.
