import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import {
  clearCapturedPhotos,
  isCameraCaptureAvailable,
  onCameraSessionEnded,
  readCapturedPhoto,
  releaseScreenAwake,
  requestScreenAwake,
  startCameraCapture,
} from './mobileCameraCapture';

// The bridge helper reads window.Capacitor; bun:test runs without a DOM. Module
// scope, not beforeAll: the helper memoises its plugin, and every test here
// shares one installed plugin on purpose.
//
// The globals have to arrive together and from one Window. Installing `window`
// alone makes every DOM feature-detect in the codebase half-convinced and it
// throws: react-dom checks `window.document` and then reads
// `document.documentMode`, and `useConfigStore` takes its localStorage branch on
// `typeof window`. bun:test runs every file in one process, so this file's
// globals leak into any test that renders React alongside it.
const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});

const JPEG_BASE64 = '/9j/4AAQSkZJRg=='; // 16 base64 chars -> 10 bytes
const ONE_BYTE_BASE64 = '/w=='; // 4 base64 chars -> 1 byte

type State = {
  platform: string;
  available: boolean;
  /** Per-index base64 the plugin returns. */
  photos: Record<number, string>;
  /** Every method the bridge called, in order. */
  calls: Array<{ method: string; args?: unknown }>;
  /** The registered session-ended listener, so a test can fire the event. */
  emit?: (payload: { count?: number }) => void;
};

/**
 * One stub, installed once. The helper memoises the registered plugin exactly as
 * it does on a device, so re-installing per test would be ignored after the
 * first; each test resets `state` instead.
 */
let state: State;

const freshState = (): State => ({
  platform: 'android',
  available: true,
  photos: {},
  calls: [],
  emit: undefined,
});

const installPlugin = (): void => {
  const windowWithCapacitor = window as typeof window & { Capacitor?: unknown };
  windowWithCapacitor.Capacitor = {
    getPlatform: () => state.platform,
    registerPlugin: () => ({
      isAvailable: async () => {
        state.calls.push({ method: 'isAvailable' });
        return { available: state.available };
      },
      start: async () => {
        state.calls.push({ method: 'start' });
      },
      clear: async () => {
        state.calls.push({ method: 'clear' });
      },
      read: async ({ index }: { index: number }) => {
        state.calls.push({ method: 'read', args: { index } });
        const data = state.photos[index] ?? JPEG_BASE64;
        return { index, mimeType: 'image/jpeg', byteLength: data.length, data };
      },
      addListener: (event: string, listener: (payload: { count?: number }) => void) => {
        state.calls.push({ method: 'addListener', args: { event } });
        state.emit = listener;
        return {
          // Model the real plugin: removing the handle stops delivery.
          remove: () => {
            state.calls.push({ method: 'removeListener' });
            if (state.emit === listener) state.emit = undefined;
          },
        };
      },
    }),
  };
};

const clearCapacitor = (): void => {
  const windowWithCapacitor = window as typeof window & { Capacitor?: unknown };
  delete windowWithCapacitor.Capacitor;
};

/** Installs a fake Screen Wake Lock, recording every grant it hands out. */
const installWakeLock = (held: Array<{ released: boolean }>): void => {
  Object.assign(globalThis.navigator, {
    wakeLock: {
      request: async () => {
        const sentinel = {
          released: false,
          release: async () => {
            sentinel.released = true;
          },
        };
        held.push(sentinel);
        return sentinel;
      },
    },
  });
};

const clearWakeLock = (): void => {
  Reflect.deleteProperty(globalThis.navigator, 'wakeLock');
};

