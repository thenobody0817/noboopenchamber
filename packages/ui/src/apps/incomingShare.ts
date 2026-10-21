import React from 'react';

import { toast } from '@/components/ui';
import { buildAttachmentCitationText } from '@/components/chat/attachmentCitations';
import { buildImagePasteInsertion } from '@/components/chat/composer/text';
import { useI18n } from '@/lib/i18n';
import {
  isShareTargetAvailable,
  onSharedContent,
  readSharedFile,
  clearSharedFiles,
  type SharedContent,
} from '@/lib/nativeShareTarget';
import { isCapacitorApp } from '@/lib/platform';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Inbound Android shares: the layer that turns a share-sheet intent into
 * composer content.
 *
 * A share can arrive long before there is anything to put it in — a cold launch
 * from the share sheet lands on the connection screen, and the native plugin
 * keeps the payload until the renderer subscribes. So the share is stashed here
 * and applied only once the app is ready, the same discipline
 * `deepLinkNavigation` applies to notification taps and `openchamber://` URLs.
 *
 * Readiness has to include the cold-launch session restore. That restore
 * replaces whichever session was open last time, so a share already typed into
 * the auto-opened draft would be discarded by it.
 *
 * The share fills the composer and never sends: any Android app can fire an
 * `ACTION_SEND` at us, and the user pressing send is what makes it real.
 */

let ready = false;
let applying = false;
let pending: SharedContent | null = null;

interface AppliedShare {
  /** Filenames the composer actually took, in attachment order. */
  attached: string[];
  /** Shared files the composer refused, e.g. a type it does not accept. */
  rejected: number;
}

const applyShare = async (share: SharedContent): Promise<AppliedShare> => {
  const store = useSessionUIStore.getState();
  // A share into the sessions list needs somewhere to land. The draft is the same
  // target the welcome composer already uses, so opening one is all it takes.
  if (!store.currentSessionId && !store.newSessionDraft.open) {
    store.openNewSessionDraft({ automatic: true });
  }

  const before = new Set(useInputStore.getState().attachedFiles.map((file) => file.id));
  let rejected = 0;

  // Sequential: every attachment becomes a base64 data URL in the composer, so a
  // parallel read would hold several megabytes of string at once. A file that
  // cannot be read or is a type the composer does not accept is counted and
  // skipped rather than abandoned, so the rest of the share still lands.
  for (const file of share.files) {
    const attached = await readSharedFile(file)
      .then((read) => useInputStore.getState().addAttachedFile(read))
      .catch(() => {
        console.error('Shared file attach failed', file.filename);
        return false;
      });
    if (!attached) rejected += 1;
  }

  // The names come from the composer, not from the share: the composer renames on
  // collision, so citing the incoming name would name a file the model never sees.
  const attached = useInputStore
    .getState()
    .attachedFiles.filter((file) => !before.has(file.id))
    .map((file) => file.filename);

  const citation = attached.length > 0 ? buildAttachmentCitationText(attached) : '';
  const composed = buildImagePasteInsertion(share.text?.trim() ?? '', citation);
  if (composed) {
    // Appended rather than replacing: a share into a half-written prompt should
    // not throw away what is already there.
    useInputStore.getState().setPendingInputText(composed, 'append');
  }

  // The composer holds the bytes now, so the cache copy has done its job.
  await clearSharedFiles().catch(() => undefined);

  return { attached, rejected };
};

/**
 * Applies at most one share at a time. Two concurrent applies would interleave
 * into the same composer — and since the text goes through a single pending slot,
 * the second would overwrite the first's — so a share that arrives mid-apply waits
 * for it to finish rather than racing it.
 */
const flush = (report: (applied: AppliedShare) => void): void => {
  if (!ready || applying || !pending) return;
  const share = pending;
  // Dropped before applying, so a share arriving mid-apply is not lost.
  pending = null;
  applying = true;
  void applyShare(share)
    .then(report)
    .catch(() => {
      console.error('Shared content could not be applied');
    })
    .finally(() => {
      applying = false;
      flush(report);
    });
};

/**
 * Subscribes to inbound shares and applies them as soon as the app can host them.
 *
 * Registered unconditionally, like the deep-link source, so a share that launched
 * the app survives the connection flow. A newer share replaces an unapplied one:
 * the latest intent is what the user meant to hand over, and the native plugin
 * only keeps one share's files anyway.
 */
export const useIncomingShareSource = (options: { ready: boolean }): void => {
  const { ready: isReady } = options;
  const { t } = useI18n();

  const report = React.useCallback((applied: AppliedShare) => {
    if (applied.rejected > 0) toast.error(t('chat.chatInput.toast.attachFileFailed'));
  }, [t]);

  React.useEffect(() => {
    ready = isReady;
    flush(report);
  }, [isReady, report]);

  React.useEffect(() => {
    if (!isCapacitorApp() || !isShareTargetAvailable()) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void onSharedContent((share) => {
      // Announced on arrival rather than after the attach: an over-cap file was
      // already dropped natively, whatever the composer does with the rest.
      if (share.skipped.length === 1) {
        toast.error(t('chat.incomingShare.toast.skippedOne'));
      } else if (share.skipped.length > 1) {
        toast.error(t('chat.incomingShare.toast.skippedMany', { count: share.skipped.length }));
      }
      pending = share;
      flush(report);
    })
      .then((off) => {
        if (disposed) off();
        else unsubscribe = off;
      })
      .catch(() => {
        console.error('Share target could not be subscribed');
      });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [t, report]);
};
