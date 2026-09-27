# plugin-link justfile

# Default recipe: start the dev server
default:
    bun run dev

# Start Tauri desktop dev (wraps Vite dev server in a native window)
dev-tauri:
    bun run tauri:dev

# Build Tauri desktop app bundle (.app / .exe / .deb) for the current platform
build-tauri:
    bun run tauri:build

# Build macOS Apple Silicon installer (.app + .dmg)
# Prerequisites: brew install create-dmg
# Output: src-tauri/target/aarch64-apple-darwin/release/bundle/
build-macos-silicon:
    rustup target add aarch64-apple-darwin
    bun run tauri:build -- --target aarch64-apple-darwin
