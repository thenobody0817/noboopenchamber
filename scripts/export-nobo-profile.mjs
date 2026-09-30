#!/usr/bin/env node
//
// Regenerates `nobo-profile/` from the config on this machine.
//
// The bundle is what `install-nobo.sh --profile` copies onto another machine,
// so it is generated rather than hand-maintained: run this after changing
// settings, themes or AGENTS.md and commit the result. Whatever it writes is
// reviewed in the diff like any other change.
//
// It redacts by allowlist of what to drop *and* refuses to finish if anything
// that looks like a credential survives, because the cost of being wrong here
// is publishing a key. Run it with --check to verify the committed bundle
// without rewriting it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'nobo-profile');
const HOME = os.homedir();
const CHECK_ONLY = process.argv.includes('--check');

/** Where the app keeps its own files, newest layout first. */
const DATA_DIRS = [
  path.join(HOME, '.config', 'noboopenchamber'),
  path.join(HOME, '.config', 'openchamber'),
];

const OPENCODE_CONFIG_DIR = path.join(HOME, '.config', 'opencode');

/**
 * Settings keys that describe *this* install: ports, window geometry, project
 * lists, and the keys this app has with OpenChamber's hosted services. None of
 * them mean anything on another machine, and the last group must not travel.
 */
const DROPPED_SETTINGS_KEYS = [
  'activeProjectId',
  'desktopDefaultHostId',
  'desktopHosts',
  'desktopInitialHostChoiceCompleted',
  'desktopInstallId',
  'desktopLocalClientToken',
  'desktopLocalPort',
  'desktopSshInstances',
  'desktopUiPassword',
  'desktopWindowState',
  'githubClientId',
  'githubScopes',
  'hasDesktopUiPassword',
  'homeDirectory',
  'lastDirectory',
  'managedLocalTunnelConfigPath',
  'managedRemoteTunnelPresetTokens',
  'managedRemoteTunnelSelectedPresetId',
  'managedRemoteTunnelToken',
  'projects',
  'relayEncryptionKey',
  'relaySigningKey',
  'securityScopedBookmarks',
];

/**
 * Nested state that belongs to a session or to the moment, not to a setup:
 * `permissionAutoAccept` remembers an auto-accept decision per session and
 * carries a revision that bumps whenever the app touches it, so a bundle that
 * kept it would churn on every export without telling the reader anything.
 */
const DROPPED_SETTINGS_PATHS = [
  'permissionAutoAccept.revision',
  'permissionAutoAccept.sessions',
];

/** A value that is allowed to stay even though its key looks sensitive. */
const ALLOWED_SENSITIVE = [
  /^lm-studio$/, // LM Studio's documented placeholder
  /^\{file:__HOME__\//, // a credential *reference* pointing at the new home
  /^__[A-Z0-9_]+__$/, // an explicit placeholder for the installer to fill
];

const SUSPICIOUS_KEY = /(privatejwk|apikey|secret|token|password|credential|signature)/i;

const resolver = { found: [], missing: [] };

function readDataFile(name) {
  for (const dir of DATA_DIRS) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      resolver.found.push(candidate);
      return fs.readFileSync(candidate, 'utf8');
    }
  }
  resolver.missing.push(name);
  return null;
}

/** Absolute home paths are meaningless elsewhere and leak the local username. */
function portable(text) {
  return text.split(HOME).join('__HOME__');
}

