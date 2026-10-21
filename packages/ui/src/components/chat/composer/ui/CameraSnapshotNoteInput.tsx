/**
 * The note field for one camera snapshot: typing, or a voice note.
 *
 * Voice uses `useDictation` directly rather than `ComposerDictation`, because
 * that overlay is absolutely positioned to cover the composer it lives in
 * (`.oc-dictation-overlay absolute inset-0`). Here the note has to stay a small
 * row under the photo, so the same engine is driven with its own controls. All
 * the actual capture and transcription is shared - no second audio path.
 */

import React from 'react';

import { DictationWaveform } from '@/components/dictation/DictationWaveform';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useDictation } from '@/hooks/useDictation';
import { useI18n } from '@/lib/i18n';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { cn } from '@/lib/utils';

interface CameraSnapshotNoteInputProps {
  value: string;
  onChange: (note: string) => void;
}

const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
};

export const CameraSnapshotNoteInput: React.FC<CameraSnapshotNoteInputProps> = ({
  value,
  onChange,
}) => {
  const { t } = useI18n();

  const dictation = useDictation({
    onTranscript: (text) => {
      // Land mid-word if the user already typed, matching how the composer
      // appends a dictation to existing text.
      const separator = value && !value.endsWith(' ') ? ' ' : '';
      onChange(`${value}${separator}${text}`);
    },
  });

  const {
    status,
    subscribeLevel,
    duration,
    error,
    startDictation,
    confirmDictation,
    cancelDictation,
    retryFailedDictation,
    discardFailedDictation,
  } = dictation;

  const isRecording = status === 'recording';
  const isTranscribing = status === 'uploading';
  const isFailed = status === 'failed';
  /** Recording or waiting on the server. Both block a fresh dictation. */
  const isBusy = isRecording || isTranscribing;

  // iOS performs on tap for every dictation control.
  const keepKeyboardFocusProps = {
    onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
    onPointerDownCapture: (event: React.PointerEvent) => {
      if (event.pointerType === 'touch') {
        event.preventDefault();
      }
    },
  } as const;

  if (isFailed) {
    return (
      <div className="flex flex-col gap-2">
        <p className="typography-ui-label text-[var(--status-error)]">
          {error ?? t('chat.dictation.failed')}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => void retryFailedDictation()}>
            <Icon name="refresh" className="size-4" />
            {t('chat.dictation.retry')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => discardFailedDictation()}>
            {t('chat.dictation.discard')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5">
        <span className="typography-ui-label text-muted-foreground">
          {t('chat.cameraSnapshots.noteLabel')}
        </span>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t('chat.cameraSnapshots.notePlaceholder')}
          rows={2}
          disabled={isBusy}
          className={cn(
            'w-full resize-none rounded-lg border border-border bg-background px-3 py-2 typography-body outline-none',
            'focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus)]',
            isBusy && 'opacity-60',
          )}
        />
      </label>

      {isTranscribing ? (
        // The server is transcribing. No trigger here on purpose: offering a
        // fresh "start dictation" mid-flight invites a second recording that
        // would clobber the transcript still on its way.
        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
          <Icon name="loader-4" className="size-4 flex-shrink-0 animate-spin text-muted-foreground" />
          <span className="typography-ui-label text-muted-foreground">
            {t('chat.dictation.processing')}
          </span>
        </div>
      ) : isRecording ? (
        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
          <span className="typography-ui-label tabular-nums text-muted-foreground">
            {formatDuration(duration)}
          </span>
          <DictationWaveform subscribeLevel={subscribeLevel} className="h-6 min-w-0 flex-1" />
          <Button
            type="button"
            {...keepKeyboardFocusProps}
            size="sm"
            variant="ghost"
            onClick={() => void cancelDictation()}
            aria-label={t('chat.dictation.cancel')}
          >
            <Icon name="close" className="size-4" />
          </Button>
          <Button
            type="button"
            {...keepKeyboardFocusProps}
            size="sm"
            onClick={() => void confirmDictation()}
            aria-label={t('chat.dictation.insert')}
          >
            <Icon name="check" className="size-4" />
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          {...keepKeyboardFocusProps}
          variant="outline"
          size="sm"
          className="self-start"
          disabled={isBusy || !isDictationCaptureSupported()}
          onClick={() => void startDictation()}
        >
          <Icon name="mic" className="size-4" />
          {t('chat.dictation.start')}
        </Button>
      )}
    </div>
  );
};