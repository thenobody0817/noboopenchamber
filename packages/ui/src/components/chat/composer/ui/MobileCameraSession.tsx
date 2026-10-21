/**
 * The comment half of a camera snapshot session.
 *
 * The viewfinder itself is native (see CameraCapturePlugin): React never draws a
 * camera preview. This covers what happens once the viewfinder closes - one photo
 * at a time, each with an optional voice or text note, then either another round
 * of snapping or the end of the session.
 *
 * Kept out of the composer for the same reason the dictation overlay is: the
 * composer should not grow logic belonging to one mode. This renders in its own
 * portal and hands the finished session back through `onFinish`.
 */

import React from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { registerBackLayer } from '@/lib/mobileBackLayers';
import { cn } from '@/lib/utils';

import type { CameraSnapshot } from './cameraSnapshotsState';
import { CameraSnapshotNoteInput } from './CameraSnapshotNoteInput';

interface MobileCameraSessionProps {
  open: boolean;
  /** Photos captured so far this session, oldest first. */
  snapshots: readonly CameraSnapshot[];
  /** Index of the photo being commented on. */
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onNoteChange: (index: number, note: string) => void;
  /** Reopen the native viewfinder for another photo. */
  onSnapAnother: () => void;
  onFinish: () => void;
  onDismiss: () => void;
}

export const MobileCameraSession: React.FC<MobileCameraSessionProps> = ({
  open,
  snapshots,
  activeIndex,
  onActiveIndexChange,
  onNoteChange,
  onSnapAnother,
  onFinish,
  onDismiss,
}) => {
  const { t } = useI18n();
  const active = snapshots[activeIndex];

  // The sheet owns the screen while it is up, so it has to answer the hardware
  // back button itself or back would fall through to the chat behind it.
  React.useEffect(() => {
    if (!open) return;
    return registerBackLayer(onDismiss);
  }, [open, onDismiss]);

  if (!open || !active) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('chat.cameraSnapshots.title')}
      className="oc-keyboard-inset-surface fixed inset-0 z-[1000] flex flex-col bg-background text-foreground"
    >
      <header className="flex items-center gap-2 px-4 pb-2 pt-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+12px)]">
        <Icon name="camera" className="size-5 flex-shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate typography-ui-label">
          {t('chat.cameraSnapshots.title')}
        </h2>
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          {t('chat.cameraSnapshots.discard')}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
        {/* A captured snapshot, not a live preview. */}
        <img
          src={active.url}
          alt={active.filename}
          className="max-h-full max-w-full object-contain"
        />
      </div>

      <div className="flex flex-col gap-3 px-4 pb-[calc(var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))+16px)] pt-3">
        {snapshots.length > 1 ? (
          <div className="flex items-center gap-2 overflow-x-auto">
            {snapshots.map((snapshot, index) => (
              <button
                key={snapshot.filename}
                type="button"
                onClick={() => onActiveIndexChange(index)}
                className={cn(
                  'h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg border-2',
                  index === activeIndex ? 'border-primary' : 'border-transparent opacity-60',
                )}
                aria-label={t('chat.cameraSnapshots.photoAria', { index: index + 1 })}
                aria-current={index === activeIndex}
              >
                <img src={snapshot.url} alt="" className="size-full object-cover" />
              </button>
            ))}
          </div>
        ) : null}

        <CameraSnapshotNoteInput
          value={active.note}
          onChange={(note) => onNoteChange(activeIndex, note)}
        />

        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={onSnapAnother}>
            <Icon name="camera" className="size-4" />
            {t('chat.cameraSnapshots.snapAnother')}
          </Button>
          <Button type="button" className="flex-1" onClick={onFinish}>
            <Icon name="send-plane-2" className="size-4" />
            {t('chat.cameraSnapshots.attach')}
            {snapshots.length > 1 ? ` (${snapshots.length})` : ''}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
};