# Releasing Pantheon

English | [简体中文](releasing.zh-CN.md)

> [!WARNING]
> Pantheon is an early-stage product under development. It is experimental.
> Each release is a test build. Mark it as a pre-release on GitHub.

## Version numbers

Pantheon uses `0.1.0-dev.<YYYYMMDD>`, for example `0.1.0-dev.20261115`.

- The date is the day of the release build.
- A second release on the same day adds a counter: `0.1.0-dev.20261115.2`.
- The git tag is `v` and the version: `v0.1.0-dev.20261115`.
- The version is valid semver. electron-builder requires semver.
- Do not use a date as a version part, as in `0.20261115.0`. Windows keeps each version part in 16 bits, so 20261115 does not fit.

## Steps

1. Select a commit on `main`. CI must be green on that commit.
2. Run the checks on the release machine:

   ```sh
   pnpm install --frozen-lockfile
   pnpm test
   pnpm format:check
   node scripts/api-doc.mjs --check
   node scripts/check-design.mjs
   ```

3. Set the version in every `package.json` of the workspace and commit it:

   ```sh
   V=0.1.0-dev.20261115
   pnpm -r --include-workspace-root exec npm pkg set version=$V
   git commit -am "chore: release $V"
   git tag -a v$V -m "Pantheon $V"
   ```

4. Build each target on a Mac. The [development guide](development.md#packaging) describes the targets and the signing setup.

   ```sh
   rm -rf apps/desktop/release
   for t in mac-arm64 win-x64 win-arm64 linux-x64 linux-arm64; do pnpm package --target $t; done
   ```

5. Write the checksums:

   ```sh
   cd apps/desktop/release
   shasum -a 256 *.dmg *.exe *.AppImage *.deb > SHA256SUMS
   ```

6. Do the smoke tests in the next section.
7. Push the commit and the tag, then create the pre-release:

   ```sh
   git push origin main v$V
   gh release create v$V --prerelease --title "Pantheon $V" --notes-file <notes.md> \
     apps/desktop/release/*.dmg apps/desktop/release/*.exe \
     apps/desktop/release/*.AppImage apps/desktop/release/*.deb apps/desktop/release/SHA256SUMS
   ```

## Smoke tests

| Package                   | Test                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| macOS `.dmg`              | `xcrun stapler validate <dmg>` and `spctl -a -vv -t install <dmg>` pass. Open the app from the dmg. The window connects to its daemon. |
| Linux `.deb`              | Install it in a clean Ubuntu container. The bundled daemon starts and `health` command of the bundled CLI answers.                     |
| Linux AppImage            | `--appimage-extract` works, and the extracted daemon starts with the bundled Node.                                                     |
| Windows installer (x64)   | Install it on Windows 11 with WSL 2. The app starts the daemon in WSL and shows the project list.                                      |
| Windows installer (arm64) | Not tested on a device. Say so in the release notes.                                                                                   |

## Release notes

Start the notes with the experimental notice. Then give:

- the platform table: each package, and whether it was tested on a device;
- the main changes since the last release;
- the known limits, with links to the issues.
