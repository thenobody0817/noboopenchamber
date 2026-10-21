/**
 * Camera snapshots: the web half of the native CameraX viewfinder.
 *
 * `CameraCapturePlugin` (Android) owns preview, shutter and thumbnails as a real
 * native surface added above the WebView, so nothing here has to make the web
 * layer transparent to reveal the camera. A session is:
 *
 *   start -> snap* -> done -> read(0..n-1) -> clear
 *
 * `done` closes the viewfinder and returns how many photos are waiting, so the
 * React comment step can run while the bytes transfer over the bridge. Photos
 * are read one at a time rather than in one batch: attachments are held in
 * memory as base64 data URLs, and several of those in a single bridge message
 * is a lot of string to move at once.
 *
 * Shaped like nativeFileShare.ts, the other app-local bridge caller.
 */

type CameraCapturePhoto = {
  index: number;
  mimeType: string;
  byteLength: number;
  data: string;
};

type CameraCaptureSessionEnded = { count?: number };

type CameraCaptureListenerHandle = { remove: () => Promise<void> | void };

type CameraCapturePlugin = {
  isAvailable?: () => Promise<{ available?: boolean }>;
  start?: () => Promise<void>;
  read?: (options: { index: number }) => Promise<CameraCapturePhoto>;
  clear?: () => Promise<void>;
  addListener?: (
    event: 'cameraSessionEnded',
    listener: (payload: CameraCaptureSessionEnded) => void,
  ) => Promise<CameraCaptureListenerHandle> | CameraCaptureListenerHandle;
};

type CapacitorGlobal = {
  getPlatform?: () => string;
  registerPlugin?: (name: string) => CameraCapturePlugin;
};

const getCapacitor = (): CapacitorGlobal | undefined =>
  (window as typeof window & { Capacitor?: CapacitorGlobal }).Capacitor;

/**
 * The Android plugin. Returns null on every other surface, including the iOS app
 * until it grows a native viewfinder of its own.
 */
const getPlugin = (): CameraCapturePlugin | null => {
  if (typeof window === 'undefined') return null;
  const capacitor = getCapacitor();
  if (capacitor?.getPlatform?.() !== 'android' || !capacitor.registerPlugin) {
    return null;
  }
  // registerPlugin warns and hands back the old proxy when called twice.
  let plugin = androidPlugin;
  if (!plugin) {
    plugin = capacitor.registerPlugin('CameraCapture');
    androidPlugin = plugin;
  }
  return plugin;
};

let androidPlugin: CameraCapturePlugin | null = null;

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/** Whether to offer the Camera row. Hardware only: permission is asked on first use. */
export const isCameraCaptureAvailable = async (): Promise<boolean> => {
  const plugin = getPlugin();
  if (!plugin?.isAvailable) return false;
  try {
    return (await plugin.isAvailable()).available === true;
  } catch {
    return false;
  }
};

/** Opens the native viewfinder, prompting for camera permission if needed. */
export const startCameraCapture = async (): Promise<void> => {
  const plugin = getPlugin();
  if (!plugin?.start) throw new Error('Camera capture is unavailable in this runtime');
  await plugin.start();
};

/**
 * Subscribes to the viewfinder closing. The user ends a session from the
 * native Done button, Cancel, or hardware back, so the outcome arrives as an
 * event rather than a return value. Resolves to an unsubscribe function.
 */
export const onCameraSessionEnded = async (
  listener: (count: number) => void,
): Promise<() => void> => {
  const plugin = getPlugin();
  if (!plugin?.addListener) return () => {};
  const handle = await plugin.addListener('cameraSessionEnded', (payload) => {
    listener(payload.count ?? 0);
  });
  return () => {
    void handle.remove();
  };
};

/**
 * Fetches one captured photo as a `File`, ready for
 * `useInputStore.addAttachedFile`. Sequential rather than parallel so a
 * multi-photo session never has several megabytes of base64 in flight at once.
 */
export const readCapturedPhoto = async (
  index: number,
  filename: string,
): Promise<File> => {
  const plugin = getPlugin();
  if (!plugin?.read) throw new Error('Camera capture is unavailable in this runtime');
  const photo = await plugin.read({ index });
  const bytes = base64ToBytes(photo.data);
  // Copy into a fresh ArrayBuffer: the view from atob can be backed by a
  // larger buffer, and Blob takes the bytes, not the view's backing store.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new File([buffer], filename, { type: photo.mimeType || 'image/jpeg' });
};

/** Deletes the session's photos. Called once they are in the composer. */
export const clearCapturedPhotos = async (): Promise<void> => {
  await getPlugin()?.clear?.();
};

/*
 * Screen wake lock, for the half of a session the native viewfinder cannot cover.
 *
 * The plugin holds the screen awake while the viewfinder is up, but once the user
 * hits Done the WebView is back in charge and the comment step faces the same
 * 30-second sleep that would end the session mid-sentence. Unsupported elsewhere,
 * so this is a no-op off Android.
 */

type WakeLockSentinel = { release: () => Promise<void> };

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> };
};

let wanted = false;
let sentinel: WakeLockSentinel | null = null;
/** A grant is async, so two calls in one tick would otherwise both fire. */
let requesting = false;
let listenerInstalled = false;

const requestOnce = (): void => {
  if (typeof navigator === 'undefined') return;
  const nav = navigator as NavigatorWithWakeLock;
  if (!nav.wakeLock?.request || sentinel || requesting) return;
  requesting = true;
  void nav.wakeLock
    .request('screen')
    .then((granted) => {
      // A grant that lands after we stopped wanting it must not stick.
      if (!wanted) {
        void granted.release();
        return;
      }
      sentinel = granted;
    })
    .catch(() => {})
    .finally(() => {
      requesting = false;
    });
};

/** Holds the screen awake until `releaseScreenAwake`. Safe to call repeatedly. */
export const requestScreenAwake = (): void => {
  if (typeof navigator === 'undefined') return;
  if (!(navigator as NavigatorWithWakeLock).wakeLock?.request) return;
  wanted = true;
  requestOnce();

  // The system drops the lock whenever the page is hidden, so take it again on
  // the way back. Registered once; `wanted` decides whether it is still due.
  if (typeof document !== 'undefined' && !listenerInstalled) {
    listenerInstalled = true;
    document.addEventListener('visibilitychange', () => {
      if (!wanted || document.visibilityState !== 'visible') return;
      sentinel = null;
      requestOnce();
    });
  }
};

export const releaseScreenAwake = (): void => {
  wanted = false;
  const held = sentinel;
  sentinel = null;
  void held?.release().catch(() => {});
};