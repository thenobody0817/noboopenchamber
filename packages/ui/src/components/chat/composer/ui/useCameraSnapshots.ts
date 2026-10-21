/**
 * Drives a camera snapshot session from the composer.
 *
 * A session spans two runtimes, and the native one owns its own lifetime: React
 * opens the CameraX viewfinder, the user snaps and ends the session from the
 * viewfinder's own Done button (or hardware back), and the outcome arrives as an
 * event. React then walks the photos one at a time collecting a note, and finally
 * attaches them.
 *
 * Because the user ends the session natively, the hook never closes the
 * viewfinder itself — that would end a session they are still using. Keeping the
 * sequence here means the composer supplies two things and no camera logic:
 * `attachPhotos` (which cites each photo by name, exactly like a paste or drop)
 * and `insertText` (for the notes).
 *
 * State lives in this hook rather than in the store because a session's photos are
 * provisional: any can still be discarded or re-noted before the session ends.
 */

import React from 'react';

import { toast } from 'sonner';

import { useI18n } from '@/lib/i18n';
import { isCameraCaptureAvailable, onCameraSessionEnded, releaseScreenAwake, requestScreenAwake } from '@/lib/mobileCameraCapture';

import {
  buildCameraSnapshotNotes,
  collectCameraPhotos,
  discardCameraSession,
  reopenCameraViewfinder,
  type CameraSnapshot,
} from './cameraSnapshotsState';

/** Stable empty state, so an idle hook holds no new array identity. */
const NO_SNAPSHOTS: CameraSnapshot[] = [];

export interface UseCameraSnapshotsInput {
  /** Whether this surface is the Android app, where the native viewfinder exists. */
  enabled: boolean;
  /**
   * Attaches the photos and cites each by name, returning the filenames the
   * composer assigned. The composer's own path, so drafts, filename collisions and
   * the model-modality warning all behave as they do for a pasted image.
   */
  attachPhotos: (files: File[]) => Promise<string[]>;
  /** Inserts text into the composer, for the notes a session collected. */
  insertText: (text: string) => void;
}

export interface UseCameraSnapshotsResult {
  /** Whether to offer the Camera row at all. */
  available: boolean;
  /** Whether photos are waiting for their notes. */
  active: boolean;
  snapshots: readonly CameraSnapshot[];
  activeIndex: number;
  open: () => void;
  snapAnother: () => void;
  setActiveIndex: (index: number) => void;
  setNote: (index: number, note: string) => void;
  dismiss: () => void;
  finish: () => void;
}

export const useCameraSnapshots = ({
  enabled,
  attachPhotos,
  insertText,
}: UseCameraSnapshotsInput): UseCameraSnapshotsResult => {
  const { t } = useI18n();
  const [available, setAvailable] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const [snapshots, setSnapshots] = React.useState<CameraSnapshot[]>(NO_SNAPSHOTS);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  // Read inside the session-ended listener, which must not re-subscribe (and so
  // must not miss an event) every time a note is typed.
  const collectedRef = React.useRef<CameraSnapshot[]>(NO_SNAPSHOTS);

  // The viewfinder holds the screen awake natively; this covers the comment step
  // that follows it, which the device would otherwise put to sleep mid-sentence.
  React.useEffect(() => {
    if (!enabled) return;
    if (active) requestScreenAwake();
    else releaseScreenAwake();
    return () => releaseScreenAwake();
  }, [enabled, active]);

  // Hardware presence, not permission: an unprompted install still offers the
  // feature, and the viewfinder asks when it is first opened.
  React.useEffect(() => {
    if (!enabled) {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    void isCameraCaptureAvailable().then((result) => {
      if (!cancelled) setAvailable(result);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  React.useEffect(() => {
    if (!enabled) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    void onCameraSessionEnded((count) => {
      void (async () => {
        const previous = collectedRef.current;
        try {
          if (count === 0) {
            // Cancelled natively, or nothing was snapped.
            await discardCameraSession(previous);
            setSnapshots(NO_SNAPSHOTS);
            setActive(false);
            setActiveIndex(-1);
            return;
          }
          // `count` is the native session's running total, so read only what is
          // new: a second round's photos follow the ones already collected.
          const added = await collectCameraPhotos(count, previous.length);
          const all = [...previous, ...added];
          collectedRef.current = all;
          setSnapshots(all);
          setActiveIndex(previous.length);
          setActive(true);
        } catch (error) {
          console.error('Camera capture failed', error);
          toast.error(t('chat.chatInput.toast.attachFileFailed'));
        }
      })();
    }).then((off) => {
      if (cancelled) off();
      else unsubscribe = off;
    });

    // Unmounting mid-session (a session switch, a closed surface) would
    // otherwise strand every preview's object URL and the native cache files.
    return () => {
      cancelled = true;
      unsubscribe?.();
      const stranded = collectedRef.current;
      if (stranded.length > 0) {
        collectedRef.current = NO_SNAPSHOTS;
        void discardCameraSession(stranded);
      }
    };
  }, [enabled, t]);

  const open = React.useCallback(() => {
    collectedRef.current = NO_SNAPSHOTS;
    setSnapshots(NO_SNAPSHOTS);
    setActiveIndex(-1);
    setActive(false);
    void reopenCameraViewfinder().catch((error: unknown) => {
      console.error('Camera capture failed', error);
      toast.error(t('chat.chatInput.toast.attachFileFailed'));
    });
  }, [t]);

  const snapAnother = React.useCallback(() => {
    void reopenCameraViewfinder().catch((error: unknown) => {
      console.error('Camera capture failed', error);
    });
  }, []);

  const setNote = React.useCallback((index: number, note: string) => {
    setSnapshots((previous) => {
      const next = previous.map((snapshot, position) => (
        position === index ? { ...snapshot, note } : snapshot
      ));
      collectedRef.current = next;
      return next;
    });
  }, []);

  const dismiss = React.useCallback(() => {
    const pending = collectedRef.current;
    collectedRef.current = NO_SNAPSHOTS;
    setSnapshots(NO_SNAPSHOTS);
    setActive(false);
    setActiveIndex(-1);
    void discardCameraSession(pending);
  }, []);

  const finish = React.useCallback(() => {
    const pending = collectedRef.current;
    collectedRef.current = NO_SNAPSHOTS;
    setSnapshots(NO_SNAPSHOTS);
    setActive(false);
    setActiveIndex(-1);

    if (pending.length === 0) return;

    // Sequential: each attachment becomes a base64 data URL in the composer, so
    // a parallel batch would hold several of those at once. `attachPhotos`
    // returns the names it actually assigned, so the notes key to those.
    void (async () => {
      const assigned: string[] = [];
      for (const snapshot of pending) {
        const names = await attachPhotos([snapshot.file]);
        if (names.length > 0) assigned.push(names[0]);
        else assigned.push('');
      }
      const text = buildCameraSnapshotNotes(pending, assigned);
      if (text) insertText(text);
      // The composer owns the bytes now; drop the native session's cache.
      await discardCameraSession(pending);
    })().catch((error: unknown) => {
      console.error('Camera attach failed', error);
      void discardCameraSession(pending);
    });
  }, [attachPhotos, insertText]);

  return {
    available: enabled && available,
    active,
    snapshots,
    activeIndex,
    open,
    snapAnother,
    setActiveIndex,
    setNote,
    dismiss,
    finish,
  };
};