function writeFile(relativePath, contents) {
  const target = path.join(OUTPUT_ROOT, relativePath);
  if (CHECK_ONLY) {
    if (!fs.existsSync(target)) {
      throw new Error(`nobo-profile is missing ${relativePath}`);
    }
    if (fs.readFileSync(target, 'utf8') !== contents) {
      throw new Error(`nobo-profile/${relativePath} is out of date; re-run without --check`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function copyFile(sourcePath, relativePath) {
  writeFile(relativePath, portable(fs.readFileSync(sourcePath, 'utf8')));
}

function sanitizeSettings(raw) {
  const parsed = JSON.parse(raw);
  for (const key of DROPPED_SETTINGS_KEYS) {
    delete parsed[key];
  }
  for (const dotted of DROPPED_SETTINGS_PATHS) {
    const segments = dotted.split('.');
    const leaf = segments.pop();
    const parent = segments.reduce((node, segment) => (node && typeof node === 'object' ? node[segment] : undefined), parsed);
    if (parent && typeof parent === 'object') delete parent[leaf];
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/**
 * The provider block stays, because the model list and the gateway are the
 * whole point of a matching setup, but the credential *reference* points at the
 * new machine's home and the org header is dropped: it is an identifier of
 * this account, and the app says so plainly when a key needs one.
 */
function sanitizeOpencodeConfig(raw) {
  const parsed = JSON.parse(raw);
  const providers = parsed.provider ?? {};

  // LM Studio is a server on this machine's loopback; it means nothing there.
  delete providers.lmstudio;

  const options = providers['opencode-go']?.options;
  if (options) {
    if (typeof options.apiKey === 'string') {
      options.apiKey = portable(options.apiKey);
    }
    if (options.headers) {
      delete options.headers['X-Opencode-Org-Id'];
    }
  }

  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function assertNoCredentials(value, where) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && !ALLOWED_SENSITIVE.some((pattern) => pattern.test(value))) {
      return;
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SUSPICIOUS_KEY.test(key) && !ALLOWED_SENSITIVE.some((pattern) => pattern.test(String(entry ?? '')))) {
      throw new Error(`${where}: refused to publish '${key}'`);
    }
    assertNoCredentials(entry, where);
  }
}

// --- opencode ---------------------------------------------------------------

writeFile(
  'opencode/opencode.json',
  sanitizeOpencodeConfig(fs.readFileSync(path.join(OPENCODE_CONFIG_DIR, 'opencode.json'), 'utf8')),
);
copyFile(path.join(OPENCODE_CONFIG_DIR, 'AGENTS.md'), 'opencode/AGENTS.md');

for (const skill of ['self-config']) {
  const source = path.join(OPENCODE_CONFIG_DIR, 'skills', skill, 'SKILL.md');
  if (fs.existsSync(source)) copyFile(source, path.join('opencode/skills', skill, 'SKILL.md'));
}

// --- openchamber ------------------------------------------------------------

const settings = readDataFile('settings.json');
if (settings) writeFile('openchamber/settings.json', portable(sanitizeSettings(settings)));

const preferences = readDataFile('preferences.json');
if (preferences) {
  const parsed = JSON.parse(preferences);
  for (const key of DROPPED_SETTINGS_KEYS) {
    delete parsed.fields?.[key];
  }
  writeFile('openchamber/preferences.json', `${JSON.stringify(parsed, null, 2)}\n`);
}

for (const name of ['omarchy-dark.json', 'omarchy-light.json']) {
  const source = DATA_DIRS.map((dir) => path.join(dir, 'themes', name)).find((candidate) => fs.existsSync(candidate));
  if (source) copyFile(source, path.join('openchamber/themes', name));
  else resolver.missing.push(`themes/${name}`);
}

const links = readDataFile('links.conf');
if (links) writeFile('openchamber/links.conf', links);

// --- refuse to publish anything that still looks like a credential ----------

if (!CHECK_ONLY) {
  for (const file of ['opencode/opencode.json', 'openchamber/settings.json', 'openchamber/preferences.json']) {
    const target = path.join(OUTPUT_ROOT, file);
    if (!fs.existsSync(target)) continue;
    if (file.endsWith('.json')) {
      assertNoCredentials(JSON.parse(fs.readFileSync(target, 'utf8')), file);
    }
  }
}

console.log(
  CHECK_ONLY
    ? `nobo-profile is up to date (${resolver.found.length} source files read)`
    : `Wrote nobo-profile/ from ${resolver.found.length} source files`,
);
for (const name of resolver.missing) console.log(`  not present, skipped: ${name}`);
