#!/usr/bin/env bash
#
# Install noboopenchamber on Linux (built and tested on Arch/Omarchy).
#
#   curl -fsSL https://raw.githubusercontent.com/thenobody0817/noboopenchamber/nobo/scripts/install-nobo.sh | bash
#
# Downloads the latest AppImage from this repository, installs it to
# ~/Applications and registers a desktop entry. The app updates itself from the
# same repository afterwards, so this only has to run once.
#
# Every step is idempotent: re-running replaces the AppImage in place.

set -euo pipefail

REPO="thenobody0817/noboopenchamber"
APP_NAME="noboopenchamber"
INSTALL_DIR="${NOBO_INSTALL_DIR:-$HOME/Applications}"
APPIMAGE_PATH="$INSTALL_DIR/$APP_NAME.AppImage"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"

info() { printf '\033[0;34minfo\033[0m  %s\n' "$1"; }
warn() { printf '\033[0;33mwarn\033[0m  %s\n' "$1"; }
error() { printf '\033[0;31merror\033[0m  %s\n' "$1" >&2; }

for tool in curl; do
  command -v "$tool" >/dev/null 2>&1 || { error "$tool is required"; exit 1; }
done

# --- what are we running on -------------------------------------------------

case "$(uname -m)" in
  x86_64|amd64) asset_arch="x86_64" ;;
  aarch64|arm64) asset_arch="arm64" ;;
  *) error "unsupported architecture: $(uname -m)"; exit 1 ;;
esac

# --- fetch the newest release ----------------------------------------------

info "Looking up the latest release of $REPO..."
release_json="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")" || {
  error "could not read the release list (is the repository public and has a release?)"
  exit 1
}

asset_url="$(printf '%s' "$release_json" \
  | grep -o "\"browser_download_url\": *\"[^\"]*-linux-$asset_arch\.AppImage\"" \
  | head -1 \
  | sed 's/.*: *"//; s/"$//')"

if [ -z "$asset_url" ]; then
  error "the latest release has no linux-$asset_arch AppImage"
  exit 1
fi

info "Downloading $(basename "$asset_url")"
mkdir -p "$INSTALL_DIR"
tmp_path="$APPIMAGE_PATH.download"
curl -fL --progress-bar "$asset_url" -o "$tmp_path"
chmod +x "$tmp_path"
mv -f "$tmp_path" "$APPIMAGE_PATH"

# --- AppImage prerequisites -------------------------------------------------

if [ -f /etc/arch-release ]; then
  if ! pacman -Qq fuse2 >/dev/null 2>&1 && ! pacman -Qq libfuse2 >/dev/null 2>&1; then
    warn "AppImages need FUSE 2, which is not installed."
    if [ -t 0 ]; then
      read -r -p "Install fuse2 now with pacman? [Y/n] " reply
      case "${reply:-Y}" in
        [Yy]*) sudo pacman -S --needed fuse2 ;;
        *) warn "skipped; the app will still start with APPIMAGE_EXTRACT_AND_RUN=1" ;;
      esac
    else
      warn "install it with: sudo pacman -S fuse2"
    fi
  fi
fi

# --- icon -------------------------------------------------------------------

if extract_dir="$(mktemp -d)" && (cd "$extract_dir" && "$APPIMAGE_PATH" --appimage-extract '*.svg' >/dev/null 2>&1); then
  icon_source="$(find "$extract_dir/squashfs-root" -maxdepth 1 -name '*.svg' -print -quit 2>/dev/null || true)"
  if [ -n "$icon_source" ]; then
    mkdir -p "$ICON_DIR"
    cp "$icon_source" "$ICON_DIR/$APP_NAME.svg"
  fi
else
  warn "could not extract an icon; the desktop entry keeps the default"
fi
[ -n "${extract_dir:-}" ] && rm -rf "$extract_dir"

# --- desktop entry ----------------------------------------------------------

mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/$APP_NAME.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=Fork of OpenChamber — desktop runtime for OpenCode
Exec=$APPIMAGE_PATH --no-sandbox %U
Terminal=false
Icon=$APP_NAME
Categories=Development;
StartupWMClass=$APP_NAME
DESKTOP

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

info "Installed to $APPIMAGE_PATH"
cat <<EOF

  Start it from your launcher, or run:

    $APPIMAGE_PATH

  The app updates itself from $REPO, so run this script again only
  if you want to force a fresh copy.
EOF
