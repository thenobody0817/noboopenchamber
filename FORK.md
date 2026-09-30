# noboopenchamber

An unofficial fork of [OpenChamber](https://github.com/openchamber/openchamber)
(MIT), built and released from this repository. It tracks upstream and merges
its releases, so the fork is a small set of deliberate changes on top of the
real thing rather than a divergent product.

Nothing here is affiliated with or endorsed by the OpenChamber project.

## What is different

**Shell rows read as sentences.** OpenCode v2 shell parts carry no title, so a
tool row used to show the command's first line — a hundred characters of flags
and paths to read before learning that a file was searched. The row now says
`Searched for winvr`, and the expanded body still shows the command in full.
Anything the heuristic cannot place falls back to `Ran <word>`, so it never
claims more than the command does. `packages/ui/src/lib/opencode/tools.ts`.

**Its own identity and data directory.** `~/Applications` naming, app id,
desktop entry and data directory (`~/.config/noboopenchamber`) all differ from
upstream, so this build and an installed OpenChamber can live on one machine
without sharing settings, chats or themes — and so the updater knows which
project it belongs to.

**Updates come from here.** `build.publish` points at
`thenobody0817/noboopenchamber`, and every release publishes `latest-linux.yml`
alongside the AppImage. Left alone, the updater would replace this build with
upstream's.

**A profile bundle.** `nobo-profile/` carries the maintainer's models, themes,
preferences and agent instructions to another machine, minus anything that
identifies or authenticates it. See `nobo-profile/README.md`.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/thenobody0817/noboopenchamber/nobo/scripts/install-nobo.sh | bash
```

Add `-s -- --profile` to also install the profile. On Arch, the script offers to
install `fuse2` if AppImages cannot run.

Installing alongside OpenChamber is fine: different data directory, different
desktop entry.

## Updating

The app updates itself from this repository. To force a fresh copy, run the
install command again.

## Working on the fork

`main` mirrors upstream and never carries a local commit; `nobo` is the branch
that ships and is the repository's default branch.

```bash
git fetch upstream
git merge upstream/main            # on nobo
bun install
bun run electron:dev               # HMR UI in the real Electron shell
```

To cut a release: tag `nobo` (`v2.0.4-nobo1` style — the version itself comes
from `package.json`, the suffix only keeps fork tags from colliding with
upstream's), push the tag, and `release-linux-nobo.yml` builds, verifies and
publishes the AppImage, the update manifest and the profile bundle.

Regenerate the profile after changing settings on your own machine:

```bash
node scripts/export-nobo-profile.mjs          # rewrite nobo-profile/
node scripts/export-nobo-profile.mjs --check  # verify it is current
```

### Merging upstream

Conflicts are few and mostly mechanical. The places that will fight:

- `packages/electron/package.json` — the `build` block, where the identity lives
- `packages/electron/scripts/verify-linux-appimage.mjs` — asserts the fork's
  identity, so it follows any change to the names above
- the data-directory defaults, in `packages/web`, `packages/electron` and the
  Settings tooltips
- `README.md`, because of the fork banner at the top

Upstream's CI workflows are left in place but disabled on this repository
(`gh workflow list` shows them as `disabled_manually`), so they cost nothing at
merge time and cannot fire on this fork's tags. The fork's own release path is
`.github/workflows/release-linux-nobo.yml`, a separate file for that reason.

### Hosted services

The relay, tunnel and dictation paths still point at OpenChamber's servers, as
upstream has them. They are not part of what this fork tests or supports; treat
them as upstream features that happen to be reachable from here.

## License

MIT, as upstream. See `LICENSE`.
