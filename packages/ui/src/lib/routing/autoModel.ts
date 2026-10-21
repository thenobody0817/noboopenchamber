/**
 * The routing sentinels. The composer sends one of them as an ordinary model;
 * the OpenChamber server replaces it with a real model before OpenCode sees the
 * request. Neither is ever a provider OpenCode knows about.
 *
 * `auto` asks the classifier which category a prompt belongs to. `auto-free`
 * skips that and runs on a model rolled at random from the free tier, once per
 * session.
 */
export const AUTO_PROVIDER_ID = 'openchamber';
export const AUTO_MODEL_ID = 'auto';
export const AUTO_FREE_MODEL_ID = 'auto-free';

/** Which sentinel a selection is, or null when it is a real model. */
export const autoModeOf = (
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): 'auto' | 'free' | null => {
  if (providerId !== AUTO_PROVIDER_ID) return null;
  if (modelId === AUTO_FREE_MODEL_ID) return 'free';
  return modelId === AUTO_MODEL_ID ? 'auto' : null;
};

/** Any sentinel, in either naming. What "is this an OpenChamber model" means. */
export const isAutoModel = (providerId: string | null | undefined, modelId: string | null | undefined): boolean =>
  autoModeOf(providerId, modelId) !== null;
