/**
 * Owns Jev routing at runtime: which classification provider answers, whether
 * Auto is ready, which model and agent a send that selected `openchamber/auto`
 * runs on, and the safety net consulted in a `safety` permission session.
 * Failure paths fall back to the user's own behaviour for routing (the
 * fallback model) and to the user's own decision for the safety net: a request
 * Jev could not check waits for the user, and the UI is told why.
 *
 * OpenCode 2.x holds the model and the agent on the session, switched by their
 * own calls, and a prompt body carries only the user's text. So Auto is a
 * per-session state here: the sentinel arrives on `POST /session/:id/model`
 * and is swallowed, and every prompt in that session is routed until a real
 * model is selected.
 *
 * There are two sentinels on that provider. `auto` asks Jev which category a
 * prompt belongs to; `auto-free` skips Jev entirely and runs on a model picked
 * at random from the free tier, once per session.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OpenCode } from '@opencode/client';
import { z } from 'zod';
import {
  AUTO_FREE_MODEL_REF,
  AUTO_MODEL_REF,
  BUILTIN_CATEGORIES,
  FREE_PROVIDER_ID,
  ZEN_JEV_PROMOTION_ACTIVE,
  sentinelModeOf,
} from './defaults.js';
import { readMergedSettingsSync } from '../opencode/settings-files.js';
import { createRoutingStore, parseEffectiveConfig } from './store.js';
import { buildPermissionRequest, buildRoutingRequest, createJevClient, decidePermission, decideRouting } from './jev.js';
import {
  CLASSIFIER_SOURCES,
  classifierEndpoint,
  legacyClassifier,
  normalizeCustomEndpointUrl,
  readPinnedCustomEndpoint,
  resolveClassifier,
} from './classifier.js';
import { loadRoutingHistory } from './history.js';
import { readOpenCodeCredentials } from '../opencode/auth.js';
import { ENTERPRISE_MODE_ERROR, isEnterpriseMode } from '../enterprise-mode.js';

const HISTORY_TIMEOUT_MS = 2500;
/** A held permission is remembered so reconnect reconciliation does not re-ask Jev. */
const PERMISSION_DECISION_TTL_MS = 15 * 60 * 1000;

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

/**
 * The models the user hid from the picker, as `provider/model` strings.
 *
 * Auto-free picks from the same catalogue the picker shows, so it has to honour
 * the same exclusions: a "free" choice that keeps handing back a model the user
 * deliberately hid is worse than not offering the feature. Read synchronously
 * because it sits on the send path, the way `session-goal` reads its toggles.
 */
// The merged document is untyped JSON, so the model refs are parsed here rather
// than narrowed by inspection at each use.
const hiddenModelRefSchema = z.object({ providerID: z.string().min(1), modelID: z.string().min(1) });

const hiddenModelRefs = (fsImpl = fs, pathImpl = path, settingsFilePath = OPENCHAMBER_SETTINGS_FILE) => {
  const settings = readMergedSettingsSync({ fs: fsImpl, path: pathImpl, settingsFilePath });
  const hidden = z.array(hiddenModelRefSchema).safeParse(settings.hiddenModels);
  if (!hidden.success) return new Set();
  return new Set(hidden.data.map((entry) => `${entry.providerID}/${entry.modelID}`));
};

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

// v2's command body (`session.command` in the protocol) names the command in
// `name` and carries its arguments in `text`; a prompt body has no `name`.
const commandBodySchema = z.object({ name: z.string().trim().min(1), text: z.string().nullish() });
// v2 sends one user turn as flat text; the context the composer attached went
// ahead of it as synthetic messages, which are never the request being routed.
const promptBodySchema = z.object({ text: z.string().nullish() });

/** The user's words for this send: the prompt text, or the slash command. */
export const requestTextOf = (body) => {
  const command = commandBodySchema.safeParse(body);
  if (command.success) {
    const args = command.data.text?.trim();
    return `/${command.data.name}${args ? ` ${args}` : ''}`;
  }
  const prompt = promptBodySchema.safeParse(body);
  return (prompt.success ? prompt.data.text ?? '' : '').trim();
};

const agentBodySchema = z.object({ agent: z.string().trim().min(1) });

