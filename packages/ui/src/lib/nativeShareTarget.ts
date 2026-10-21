/**
 * Inbound Android share sheet: the web half of the native `ShareTarget` plugin.
 *
 * The manifest offers the app as a share target, so any Android app can hand it
 * text, links, images or files. `ShareTargetPlugin` copies every shared stream
 * into the app cache the moment the intent arrives and announces the share as an
 * event; the renderer may not even be connected yet when that happens, which is
 * why the event is retained until a listener exists.
 *
 * Files are read one at a time, on the same reasoning as the camera session: each
 * attachment becomes a base64 data URL inside the composer, so a batch would hold
 * several megabytes of string at once.
 *
 * Shaped like nativeFileShare.ts and mobileCameraCapture.ts, the other app-local
 * bridge callers.
 */

/** One shared stream, as the native plugin reports it. */
export interface SharedFile {
  index: number;
  filename: string;
  mimeType: string;
  byteLength: number;
}

export interface SharedContent {
  /** The shared text or link, or null when the share was files only. */
  text: string | null;
  files: SharedFile[];
  /** Files the plugin refused, because they were over the size cap. */
  skipped: string[];
}

type SharedContentListenerHandle = { remove: () => Promise<void> | void };

type ShareTargetPlugin = {
  read?: (options: { index: number }) => Promise<{ data: string }>;
  clear?: () => Promise<void>;
  addListener?: (
    event: 'sharedContent',
    listener: (payload: SharedContent) => void,
  ) => Promise<SharedContentListenerHandle> | SharedContentListenerHandle;
};

type CapacitorGlobal = {
  getPlatform?: () => string;
  registerPlugin?: (name: string) => ShareTargetPlugin;
};

// SAFETY: `window.Capacitor` is injected by the native shell with this shape and
// is absent in every other runtime, which the optional members account for.
const getCapacitor = (): CapacitorGlobal | undefined =>
  (window as typeof window & { Capacitor?: CapacitorGlobal }).Capacitor;

/**
 * The Android plugin. Returns null on every other surface: iOS share intents
 * arrive through a share extension, which this package does not have, and hosted
 * mobile has no native shell at all.
 */
const getPlugin = (): ShareTargetPlugin | null => {
  if (typeof window === 'undefined') return null;
  const capacitor = getCapacitor();
  if (capacitor?.getPlatform?.() !== 'android' || !capacitor.registerPlugin) {
    return null;
  }
  // registerPlugin warns and hands back the old proxy when called twice.
  let plugin = androidPlugin;
  if (!plugin) {
    plugin = capacitor.registerPlugin('ShareTarget');
    androidPlugin = plugin;
  }
  return plugin;
};

let androidPlugin: ShareTargetPlugin | null = null;

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/** Whether this surface can receive a share at all. */
export const isShareTargetAvailable = (): boolean => getPlugin() !== null;

/**
 * Subscribes to shares arriving from other Android apps. A share that landed
 * before the listener existed is delivered on subscribe. Resolves to an
 * unsubscribe function.
 */
export const onSharedContent = async (
  listener: (share: SharedContent) => void,
): Promise<() => void> => {
  const plugin = getPlugin();
  if (!plugin?.addListener) return () => {};
  const handle = await plugin.addListener('sharedContent', (payload) => {
    listener({
      text: payload?.text ?? null,
      files: payload?.files ?? [],
      skipped: payload?.skipped ?? [],
    });
  });
  return () => {
    void handle.remove();
  };
};

/**
 * Fetches one shared file as a `File`, ready for
 * `useInputStore.addAttachedFile`. Sequential at the call site rather than in
 * parallel, so a multi-file share never has several of these base64 in flight.
 */
export const readSharedFile = async (file: SharedFile): Promise<File> => {
  const plugin = getPlugin();
  if (!plugin?.read) throw new Error('Sharing is unavailable in this runtime');
  const { data } = await plugin.read({ index: file.index });
  const bytes = base64ToBytes(data);
  // Copy into a fresh ArrayBuffer: the view from atob can be backed by a larger
  // buffer, and File takes the bytes, not the view's backing store.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new File([buffer], file.filename, { type: file.mimeType });
};

/** Deletes the share's cache files. Called once the composer owns the bytes. */
export const clearSharedFiles = async (): Promise<void> => {
  await getPlugin()?.clear?.();
};