/** Lets the wake-lock request promise settle. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};



describe('mobileCameraCapture', () => {
  // bun:test has no beforeAll here, and the helper memoises the plugin exactly
  // as it does on a device - so the stub is installed once at module scope and
  // each test resets `state` instead. Android tests share that plugin;
  // non-android tests remove the window so the helper finds none.
  state = freshState();
  installPlugin();

  describe('android', () => {
    test('reports hardware availability', async () => {
      state = freshState();
      expect(await isCameraCaptureAvailable()).toBe(true);
    });

    test('reports unavailable when the device has no camera', async () => {
      state = freshState();
      state.available = false;
      expect(await isCameraCaptureAvailable()).toBe(false);
    });

    test('reads a photo as a File with the requested name and mime type', async () => {
      state = freshState();
      const file = await readCapturedPhoto(1, 'camera-2.jpg');

      expect(file.name).toBe('camera-2.jpg');
      expect(file.type).toBe('image/jpeg');
      expect(file.size).toBe(10);
      expect(state.calls.some((call) => call.method === 'read' && (call.args as { index: number }).index === 1)).toBe(true);
    });

    test('decodes every byte of a one-byte payload', async () => {
      state = freshState();
      state.photos = { 0: ONE_BYTE_BASE64 };
      const file = await readCapturedPhoto(0, 'camera-1.jpg');
      const bytes = new Uint8Array(await file.arrayBuffer());

      expect(bytes.length).toBe(1);
      expect(bytes[0]).toBe(0xff);
    });

    test('decodes distinct payloads per index', async () => {
      state = freshState();
      state.photos = { 0: ONE_BYTE_BASE64, 1: JPEG_BASE64 };
      const first = await readCapturedPhoto(0, 'camera-1.jpg');
      const second = await readCapturedPhoto(1, 'camera-2.jpg');

      expect(first.size).toBe(1);
      expect(second.size).toBe(10);
    });

    test('reports the count as an event when the viewfinder closes', async () => {
      state = freshState();
      const seen: number[] = [];
      await onCameraSessionEnded((count) => seen.push(count));

      state.emit?.({ count: 3 });
      // A cancel carries zero: nothing was kept.
      state.emit?.({ count: 0 });

      expect(seen).toEqual([3, 0]);
    });

    test('defaults a missing count to zero', async () => {
      state = freshState();
      const seen: number[] = [];
      await onCameraSessionEnded((count) => seen.push(count));
      state.emit?.({});
      expect(seen).toEqual([0]);
    });

    test('unsubscribing stops delivery', async () => {
      state = freshState();
      const seen: number[] = [];
      const off = await onCameraSessionEnded((count) => seen.push(count));
      off();
      state.emit?.({ count: 2 });
      expect(seen).toEqual([]);
    });

    test('clearing reaches the plugin', async () => {
      state = freshState();
      await clearCapturedPhotos();
      expect(state.calls.some((call) => call.method === 'clear')).toBe(true);
    });

    test('opening the viewfinder reaches the plugin', async () => {
      state = freshState();
      await startCameraCapture();
      expect(state.calls.some((call) => call.method === 'start')).toBe(true);
    });

    // Last in this group: the platform check is by getPlatform(), so flipping it
    // proves the guard is on the platform and not merely on plugin presence.
    test('reports unavailable off Android even with a registered plugin', async () => {
      state = freshState();
      state.platform = 'ios';
      expect(await isCameraCaptureAvailable()).toBe(false);
    });
  });

  // These run last and leave no window behind: once Capacitor is gone the
  // helper resolves to no plugin for the remainder of the file.
  describe('other surfaces', () => {
    test('reports unavailable with no plugin installed', async () => {
      clearCapacitor();
      expect(await isCameraCaptureAvailable()).toBe(false);
    });

    test('rejects rather than throwing when the viewfinder is unavailable', () => {
      clearCapacitor();
      expect(startCameraCapture()).rejects.toThrow('Camera capture is unavailable');
    });

    test('subscribing without a plugin is a no-op, not an error', async () => {
      clearCapacitor();
      const off = await onCameraSessionEnded(() => {
        throw new Error('should not be called');
      });
      expect(typeof off).toBe('function');
    });

    test('holding the screen awake takes and releases one lock', async () => {
      const held: Array<{ released: boolean }> = [];
      installWakeLock(held);

      requestScreenAwake();
      await flush();

      expect(held.length).toBe(1);
      expect(held[0].released).toBe(false);

      releaseScreenAwake();
      await flush();
      expect(held[0].released).toBe(true);
    });

    test('asking twice does not stack locks', async () => {
      const held: Array<{ released: boolean }> = [];
      installWakeLock(held);

      requestScreenAwake();
      requestScreenAwake();
      await flush();

      expect(held.length).toBe(1);
      releaseScreenAwake();
    });

    test('releasing twice releases only the lock we took', async () => {
      const held: Array<{ released: boolean }> = [];
      installWakeLock(held);

      requestScreenAwake();
      await flush();
      releaseScreenAwake();
      releaseScreenAwake();
      await flush();

      expect(held).toHaveLength(1);
      expect(held[0].released).toBe(true);
    });

    test('a refused lock does not wedge later attempts', async () => {
      // A rejected grant must clear the in-flight flag, or the retry after a
      // denial would be silently swallowed.
      const held: Array<{ released: boolean }> = [];
      let refuse = true;
      Object.assign(globalThis.navigator, {
        wakeLock: {
          request: async () => {
            if (refuse) throw new Error('denied');
            const sentinel = {
              released: false,
              release: async () => {
                sentinel.released = true;
              },
            };
            held.push(sentinel);
            return sentinel;
          },
        },
      });

      requestScreenAwake();
      await flush();
      refuse = false;
      requestScreenAwake();
      await flush();

      expect(held).toHaveLength(1);
      releaseScreenAwake();
    });

    test('a runtime without wake lock support is a no-op', () => {
      clearWakeLock();
      expect(requestScreenAwake()).toBeUndefined();
      expect(releaseScreenAwake()).toBeUndefined();
    });

    test('clearing without a plugin is a no-op, not an error', async () => {
      clearCapacitor();
      // Must not reject: a session with no plugin has nothing to clear.
      expect(await clearCapturedPhotos()).toBeUndefined();
    });
  });
});