// v2 serves one flat model catalogue; a model's thinking levels are `{ id }[]`.
// The free filter also needs what a model costs and whether it is offered, so
// those travel here too.
const catalogResponseSchema = z.object({
  data: z.array(z.object({
    providerID: z.string(),
    modelID: z.string(),
    capabilities: z.object({ tools: z.boolean().optional() }).optional(),
    cost: z.array(z.object({ input: z.number(), output: z.number() })).default([]),
    status: z.string().optional(),
    enabled: z.boolean().optional(),
  })),
});

const customEndpointInputSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  model: z.string().trim().min(1).max(200),
  key: z.string().trim().max(4000).nullable().optional(),
});

/** OpenChamber stores a model as `{ providerID, modelID }`; v2 wants a `Model.Ref`. */
const toModelRef = (model, variant) => {
  const ref = { providerID: model.providerID, id: model.modelID };
  if (variant) ref.variant = variant;
  return ref;
};

/**
 * The API keys the user saved in OpenCode for the providers that serve Jev. An
 * OpenCode account sign-in is an OAuth credential, which Zen rejects as a key,
 * so only `api` entries count.
 */
const apiKeySchema = z.object({ type: z.literal('api'), key: z.string().min(1) });
const envKeySchema = z.string().trim().min(1);

/**
 * OpenCode also connects OpenRouter and AI Gateway from these variables, read
 * live and never stored in its database. A managed OpenCode inherits this
 * server's environment, so the same variable is the same key. A saved key
 * wins over the variable; Zen has no variable.
 */
const PROVIDER_ENV_KEYS = { openrouter: 'OPENROUTER_API_KEY', vercel: 'AI_GATEWAY_API_KEY' };

export const readOpenCodeKeys = async ({ readAuth = readOpenCodeCredentials, env = process.env } = {}) => {
  let auth = {};
  try {
    auth = await readAuth();
  } catch {
    // An unreadable credential store still leaves the environment.
  }
  const saved = (providerId) => apiKeySchema.safeParse(auth[providerId]).data?.key ?? null;
  const fromEnv = (providerId) => envKeySchema.safeParse(env[PROVIDER_ENV_KEYS[providerId]]).data ?? null;
  return {
    zenKey: saved('opencode'),
    openrouterKey: saved('openrouter') ?? fromEnv('openrouter'),
    vercelKey: saved('vercel') ?? fromEnv('vercel'),
  };
};

