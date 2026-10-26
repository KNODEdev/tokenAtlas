#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
nice -n 10 cargo build --locked --release --jobs 2 --manifest-path "$project_root/Cargo.toml"
package_root="$project_root/dist"
mkdir -p "$package_root"
case "$(uname -s)" in
  Darwin)
    app_root="$package_root/tokenAtlas Monitor.app/Contents"
    mkdir -p "$app_root/MacOS" "$app_root/Resources"
    cp "$project_root/target/release/tokenatlas-monitor" "$app_root/MacOS/tokenatlas-monitor"
    cp "$project_root/assets/tokenatlas-monitor.icns" "$app_root/Resources/tokenatlas-monitor.icns"
    cat > "$app_root/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>tokenatlas-monitor</string>
<key>CFBundleIdentifier</key><string>dev.tokenatlas.monitor</string>
<key>CFBundleName</key><string>tokenAtlas Monitor</string>
<key>CFBundleIconFile</key><string>tokenatlas-monitor.icns</string>
<key>CFBundleVersion</key><string>0.1.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
    ;;
  Linux)
    cp "$project_root/target/release/tokenatlas-monitor" "$package_root/tokenatlas-monitor"
    cp "$project_root/assets/tokenatlas-monitor.png" "$package_root/tokenatlas-monitor.png"
    ;;
  *) echo "Use package.ps1 on Windows" >&2; exit 1 ;;
esac
cp "$project_root/README.md" "$package_root/README.md"
cp "$project_root/../../LICENSE" "$package_root/LICENSE.txt"
cp "$project_root/assets/OFL-IBM-Plex-Mono.txt" "$package_root/OFL-IBM-Plex-Mono.txt"
cp "$project_root/assets/OFL-IBM-Plex-Sans.txt" "$package_root/OFL-IBM-Plex-Sans.txt"
printf '%s\n' "$package_root"
