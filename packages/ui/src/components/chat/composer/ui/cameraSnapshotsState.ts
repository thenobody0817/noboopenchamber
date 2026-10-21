/**
 * State for a camera snapshot session, kept out of the composer.
 *
 * A session spans two runtimes: a native CameraX viewfinder (Android) and a
 * React comment step. Photos therefore live here rather than in the composer's
 * attachment store until the session ends, because each one can still be
 * discarded, re-noted, or followed by another snap.
 *
 * The bytes have to exist either way (the composer attaches `File`s), but an
 * object URL keeps the preview strip from holding a second multi-megabyte
 * base64 string per photo.
 */

import { clearCapturedPhotos, readCapturedPhoto, startCameraCapture } from '@/lib/mobileCameraCapture';

export interface CameraSnapshot {
  /** The underlying JPEG, ready for `addAttachedFile`. */
  file: File;
  /** Proposed name, keyed to the photo's position in the session. */
  filename: string;
  /** Object URL for display; revoked when the session is attached or discarded. */
  url: string;
  note: string;
  /** Index this photo occupies in the native session, so a later read lines up. */
  nativeIndex: number;
}

/**
 * Named by position in the session. The composer de-duplicates filenames on
 * attach, so re-attaching the same set still works.
 */
const snapshotFilename = (ordinal: number): string => `camera-${ordinal + 1}.jpg`;

/**
 * Reads photos the native session captured, in the order they were taken.
 *
 * `startIndex` matters on a second snap round: the native session keeps every
 * photo until it is cleared, so the count it reports on `cameraSessionEnded` is
 * the running total rather than the number just taken. Reading from `startIndex`
 * picks up only the new ones.
 */
export const collectCameraPhotos = async (
  count: number,
  startIndex = 0,
): Promise<CameraSnapshot[]> => {
  const snapshots: CameraSnapshot[] = [];
  for (let index = startIndex; index < count; index += 1) {
    const filename = snapshotFilename(index);
    const file = await readCapturedPhoto(index, filename);
    snapshots.push({
      file,
      filename,
      url: URL.createObjectURL(file),
      note: '',
      nativeIndex: index,
    });
  }
  return snapshots;
};

/** Drops a session's photos and releases the previews. The viewfinder is already closed. */
export const discardCameraSession = async (snapshots: readonly CameraSnapshot[]): Promise<void> => {
  await clearCapturedPhotos().catch(() => {});
  releaseCameraSnapshots(snapshots);
};

const releaseCameraSnapshots = (snapshots: readonly CameraSnapshot[]): void => {
  for (const snapshot of snapshots) URL.revokeObjectURL(snapshot.url);
};

/**
 * Opens the native viewfinder. Resolves as soon as it is on screen; the session
 * ends later, from the viewfinder's own controls, via `onCameraSessionEnded`.
 */
export const reopenCameraViewfinder = async (): Promise<void> => {
  await startCameraCapture();
};

/**
 * Builds the note text for a finished session.
 *
 * Keyed by the filename the composer actually assigned, so a collision (a draft
 * that already held `camera-1.jpg`) reads `[camera-1-2.jpg]: the label` instead
 * of pointing at a file that was never attached. Photos with no note contribute
 * nothing: they are already cited as `[filename]` by the composer's own attach
 * path.
 */
export const buildCameraSnapshotNotes = (
  snapshots: readonly CameraSnapshot[],
  assignedFilenames: readonly string[],
): string => {
  const lines: string[] = [];
  for (const [index, snapshot] of snapshots.entries()) {
    const note = snapshot.note.trim();
    const filename = assignedFilenames[index];
    // No assigned name means that photo did not attach, so there is nothing
    // for a note about it to refer to.
    if (!note || !filename) continue;
    lines.push(`[${filename}]: ${note}`);
  }
  return lines.join('\n');
};