export function createRoutingRuntime({
  dataDir,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastGlobalUiEvent,
  fetchImpl = fetch,
  store = createRoutingStore({ dataDir }),
  jev = createJevClient({ fetchImpl }),
  readProviderKeys = () => readOpenCodeKeys(),
  zenPromotionActive = ZEN_JEV_PROMOTION_ACTIVE,
  enterpriseMode = isEnterpriseMode,
  readPinnedEndpoint = readPinnedCustomEndpoint,
  listCatalogModels = null,
  readHiddenModels = hiddenModelRefs,
  random = Math.random,
  now = Date.now,
}) {
  const permissionDecisions = new Map();
  // Sessions the user put on a sentinel, with which one (`mode`) and, for a
  // free session, the model it was rolled onto. The sentinel never reaches
  // OpenCode, so nothing upstream remembers the choice for us.
  // TODO(v2): this is process memory. A server restart drops the mark and the
  // session silently runs on whatever model it was last switched to while the
  // composer still shows Auto. Either persist it next to `routing.json` or have
  // the client resend the sentinel with every send.
  const autoSessions = new Map();
  const AUTO_SESSION_LIMIT = 1000;

  const broadcast = (type, properties) => {
    try {
      broadcastGlobalUiEvent?.({ type, properties });
    } catch (error) {
      console.warn(`[routing] failed to broadcast ${type}:`, errorMessage(error));
    }
  };

  const enabledCategories = (config) => config.categories.filter((category) => category.enabled);

  /** Which classification provider answers now, and where its requests go (null endpoint: no Jev). */
  const resolveAccess = async () => {
    const [typesafeKey, stored, savedEndpoint] = await Promise.all([
      store.readToken(),
      store.readClassifierSource(),
      store.readCustomEndpoint(),
    ]);
    // An endpoint the administrator pinned replaces the one saved in Settings.
    const pinned = readPinnedEndpoint();
    const customEndpoint = pinned ?? savedEndpoint;
    const keys = { typesafeKey, customEndpoint, ...(await readProviderKeys()) };
    // Enterprise mode overrides whatever was picked; the pick itself is kept.
    // The pinned endpoint is the administrator's own, so there it is the
    // default and Off the only other choice.
    const selected = !enterpriseMode() ? stored : pinned && stored !== 'off' ? 'custom' : 'off';
    const classifier = resolveClassifier({ selected, ...keys, zenPromotionActive });
    const endpoint = classifier.effective ? classifierEndpoint(classifier.effective, keys) : null;
    return { classifier, endpoint, tokenPresent: Boolean(typesafeKey), customEndpoint, pinned: pinned !== null };
  };

  // What Settings shows of the custom endpoint: never the key itself.
  const describeCustomEndpoint = (endpoint, pinned) => (endpoint
    ? { url: endpoint.url, model: endpoint.model, keyPresent: Boolean(endpoint.key), pinned }
    : null);

  const pinnedEndpointError = () => Object.assign(
    new Error('The custom endpoint is set by your administrator and cannot be changed here'),
    { status: 409 },
  );

  /** What the client needs to decide whether to offer Auto and the safety net, and what Settings shows. */
  const describe = async () => {
    const [config, access] = await Promise.all([store.readConfig(), resolveAccess()]);
    const jevAvailable = access.endpoint !== null;
    const autoReady = jevAvailable && config.enabled && Boolean(config.fallback) && enabledCategories(config).length >= 2;
    // Auto-free needs none of that: no classifier, no fallback, no categories.
    // It is ready exactly when the free tier has at least one usable model.
    //
    // Read without a `directory` on purpose: this endpoint takes none, and a
    // boolean is all it carries. The catalogue is location-scoped, so the pick
    // made at send time is scoped while this readiness flag is not — a location
    // whose catalogue differs can disagree, and the send is what decides.
    let freeAutoReady = false;
    try {
      freeAutoReady = (await freeModels()).length > 0;
    } catch (error) {
      console.warn('[routing] model catalog unavailable, Auto-free is not offered:', errorMessage(error));
    }
    // Built-in text travels with the config so "Reset" in Settings restores the shipped wording.
    // `available` stays in the payload for the client: a runtime without an
    // OpenChamber server (VS Code) answers 404 and reads it as false.
    // `jevSource` is the two-value field clients from before the classifier
    // pick parse, `classifier` what v2.0.2 clients parse, and `classification`
    // the full picture.
    return {
      available: true,
      autoReady,
      freeAutoReady,
      jevAvailable,
      tokenPresent: access.tokenPresent,
      customEndpoint: describeCustomEndpoint(access.customEndpoint, access.pinned),
      enterpriseMode: enterpriseMode(),
      jevSource: access.classifier.effective === 'typesafe' ? 'typesafe' : 'zen-free',
      classifier: legacyClassifier(access.classifier),
      classification: access.classifier,
      config,
      builtins: BUILTIN_CATEGORIES,
    };
  };

  const publishUpdated = async () => {
    const state = await describe();
    broadcast('openchamber:routing.updated', {
      available: state.available,
      autoReady: state.autoReady,
      freeAutoReady: state.freeAutoReady,
      jevAvailable: state.jevAvailable,
      tokenPresent: state.tokenPresent,
      jevSource: state.jevSource,
    });
    return state;
  };

  const openCodeClient = (directory) => {
    const headers = { ...getOpenCodeAuthHeaders() };
    // v2 scopes by header and rejects non-ASCII header values.
    const scope = z.string().trim().min(1).safeParse(directory);
    if (scope.success) headers['x-opencode-directory'] = encodeURIComponent(scope.data);
    return OpenCode.make({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers });
  };

  const readHistory = async ({ sessionId, directory }) => {
    const client = openCodeClient(directory);
    const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS);
    return loadRoutingHistory({
      signal,
      // v2 pages a session's messages newest first and returns `{ data, cursor }`.
      readPage: ({ limit, cursor }) => client.message.list(
        { sessionID: sessionId, limit, ...(cursor ? { cursor } : { order: 'desc' }) },
        { signal },
      ),
    });
  };

  // A category without a model of its own means "the fallback pair"; a variant
  // only travels with the model it was chosen for.
  const chooseSelection = (config, choice, composerAgent) => {
    const own = Boolean(choice?.model);
    const model = own ? choice.model : config.fallback.model;
    const variant = own ? choice.variant : config.fallback.variant;
    return {
      model: toModelRef(model, variant),
      // A category agent replaces the composer's; an empty one keeps it.
      agent: choice?.agent || composerAgent || null,
      decision: { providerID: model.providerID, modelID: model.modelID, variant: variant ?? null, agent: choice?.agent ?? null },
    };
  };

  /**
   * The catalogue, from the caller when one was injected and from OpenCode
   * otherwise. An injected source already yields parsed rows, so it is used
   * as-is; the live call goes through `catalogResponseSchema`.
   */
  const readCatalog = listCatalogModels
    ?? (async (directory) => catalogResponseSchema.parse(await openCodeClient(directory).model.list()).data);

  /**
   * The models Auto-free may pick from.
   *
   * "Free" is read off the catalogue rather than a hand-written list, because
   * OpenCode rotates this tier: the free roster on this install changed between
   * two runs of the same build. A model qualifies when every cost tier is
   * exactly zero, it is still offered, and it can call tools. Three exclusions
   * are deliberate rather than incidental:
   *
   * - a missing `cost` array is NOT free. It means the catalogue does not know
   *   the price; a local model configured by hand looks exactly like this, and
   *   "we cannot tell" must never resolve to "cost us nothing".
   * - `capabilities.tools === false` keeps the image and audio models out; a
   *   free pick that cannot call tools is useless to an agent.
   * - a repeat `modelID` is skipped, because several free models are listed
   *   under more than one provider and would otherwise be twice as likely.
   *
   * Scoped to `FREE_PROVIDER_ID`: those models authenticate with a public key
   * and need no credential from the user. `opencode-go` also lists zero-cost
   * models, but they are served by the Go subscription endpoint.
   */
  const freeModels = async (directory) => {
    const hidden = readHiddenModels();
    const seen = new Set();
    const models = [];
    for (const model of await readCatalog(directory)) {
      if (model.providerID !== FREE_PROVIDER_ID) continue;
      if (model.enabled === false) continue;
      if (model.status && model.status !== 'active') continue;
      if (model.capabilities?.tools === false) continue;
      if (!model.cost.length) continue;
      if (!model.cost.every((tier) => tier.input === 0 && tier.output === 0)) continue;
      if (seen.has(model.modelID)) continue;
      if (hidden.has(`${model.providerID}/${model.modelID}`)) continue;
      seen.add(model.modelID);
      models.push({ providerID: model.providerID, modelID: model.modelID });
    }
    return models;
  };

  /**
   * A free model to run on. Never falls back: with no free model the caller is
   * told the set is empty rather than sent to the configured fallback, which is
   * usually a paid model. Quietly spending the user's money out of a picker
   * labelled "free" is the one outcome worth refusing instead of paper over.
   */
  const pickFreeModel = (models) => models[Math.floor(random() * models.length)] ?? null;

  /**
   * Drops a variant the model does not list, so the reply runs on the model's
   * default thinking instead of OpenCode refusing it. Routing settings from
   * before #4133 saved list positions ("0", "1", "2") as variants. A catalog
   * that cannot be read, or does not know the model yet, keeps the variant.
   */
  const withKnownVariant = async (selection, directory) => {
    const variant = selection.model.variant;
    if (!variant) return selection;
    let models;
    try {
      models = await readCatalog(directory);
    } catch (error) {
      console.warn('[routing] model catalog unavailable, keeping the saved variant:', errorMessage(error));
      return selection;
    }
    const { providerID, id } = selection.model;
    const entry = models.find((model) => model.providerID === providerID && model.modelID === id);
    if (!entry || entry.variants.some((known) => known.id === variant)) return selection;
    console.warn(`[routing] ${providerID}/${id} has no "${variant}" thinking level; using its default`);
    return {
      ...selection,
      model: { providerID, id },
      decision: { ...selection.decision, variant: null },
    };
  };

  /**
   * Resolves one send in an Auto-free session: the model this session was rolled
   * onto, or a fresh roll. Returns the same shape as `resolveAutoSelection`, so
   * every caller above it is unchanged.
   *
   * The roll is per session, not per send. A new model each turn would mean a
   * cold prompt cache on every message and a visibly different voice inside one
   * transcript; pinning keeps the thread coherent while a new session still
   * gives a new roll. It only moves when the pinned model is no longer in the
   * free set, so a model that OpenCode retires mid-thread does not strand it.
   *
   * Throws when the free set is empty. The sentinel must never reach OpenCode,
   * and the configured fallback is a paid model the user chose for something
   * else, so neither forwarding nor falling back is right here.
   */
  const resolveFreeSelection = async ({ sessionId, directory, model, agent }) => {
    if (sentinelModeOf(model) !== 'free') return null;
    const mark = autoSessions.get(sessionId);
    const models = await freeModels(directory);
    let picked = mark?.picked && models.find((entry) => entry.providerID === mark.picked.providerID && entry.modelID === mark.picked.modelID);
    if (!picked) {
      picked = pickFreeModel(models);
      if (!picked) {
        throw Object.assign(new Error('Auto-free is selected but OpenCode has no free model available'), { status: 400 });
      }
    }
    if (mark?.picked?.modelID !== picked.modelID || mark?.picked?.providerID !== picked.providerID) {
      rememberAutoSession(sessionId, { directory: directory ?? null, mode: 'free', picked });
    }
    const decision = {
      sessionId,
      at: now(),
      category: null,
      confidence: 0,
      reason: 'free-pick',
      ms: 0,
      providerID: picked.providerID,
      modelID: picked.modelID,
      variant: null,
      agent: null,
    };
    broadcast('openchamber:routing.decision', decision);
    return {
      model: { providerID: picked.providerID, id: picked.modelID },
      // Auto-free never chooses an agent: the composer keeps the one it has.
      agent: agent || null,
      decision,
    };
  };

  /**
   * Resolves one send that named the Auto sentinel. Returns the model and
   * agent the send must use, or null when a real model was selected.
   *
   * v2 carries neither model nor agent in a prompt body — they are session
   * state, switched by their own calls — so the caller applies the selection
   * (`applySessionSelection`, or its own switch calls) instead of the runtime
   * rewriting a body in place the way v1 allowed.
   *
   * Throws only when Auto cannot be honoured at all (no fallback configured):
   * the sentinel must never reach OpenCode.
   */
  const resolveAutoSelection = async ({ sessionId, directory, model, agent, requestText }) => {
    if (sentinelModeOf(model) !== 'auto') return null;
    const state = await describe();
    const config = state.config;
    if (!config?.fallback) {
      throw Object.assign(new Error('Auto routing is selected but no fallback model is configured'), { status: 400 });
    }
    const decision = { sessionId, at: now(), category: null, confidence: 0, reason: 'not-ready', ms: 0 };
    let selection;
    if (state.autoReady) {
      let history = [];
      try {
        history = await readHistory({ sessionId, directory });
      } catch (error) {
        console.warn('[routing] history unavailable, routing on the request alone:', errorMessage(error));
      }
      try {
        const { endpoint } = await resolveAccess();
        if (!endpoint) throw new Error('No classification provider is available');
        const request = (requestText ?? '').trim();
        const { answers, ms } = await jev.ask(buildRoutingRequest({ categories: enabledCategories(config), history, request }), endpoint);
        const result = decideRouting(answers.category, { categories: enabledCategories(config), minConfidence: config.minConfidence });
        decision.category = result.category?.id ?? null;
        decision.confidence = result.confidence;
        decision.reason = result.reason;
        decision.ms = ms;
        selection = chooseSelection(config, result.category, agent);
      } catch (error) {
        decision.reason = 'error';
        decision.error = errorMessage(error);
        selection = chooseSelection(config, null, agent);
      }
    } else {
      selection = chooseSelection(config, null, agent);
    }
    selection = await withKnownVariant(selection, directory);
    Object.assign(decision, selection.decision);
    broadcast('openchamber:routing.decision', decision);
    return { model: selection.model, agent: selection.agent, decision };
  };

  /** Records a session as sitting on a sentinel, replacing any earlier mark. */
  const rememberAutoSession = (sessionId, mark) => {
    autoSessions.delete(sessionId);
    autoSessions.set(sessionId, { ...mark, at: now() });
    while (autoSessions.size > AUTO_SESSION_LIMIT) autoSessions.delete(autoSessions.keys().next().value);
  };

  /**
   * `POST /session/:id/model` with a sentinel puts the session on it; with any
   * real model it takes the session off again.
   */
  const noteModelSelection = (sessionId, model, directory) => {
    if (!sessionId) return false;
    const mode = sentinelModeOf(model);
    if (!mode) {
      autoSessions.delete(sessionId);
      return false;
    }
    // A fresh mark clears the pinned free model: picking Auto-free again is
    // how the user asks for a different roll.
    rememberAutoSession(sessionId, { directory: directory ?? null, mode, picked: null });
    return true;
  };

  const isAutoSession = (sessionId) => Boolean(sessionId) && autoSessions.has(sessionId);

  /**
   * Resolves any sentinel, whichever one the caller was handed. The send rewrite
   * dispatches on the session's own mode; this is the entry point for callers
   * that only have the model ref (the message queue, session goals) and cannot
   * tell the two apart themselves.
   */
  const resolveSelection = async ({ sessionId, directory, model, agent, requestText }) => {
    const mode = sentinelModeOf(model);
    if (mode === 'free') return resolveFreeSelection({ sessionId, directory, model, agent });
    if (mode === 'auto') return resolveAutoSelection({ sessionId, directory, model, agent, requestText });
    return null;
  };

  /** Switches the session onto a resolved selection, the way a v2 send does. */
  const applySessionSelection = async (sessionId, directory, selection) => {
    const client = openCodeClient(directory);
    await client.session.switchModel({ sessionID: sessionId, model: selection.model });
    if (selection.agent) await client.session.switchAgent({ sessionID: sessionId, agent: selection.agent });
  };

  /**
   * One send in a routed session: resolves the model for it and switches the
   * session onto it. Which sentinel the session is on decides how — Jev for
   * `auto`, a free roll for `auto-free` — and both return the same shape.
   */
  const routeSend = async ({ sessionId, directory, body }) => {
    const mode = autoSessions.get(sessionId)?.mode ?? 'auto';
    const sentinel = mode === 'free' ? AUTO_FREE_MODEL_REF : AUTO_MODEL_REF;
    const agent = agentBodySchema.safeParse(body).data?.agent ?? null;
    const resolved = mode === 'free'
      ? await resolveFreeSelection({ sessionId, directory, model: sentinel, agent })
      : await resolveAutoSelection({ sessionId, directory, model: sentinel, agent, requestText: requestTextOf(body) });
    if (!resolved) return null;
    // v2 prompt and command bodies carry neither model nor agent: switching
    // the session is the whole application of the decision.
    await applySessionSelection(sessionId, directory, resolved);
    return resolved.decision;
  };

  /**
   * Consulted by permission auto-accept in a `safety` session before it
   * replies. `accept` replies; `hold` leaves the request for the user. Only a
   * verdict from Jev accepts: with no classification provider the request
   * waits quietly, the way an `ask` session's would; when Jev fails it waits
   * too, and the UI is told why (`skipped`).
   */
  const evaluatePermission = async (permission, directory) => {
    if (!permission?.id) return { action: 'hold' };
    const cached = permissionDecisions.get(permission.id);
    if (cached && now() - cached.at < PERMISSION_DECISION_TTL_MS) return cached.result;
    const [config, access] = await Promise.all([store.readConfig(), resolveAccess()]);
    if (!access.endpoint) return { action: 'hold', unavailable: true };
    let result;
    try {
      const { answers } = await jev.ask(buildPermissionRequest(permission), access.endpoint);
      const verdict = decidePermission(answers, { threshold: config.safetyNet.threshold });
      result = verdict.hold
        ? { action: 'hold', score: verdict.score, kind: verdict.kind }
        : { action: 'accept', score: verdict.score, kind: verdict.kind };
    } catch (error) {
      // Not remembered: reconnect reconciliation asks Jev again, and may accept.
      const skipped = errorMessage(error);
      broadcast('openchamber:routing.safety-skipped', {
        permissionId: permission.id, sessionId: permission.sessionID, directory: directory ?? null, error: skipped,
      });
      return { action: 'hold', skipped };
    }
    if (result.action === 'hold') {
      broadcast('openchamber:routing.permission-held', {
        permissionId: permission.id, sessionId: permission.sessionID, directory: directory ?? null, score: result.score, kind: result.kind,
      });
    }
    permissionDecisions.set(permission.id, { at: now(), result });
    return result;
  };

  /**
   * Whether the old global safety-net switch was on. Asked once, when the
   * permission policy converts its pre-modes `true` entries: those sessions
   * were auto-accepting behind the safety net, so they become `safety`.
   */
  const legacySafetyNetEnabled = async () => {
    try {
      return (await store.readConfig()).safetyNet.enabled === true;
    } catch {
      return false;
    }
  };

  const forgetPermission = (permissionId) => {
    permissionDecisions.delete(permissionId);
  };

  const updateConfig = async (input) => {
    const config = parseEffectiveConfig(input);
    await store.writeConfig(config);
    return publishUpdated();
  };

  const setToken = async (token) => {
    const parsed = z.string().trim().min(1).max(4000).safeParse(token);
    if (!parsed.success) throw Object.assign(new Error('A Jev API key is required'), { status: 400 });
    if (enterpriseMode()) throw Object.assign(new Error(ENTERPRISE_MODE_ERROR), { status: 403 });
    await store.writeToken(parsed.data);
    // Pasting a key is choosing it.
    await store.writeClassifierSource('typesafe');
    return publishUpdated();
  };

  const clearToken = async () => {
    await store.clearToken();
    return publishUpdated();
  };

  const setClassifierSource = async (source) => {
    const parsed = z.enum(CLASSIFIER_SOURCES).safeParse(source);
    if (!parsed.success) throw Object.assign(new Error(`Unknown classification provider: ${String(source)}`), { status: 400 });
    const allowedInEnterprise = parsed.data === 'off' || (parsed.data === 'custom' && readPinnedEndpoint() !== null);
    if (enterpriseMode() && !allowedInEnterprise) throw Object.assign(new Error(ENTERPRISE_MODE_ERROR), { status: 403 });
    await store.writeClassifierSource(parsed.data);
    return publishUpdated();
  };

  /**
   * Saves the custom System One endpoint and picks it, the way saving a
   * TypeSafe key does. `key`: a string replaces the saved one, null removes
   * it, absent keeps it, so the URL or model can change without retyping it.
   */
  const setCustomEndpoint = async (input) => {
    if (readPinnedEndpoint()) throw pinnedEndpointError();
    if (enterpriseMode()) throw Object.assign(new Error(ENTERPRISE_MODE_ERROR), { status: 403 });
    const parsed = customEndpointInputSchema.safeParse(input);
    if (!parsed.success) throw Object.assign(new Error('A URL and a model are required'), { status: 400 });
    const { model, key } = parsed.data;
    const url = normalizeCustomEndpointUrl(parsed.data.url);
    // An empty key field is the same as leaving it out.
    const keepKey = key === undefined || key === '';
    const savedKey = keepKey ? (await store.readCustomEndpoint())?.key : key;
    const endpoint = { url, model };
    if (savedKey) endpoint.key = savedKey;
    await store.writeCustomEndpoint(endpoint);
    // Saving is choosing it; removing only the key is not a choice of anything.
    if (key !== null) await store.writeClassifierSource('custom');
    return publishUpdated();
  };

  const clearCustomEndpoint = async () => {
    if (readPinnedEndpoint()) throw pinnedEndpointError();
    await store.clearCustomEndpoint();
    return publishUpdated();
  };

  /** Where a Jev request goes right now, or null when no classification provider is usable. */
  const currentClassifierEndpoint = async () => (await resolveAccess()).endpoint;

  /** Held permissions the UI can read back after a reload. */
  const heldPermissions = () => {
    const held = [];
    for (const [permissionId, entry] of permissionDecisions) {
      if (entry.result.action === 'hold') held.push({ permissionId, score: entry.result.score, kind: entry.result.kind });
    }
    return held;
  };

  return {
    describe,
    classifierEndpoint: currentClassifierEndpoint,
    noteModelSelection,
    isAutoSession,
    resolveAutoSelection,
    resolveFreeSelection,
    resolveSelection,
    applySessionSelection,
    routeSend,
    evaluatePermission,
    forgetPermission,
    heldPermissions,
    legacySafetyNetEnabled,
    updateConfig,
    setToken,
    clearToken,
    setClassifierSource,
    setCustomEndpoint,
    clearCustomEndpoint,
  };
}
