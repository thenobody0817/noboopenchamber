import { describe, expect, test } from 'bun:test';

import { buildCameraSnapshotNotes, type CameraSnapshot } from './cameraSnapshotsState';

const snapshot = (note = '', ordinal = 0): CameraSnapshot => ({
    file: new File([new Uint8Array([1, 2, 3])], `camera-${ordinal + 1}.jpg`, { type: 'image/jpeg' }),
    filename: `camera-${ordinal + 1}.jpg`,
    url: `blob:camera-${ordinal + 1}`,
    note,
    nativeIndex: ordinal,
});

describe('buildCameraSnapshotNotes', () => {
    test('keys each note by the filename the composer assigned', () => {
        const text = buildCameraSnapshotNotes(
            [snapshot('the shelf'), snapshot('the label', 1)],
            ['camera-1.jpg', 'camera-2.jpg'],
        );

        expect(text).toBe('[camera-1.jpg]: the shelf\n[camera-2.jpg]: the label');
    });

    // The composer cites every photo as [filename] itself, so a note is additive.
    test('omits photos with no note', () => {
        const text = buildCameraSnapshotNotes(
            [snapshot(), snapshot('the label', 1)],
            ['camera-1.jpg', 'camera-2.jpg'],
        );

        expect(text).toBe('[camera-2.jpg]: the label');
    });

    test('treats a whitespace-only note as no note', () => {
        expect(buildCameraSnapshotNotes([snapshot('  \n ')], ['camera-1.jpg'])).toBe('');
    });

    test('keys to the assigned name when the composer renamed the file', () => {
        // A draft that already held camera-1.jpg makes the attach dedupe.
        const text = buildCameraSnapshotNotes([snapshot('the shelf')], ['camera-1-2.jpg']);

        expect(text).toBe('[camera-1-2.jpg]: the shelf');
    });

    test('drops a note whose photo did not attach', () => {
        // An empty assigned name means the attachment was refused, so there is
        // no file for the note to refer to.
        const text = buildCameraSnapshotNotes(
            [snapshot('the shelf'), snapshot('the label', 1)],
            ['', 'camera-2.jpg'],
        );

        expect(text).toBe('[camera-2.jpg]: the label');
    });

    test('returns empty text for a session with no notes', () => {
        expect(
            buildCameraSnapshotNotes([snapshot(), snapshot('', 1)], ['camera-1.jpg', 'camera-2.jpg']),
        ).toBe('');
    });

    test('returns empty text when nothing attached', () => {
        expect(buildCameraSnapshotNotes([snapshot('the shelf')], [''])).toBe('');
    });
});