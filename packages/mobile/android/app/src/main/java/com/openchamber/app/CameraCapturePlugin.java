package com.openchamber.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.util.Base64;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraInfoUnavailableException;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.common.util.concurrent.ListenableFuture;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;

/**
 * Multi-shot camera capture for the chat composer's snapshots.
 *
 * A snapshot session is a native viewfinder: CameraX preview, a shutter, and a
 * thumbnail strip, added above the WebView with addContentView. Because the
 * preview is a real native surface rather than a view behind a transparent
 * WebView, nothing in the web layer has to give up its own background or z-order
 * to reveal it.
 *
 * `start` -> `snap` -> ... -> `done` collects JPEG files in the app cache. The web
 * layer then reads them one at a time and owns the per-photo comment step, so the
 * camera never has to stay open while React is busy.
 */
@CapacitorPlugin(
    name = "CameraCapture",
    permissions = { @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }) }
)
public class CameraCapturePlugin extends Plugin {

    private static final String CAPTURE_DIR = "camera-captures";
    private static final int THUMBNAIL_DP = 56;

    /**
     * Fired when the native viewfinder closes, carrying how many photos the
     * session holds (zero when the user cancelled). The user ends a session from
     * native controls, so the web layer is notified rather than asking.
     */
    private static final String EVENT_SESSION_ENDED = "cameraSessionEnded";

    /**
     * Compositor-side attachments live in memory as base64 data URLs, so a full
     * 12MP frame would cost megabytes of string per photo. Match the width the
     * browser-annotation screenshots already use: plenty to read a label or a
     * whiteboard, small enough to take a handful of shots.
     */
    private static final int MAX_OUTPUT_WIDTH = 1600;
    private static final int JPEG_QUALITY = 85;

    /** Debounce, so a double-tap cannot fire two captures. */
    private static final long MIN_CAPTURE_INTERVAL_MS = 400;

    private final List<File> captures = new ArrayList<>();

    private FrameLayout overlay;
    private PreviewView previewView;
    private LinearLayout thumbnailStrip;
    private TextView errorView;
    private ImageCapture imageCapture;
    private Camera camera;
    private ProcessCameraProvider cameraProvider;
    private ListenableFuture<ProcessCameraProvider> providerFuture;
    private OnBackPressedCallback backCallback;
    private long lastCaptureAt = 0L;

