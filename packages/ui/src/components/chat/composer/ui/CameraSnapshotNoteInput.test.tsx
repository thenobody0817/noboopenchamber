/**
 * The dictation states of a camera snapshot note.
 *
 * The regression this pins down: `useDictation` has four states, and an input
 * that only branches on `recording` and `failed` falls through to its idle UI
 * while the server is transcribing — offering a fresh "start dictation" button
 * in the middle of a recording whose transcript is still on its way. A second
 * dictation started there would clobber the first.
 */

import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

type DictationStatus = 'idle' | 'recording' | 'uploading' | 'failed';

/** Mutable so each test can drive the mocked hook into a chosen state. */
const dictationState: { status: DictationStatus } = { status: 'idle' };

const noop = async () => undefined;

mock.module('@/hooks/useDictation', () => ({
  useDictation: () => ({
    status: dictationState.status,
    partialTranscript: '',
    isRecording: dictationState.status === 'recording',
    isProcessing: dictationState.status === 'uploading',
    error: null,
    errorReason: null,
    duration: 0,
    subscribeLevel: () => () => {},
    startDictation: noop,
    confirmDictation: noop,
    cancelDictation: noop,
    retryFailedDictation: noop,
    acceptPartialTranscript: () => null,
    discardFailedDictation: noop,
  }),
}));

mock.module('@/components/dictation/DictationWaveform', () => ({
  DictationWaveform: () => <div data-waveform="true" />,
}));

mock.module('@/lib/dictation/use-dictation-audio-source', () => ({
  isDictationCaptureSupported: () => true,
}));

const { CameraSnapshotNoteInput } = await import('./CameraSnapshotNoteInput');

const render = (): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <CameraSnapshotNoteInput value="" onChange={() => {}} />
    </I18nProvider>,
  );

const START_LABEL = 'Start dictation';
const TRANSCRIBING_LABEL = 'Transcribing';

describe('CameraSnapshotNoteInput', () => {
  test('offers dictation when idle', () => {
    dictationState.status = 'idle';
    expect(render()).toContain(START_LABEL);
  });

  test('offers confirm and cancel while recording, not a fresh dictation', () => {
    dictationState.status = 'recording';
    const markup = render();

    expect(markup).toContain('Insert transcript');
    expect(markup).not.toContain(START_LABEL);
    expect(markup).toContain('data-waveform="true"');
  });

  test('shows transcribing and hides the dictation trigger while uploading', () => {
    dictationState.status = 'uploading';
    const markup = render();

    expect(markup).toContain(TRANSCRIBING_LABEL);
    // The bug: a trigger here invites a second recording mid-transcription.
    expect(markup).not.toContain(START_LABEL);
    // Nothing to confirm or cancel yet either — the audio is already sent.
    expect(markup).not.toContain('Insert transcript');
    expect(markup).not.toContain('Discard dictation');
  });

  test('locks the note field while recording or transcribing', () => {
    dictationState.status = 'recording';
    expect(render()).toContain('disabled=""');

    dictationState.status = 'uploading';
    expect(render()).toContain('disabled=""');

    dictationState.status = 'idle';
    expect(render()).not.toContain('disabled=""');
  });

  test('offers a retry instead of a fresh dictation after a failure', () => {
    dictationState.status = 'failed';
    const markup = render();

    expect(markup).toContain('Retry transcription');
    expect(markup).not.toContain(START_LABEL);
    // Recoverable, so the note stays editable.
    expect(markup).not.toContain('disabled=""');
  });
});