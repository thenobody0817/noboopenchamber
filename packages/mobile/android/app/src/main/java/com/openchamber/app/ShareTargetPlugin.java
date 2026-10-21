package com.openchamber.app;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.core.content.IntentCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Inbound Android share-sheet targets: the app is offered as a share target for
 * text, links, images and files, and the payload becomes composer content.
 *
 * The manifest declares ACTION_SEND / ACTION_SEND_MULTIPLE on MainActivity, and
 * BridgeActivity forwards both the launch intent and every later one here — it
 * calls onNewIntent(getIntent()) once the bridge exists and again for each new
 * intent. Since the activity is `singleTask`, a share into the running app is a
 * new intent rather than a relaunch, so this one hook covers cold start and warm.
 *
 * Stream extras are `content://` URIs whose read grant is tied to this activity,
 * and they are not readable until the WebView has booted. They are copied into
 * the cache directory the moment the intent arrives, so the grant never has to
 * outlive the intent and the bytes are still there when the renderer asks. The
 * web layer then pulls one file at a time through `read`, because every
 * attachment turns into a base64 data URL inside the composer.
 *
 * The payload is assembled here rather than forwarded as raw extras: the web
 * layer consumes a fixed shape, so nothing another app puts in the intent reaches
 * shared code unparsed. The copy runs on the bridge's background task handler
 * because handleOnNewIntent is main-thread.
 */
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {

    private static final String SHARE_DIR = "shared-intents";

    /**
     * Carries the pending share to the web layer. Retained until a listener
     * exists, so a cold launch from the share sheet is not lost behind the
     * connection screen while the renderer is still booting.
     */
    private static final String EVENT_SHARED = "sharedContent";

    /**
     * One shared file is held in memory as base64 while it becomes an
     * attachment, and several of those crossing the bridge in one message is a
     * lot of string. A file over this is reported as skipped rather than
     * truncated: a half-read attachment is worse than none.
     */
    private static final long MAX_FILE_BYTES = 20L * 1024 * 1024;

    /** The copied files of the current share, indexed as the payload reports them. */
    private final List<File> shared = new ArrayList<>();

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null || !isShareIntent(intent)) {
            return;
        }
        // Opening content URIs and writing the cache is disk work, and the intent
        // arrives on the main thread.
        getBridge().execute(() -> publish(intent));
    }

    /** Returns one shared file as base64, by index from the share payload. */
    @PluginMethod
    public void read(PluginCall call) {
        Integer index = call.getInt("index");
        if (index == null || index < 0 || index >= shared.size()) {
            call.reject("No shared file at that index");
            return;
        }
        try {
            call.resolve(new JSObject().put("data", readBase64(shared.get(index))));
        } catch (IOException error) {
            call.reject("Failed to read the shared file", error);
        }
    }

    /** Throws away a share's cache files. Called once the composer owns the bytes. */
    @PluginMethod
    public void clear(PluginCall call) {
        clearSharedFiles();
        call.resolve();
    }

    private static boolean isShareIntent(Intent intent) {
        String action = intent.getAction();
        return Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action);
    }

    /**
     * Copies a share into the cache directory and announces it. A new share
     * replaces an unconsumed one: the composer either took the previous share or
     * the user has moved on, and holding both would only serve stale bytes.
     */
    private void publish(Intent intent) {
        String text = readText(intent);
        List<Uri> uris = readStreamUris(intent);
        clearSharedFiles();

        Set<String> usedNames = new HashSet<>();
        List<JSObject> files = new ArrayList<>();
        List<String> skipped = new ArrayList<>();
        for (Uri uri : uris) {
            String filename = uniqueName(usedNames, displayName(uri, files.size()));
            try {
                File file = copyToCache(uri, filename);
                shared.add(file);
                files.add(new JSObject()
                    .put("index", files.size() - 1)
                    .put("filename", file.getName())
                    .put("mimeType", mimeTypeOf(uri))
                    .put("byteLength", file.length()));
            } catch (FileTooLargeException error) {
                skipped.add(filename);
            } catch (IOException | SecurityException error) {
                skipped.add(filename);
            }
        }

        if (text == null && files.isEmpty()) {
            // Nothing this composer can use — an unsupported file the app does
            // not accept is dropped here rather than announced as an empty share.
            return;
        }

        JSObject payload = new JSObject()
            .put("text", text)
            .put("files", files)
            .put("skipped", skipped);
        notifyListeners(EVENT_SHARED, payload, true);
    }

    /**
     * The shared text, or null. An email forward arrives with only a subject, so
     * that counts as text rather than as an empty share.
     */
    private static String readText(Intent intent) {
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text != null && text.toString().trim().length() > 0) {
            return text.toString();
        }
        CharSequence subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
        if (subject != null && subject.toString().trim().length() > 0) {
            return subject.toString();
        }
        return null;
    }

    /**
     * Every stream the sender attached, in order. ACTION_SEND carries one URI and
     * ACTION_SEND_MULTIPLE a list, but the extras bag holds either shape, and
     * some senders put the payload only on the clip data — so both are read and
     * duplicates dropped rather than attached twice.
     */
    private static List<Uri> readStreamUris(Intent intent) {
        List<Uri> uris = new ArrayList<>();
        Uri single = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
        if (single != null) {
            uris.add(single);
        }
        ArrayList<Uri> multiple = IntentCompat.getParcelableArrayListExtra(
            intent, Intent.EXTRA_STREAM, Uri.class
        );
        if (multiple != null) {
            for (Uri uri : multiple) {
                if (uri != null && !uris.contains(uri)) {
                    uris.add(uri);
                }
            }
        }
        ClipData clip = intent.getClipData();
        if (clip != null) {
            for (int position = 0; position < clip.getItemCount(); position += 1) {
                Uri uri = clip.getItemAt(position).getUri();
                if (uri != null && !uris.contains(uri)) {
                    uris.add(uri);
                }
            }
        }
        return uris;
    }

    private File copyToCache(Uri uri, String filename) throws IOException {
        File directory = new File(getContext().getCacheDir(), SHARE_DIR);
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("Failed to prepare the shared files directory");
        }
        File file = new File(directory, filename);
        ContentResolver resolver = getContext().getContentResolver();
        byte[] buffer = new byte[16 * 1024];
        long total = 0;
        try (InputStream input = resolver.openInputStream(uri)) {
            if (input == null) {
                throw new IOException("The shared file could not be opened");
            }
            try (FileOutputStream output = new FileOutputStream(file)) {
                int read;
                while ((read = input.read(buffer)) != -1) {
                    total += read;
                    if (total > MAX_FILE_BYTES) {
                        //noinspection ResultOfMethodCallIgnored
                        file.delete();
                        throw new FileTooLargeException();
                    }
                    output.write(buffer, 0, read);
                }
            }
        }
        return file;
    }

    /**
     * The name the sender shows for a file. Display names are the only reliable
     * one — a share from a cloud app carries an opaque path — and a provider that
     * refuses the query still leaves the path fallback.
     */
    private String displayName(Uri uri, int index) {
        String name = null;
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (Cursor cursor = getContext().getContentResolver()
                    .query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (column >= 0 && !cursor.isNull(column)) {
                        name = cursor.getString(column);
                    }
                }
            } catch (RuntimeException error) {
                name = null;
            }
        }
        if (name == null || name.trim().isEmpty()) {
            name = uri.getLastPathSegment();
        }
        // Keep only the last path segment, so a crafted name cannot escape the
        // directory it is written to.
        String safeName = name == null ? "" : new File(name).getName().trim();
        return safeName.isEmpty() ? "shared-file-" + (index + 1) : safeName;
    }

    /**
     * Keeps two files of one multi-select share from overwriting each other in the
     * cache directory: both arrive as e.g. `photo.jpg` and the second would
     * silently replace the first.
     */
    private static String uniqueName(Set<String> usedNames, String filename) {
        if (usedNames.add(filename.toLowerCase())) {
            return filename;
        }
        int dot = filename.lastIndexOf('.');
        String stem = dot > 0 ? filename.substring(0, dot) : filename;
        String extension = dot > 0 ? filename.substring(dot) : "";
        for (int attempt = 2; ; attempt += 1) {
            String candidate = stem + "-" + attempt + extension;
            if (usedNames.add(candidate.toLowerCase())) {
                return candidate;
            }
        }
    }

    private String mimeTypeOf(Uri uri) {
        String mimeType = getContext().getContentResolver().getType(uri);
        return mimeType == null ? "application/octet-stream" : mimeType;
    }

    /**
     * One file as base64, streamed rather than held twice: the copy to cache
     * already bounds the size, so the buffer is the only allocation that scales.
     */
    private static String readBase64(File file) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[16 * 1024];
        try (FileInputStream input = new FileInputStream(file)) {
            int read;
            while ((read = input.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
        }
        // No line wrapping: the web layer decodes with atob, which rejects the
        // newlines Base64.DEFAULT would insert every 76 bytes.
        return Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP);
    }

    private void clearSharedFiles() {
        File directory = new File(getContext().getCacheDir(), SHARE_DIR);
        File[] previous = directory.listFiles();
        if (previous != null) {
            for (File entry : previous) {
                //noinspection ResultOfMethodCallIgnored
                entry.delete();
            }
        }
        shared.clear();
    }

    /** A share over the size cap, which is reported to the user rather than truncated. */
    private static class FileTooLargeException extends IOException {
    }
}