    /**
     * Whether to offer the Camera row at all. Reports hardware presence only:
     * permission is requested on the first tap, so an unprompted install still
     * shows the feature.
     */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        call.resolve(new JSObject().put("available", hasCameraHardware()));
    }

    /** Opens the viewfinder, requesting camera permission the first time. */
    @PluginMethod
    public void start(PluginCall call) {
        if (!hasCameraHardware()) {
            call.reject(getContext().getString(R.string.camera_unavailable));
            return;
        }
        if (overlay != null) {
            call.resolve();
            return;
        }
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
            return;
        }
        openViewfinderOnMainThread(call);
    }

    /**
     * Inflates the viewfinder and binds the camera on the main thread.
     *
     * Capacitor dispatches plugin methods on a background thread, and PreviewView
     * asserts on construction that it is on the main one - inflating it directly
     * threw "Not in application's main thread". Everything this method touches
     * (views, the back-press callback, camera binding) is main-thread work, so
     * the whole body hops rather than just the inflation.
     */
    private void openViewfinderOnMainThread(final PluginCall call) {
        getActivity().runOnUiThread(() -> openViewfinder(call));
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject(getContext().getString(R.string.camera_permission_denied));
            return;
        }
        openViewfinderOnMainThread(call);
    }

    /**
     * Takes one photo. Failures go to the viewfinder's error line rather than a
     * rejected call: the shutter is native, so there is no call to reject.
     * Main thread only.
     */
    private void takePhoto() {
        if (imageCapture == null) {
            showError(getContext().getString(R.string.camera_bind_failed));
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastCaptureAt < MIN_CAPTURE_INTERVAL_MS) {
            return;
        }
        lastCaptureAt = now;

        imageCapture.takePicture(
            getContext().getMainExecutor(),
            new ImageCapture.OnImageCapturedCallback() {
                @Override
                public void onCaptureSuccess(@NonNull ImageProxy image) {
                    try {
                        onPhotoCaptured(image);
                    } catch (IOException | OutOfMemoryError error) {
                        showError(getContext().getString(R.string.camera_capture_failed));
                    }
                }

                @Override
                public void onError(@NonNull ImageCaptureException exception) {
                    showError(getContext().getString(R.string.camera_capture_failed));
                }
            }
        );
    }

    /** Throws away a finished session's photos without touching the viewfinder. */
    @PluginMethod
    public void clear(PluginCall call) {
        clearCaptures();
        call.resolve();
    }

    /** Returns one captured photo as base64 JPEG, by index from `count`. */
    @PluginMethod
    public void read(PluginCall call) {
        int index = call.getInt("index", -1);
        if (index < 0 || index >= captures.size()) {
            call.reject("No captured photo at index " + index);
            return;
        }
        File file = captures.get(index);
        try {
            byte[] bytes = readAllBytes(file);
            JSObject payload = new JSObject();
            payload.put("index", index);
            payload.put("mimeType", "image/jpeg");
            payload.put("byteLength", bytes.length);
            payload.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(payload);
        } catch (IOException error) {
            call.reject("Could not read the captured photo", error);
        }
    }

    // --- viewfinder lifecycle ---

    private void openViewfinder(PluginCall call) {
        LayoutInflater inflater = LayoutInflater.from(getContext());
        overlay = (FrameLayout) inflater.inflate(R.layout.camera_capture_view, null);
        getActivity().addContentView(
            overlay,
            new android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
            )
        );

        previewView = overlay.findViewById(R.id.camera_preview);
        thumbnailStrip = overlay.findViewById(R.id.camera_thumbnails);
        errorView = overlay.findViewById(R.id.camera_error);

        // Hold the screen awake while the viewfinder is up. The device sleeps
        // after roughly 30 seconds, which is shorter than a session of framing a
        // shot, and a sleeping screen closes the camera under the user. Tied to
        // the view rather than a window flag, so detaching the overlay in
        // closeViewfinder() releases it with no separate bookkeeping.
        overlay.setKeepScreenOn(true);

        overlay.findViewById(R.id.camera_cancel).setOnClickListener(view -> cancelSession());
        // The viewfinder is the native surface's own state machine: Done and
        // Cancel end it here and report the outcome to the web layer as an
        // event. The web layer must not be the one to close it, or it would
        // have to close a session the user is still using.
        overlay.findViewById(R.id.camera_done).setOnClickListener(view -> endSession());
        overlay.findViewById(R.id.camera_shutter).setOnClickListener(view -> takePhoto());

        // While the overlay is up the WebView has no focus, so the system back
        // button would otherwise fall through to Capacitor's WebView handling.
        // Back ends the session the way Done does: the photos are kept, because
        // backing out of a viewfinder is a "that will do" gesture, not a discard.
        backCallback = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                endSession();
            }
        };
        getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), backCallback);

        View touchLayer = overlay.findViewById(R.id.camera_touch_layer);
        touchLayer.setOnTouchListener((view, event) -> {
            if (event.getAction() == MotionEvent.ACTION_DOWN) {
                focusAt(event.getX(), event.getY());
            }
            return true;
        });

        providerFuture = ProcessCameraProvider.getInstance(getContext());
        Executor main = getContext().getMainExecutor();
        providerFuture.addListener(
            () -> {
                try {
                    bindCamera();
                } catch (Exception error) {
                    showError(getContext().getString(R.string.camera_bind_failed));
                    call.reject(getContext().getString(R.string.camera_bind_failed), error);
                    return;
                }
                call.resolve();
            },
            main
        );
    }

    /**
     * Focuses on a preview tap. CameraX reports camera info and metering support
     * through checked exceptions that mean "not right now" rather than a real
     * failure, so a tap that cannot focus is simply dropped.
     */
    private void focusAt(float x, float y) {
        if (camera == null || previewView == null) {
            return;
        }
        try {
            FocusMeteringAction action =
                new FocusMeteringAction.Builder(previewView.getMeteringPointFactory().createPoint(x, y)).build();
            if (camera.getCameraInfo().isFocusMeteringSupported(action)) {
                camera.getCameraControl().startFocusAndMetering(action);
            }
        } catch (IllegalStateException | IllegalArgumentException ignored) {
            // The camera is closing, or this lens takes no metering input here.
        }
    }

    private void bindCamera() throws ExecutionException, InterruptedException, CameraInfoUnavailableException {
        cameraProvider = providerFuture.get();
        // The WebView stays alive behind the viewfinder, so unbind everything
        // first or a second session would contend with this one.
        cameraProvider.unbindAll();

        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());

        imageCapture = new ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .build();

        // Default to the rear lens so a snapped photo is of the thing in front
        // of you, but fall back to the selfie camera on a front-only device.
        CameraSelector selector = null;
        for (CameraSelector candidate : new CameraSelector[] {
            CameraSelector.DEFAULT_BACK_CAMERA,
            CameraSelector.DEFAULT_FRONT_CAMERA,
        }) {
            if (cameraProvider.hasCamera(candidate)) {
                selector = candidate;
                break;
            }
        }
        if (selector == null) {
            throw new IllegalStateException(getContext().getString(R.string.camera_unavailable));
        }

        camera = cameraProvider.bindToLifecycle(getActivity(), selector, preview, imageCapture);
    }

    private void closeViewfinder() {
        if (backCallback != null) {
            // Disable rather than remove: OnBackPressedDispatcher has no
            // removeCallback, and a disabled callback is dropped from the
            // dispatch chain on the next back press.
            backCallback.setEnabled(false);
            backCallback = null;
        }
        if (cameraProvider != null) {
            cameraProvider.unbindAll();
            cameraProvider = null;
        }
        imageCapture = null;
        camera = null;
        lastCaptureAt = 0L;
        if (overlay != null) {
            overlay.setOnTouchListener(null);
            if (overlay.getParent() instanceof android.view.ViewGroup) {
                ((android.view.ViewGroup) overlay.getParent()).removeView(overlay);
            }
            overlay = null;
        }
        previewView = null;
        thumbnailStrip = null;
        errorView = null;
    }

    /**
     * Done: the user kept their photos, so end the viewfinder and tell the web
     * layer how many it may read. Reported as an event because the user ends the
     * session natively, not through a bridge call.
     */
    private void endSession() {
        int count = captures.size();
        closeViewfinder();
        notifyListeners(EVENT_SESSION_ENDED, new JSObject().put("count", count));
    }

    /** Cancel: discard the run. Reported the same way, with a count of zero. */
    private void cancelSession() {
        closeViewfinder();
        clearCaptures();
        notifyListeners(EVENT_SESSION_ENDED, new JSObject().put("count", 0));
    }

    @Override
    protected void handleOnDestroy() {
        closeViewfinder();
        clearCaptures();
    }

    private void showError(String message) {
        getActivity().runOnUiThread(() -> {
            if (errorView == null) {
                Toast.makeText(getContext(), message, Toast.LENGTH_SHORT).show();
                return;
            }
            errorView.setText(message);
            errorView.setVisibility(View.VISIBLE);
            errorView.postDelayed(() -> errorView.setVisibility(View.GONE), 4000);
        });
    }

    // --- capture handling ---

    private void onPhotoCaptured(ImageProxy image) throws IOException {
        try {
            Bitmap bitmap = toScaledJpeg(image);
            try {
                File directory = new File(getContext().getCacheDir(), CAPTURE_DIR);
                if (!directory.isDirectory() && !directory.mkdirs()) {
                    throw new IOException("Could not prepare the capture directory");
                }
                File file = new File(directory, "capture-" + System.currentTimeMillis() + ".jpg");
                try (FileOutputStream output = new FileOutputStream(file)) {
                    bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, output);
                }
                synchronized (captures) {
                    captures.add(file);
                }
                addThumbnail(file);
            } finally {
                bitmap.recycle();
            }
        } finally {
            image.close();
        }
    }

    /**
     * Converts a captured frame to a JPEG no wider than {@link #MAX_OUTPUT_WIDTH},
     * upscaling nothing: a preview-sized sensor output stays at its own size.
     */
    private Bitmap toScaledJpeg(ImageProxy image) throws IOException {
        Bitmap source = image.toBitmap();
        if (source == null) {
            throw new IOException("Could not decode the captured frame");
        }

        Bitmap output = source;
        try {
            if (source.getWidth() > MAX_OUTPUT_WIDTH) {
                int height = Math.max(1, Math.round((float) source.getHeight() * MAX_OUTPUT_WIDTH / source.getWidth()));
                output = Bitmap.createScaledBitmap(source, MAX_OUTPUT_WIDTH, height, true);
            }
            // YUV_420 frames decode as an opaque bitmap; JPEG has no alpha, but a
            // leftover alpha channel makes some decoders render a black frame.
            if (output.hasAlpha()) {
                Bitmap flattened = Bitmap.createBitmap(output.getWidth(), output.getHeight(), Bitmap.Config.RGB_565);
                new android.graphics.Canvas(flattened).drawBitmap(output, 0, 0, null);
                output = flattened;
            }
            return output;
        } finally {
            if (output != source) {
                source.recycle();
            }
        }
    }

    private void addThumbnail(File file) {
        getActivity().runOnUiThread(() -> {
            if (thumbnailStrip == null) {
                return;
            }
            Bitmap bitmap = BitmapFactory.decodeFile(file.getAbsolutePath());
            if (bitmap == null) {
                return;
            }
            ImageView thumb = new ImageView(getContext());
            float density = getContext().getResources().getDisplayMetrics().density;
            int size = Math.round(THUMBNAIL_DP * density);
            thumb.setLayoutParams(new LinearLayout.LayoutParams(size, size));
            thumb.setScaleType(ImageView.ScaleType.CENTER_CROP);
            thumb.setImageBitmap(bitmap);
            int margin = Math.round(4 * density);
            LinearLayout.LayoutParams params = (LinearLayout.LayoutParams) thumb.getLayoutParams();
            params.setMargins(margin, 0, margin, 0);
            thumb.setLayoutParams(params);
            thumbnailStrip.addView(thumb);
        });
    }

    private void clearCaptures() {
        synchronized (captures) {
            for (File file : captures) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
            captures.clear();
        }
    }

    private boolean hasCameraHardware() {
        return getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY);
    }

    private static byte[] readAllBytes(File file) throws IOException {
        try (FileInputStream input = new FileInputStream(file)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream((int) file.length());
            byte[] buffer = new byte[16384];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }
}