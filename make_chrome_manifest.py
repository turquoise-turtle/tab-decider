#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""Generate a Chrome-flavored manifest.json from the Firefox original.

Firefox MV3 declares a background *event page* as `background.scripts: [...]`
(an array). Chrome MV3 dropped that in favor of a single, mandatory
`background.service_worker` string -- there's no array form. That's the one
piece of manifest.json Firefox and Chrome can't both read.

The output also declares `minimum_chrome_version`. Chrome 148 shipped a
native, promise-based `browser` namespace matching Firefox's (Chrome's own
recommended way to drop a polyfill dependency: see
https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace),
so nothing else in this manifest or in background.js/decider.js needs to
change for Chrome -- just a floor on which Chrome this build actually runs on.

The Firefox original is kept untouched as manifest.json.bak; manifest.json
becomes the Chrome-compatible copy. Safe to run more than once: if
manifest.json is currently Firefox-shaped (the normal resting state between
conversions -- you edit it directly, bump the version, add an icon, whatever),
that's treated as the fresh source and the .bak is refreshed from it. Only
when manifest.json is ALREADY Chrome-shaped (mid-conversion, not yet
restored) does the existing .bak get trusted instead, since at that point
it's the only copy of the Firefox original left. Without this check, editing
manifest.json again after a conversion and forgetting to `--restore` first
would silently convert from a stale .bak and discard the edit.

Usage (from the extension's directory):
    uv run make_chrome_manifest.py            # convert
    uv run make_chrome_manifest.py --restore  # put the Firefox original back
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

# The version that added the native `browser` namespace this extension's code
# relies on -- most importantly runtime.onMessage listeners returning a
# Promise, which background.js's relayDecision depends on. (148 is enough
# here specifically because this extension has no devtools_page; that case
# needed 152.)
MIN_CHROME_VERSION = "148"


def is_firefox_shaped(data: dict) -> bool:
    background = data.get("background")
    return isinstance(background, dict) and "scripts" in background


def to_chrome_manifest(data: dict) -> dict:
    data = dict(data)  # shallow copy -- don't mutate the caller's dict

    background = data.get("background")
    if isinstance(background, dict) and "scripts" in background:
        scripts = background["scripts"]
        if len(scripts) != 1:
            raise ValueError(
                f"expected exactly one background script, found {scripts!r} -- "
                "Chrome MV3's service_worker only takes a single file, so this "
                "script doesn't know how to combine several"
            )
        new_background = {"service_worker": scripts[0]}
        if background.get("type") == "module":
            new_background["type"] = "module"
        data["background"] = new_background

    # Firefox-only (extension id, data-collection disclosure, min version).
    # Chrome ignores unrecognized keys rather than erroring, but there's no
    # reason to ship Firefox-specific config in the Chrome build.
    data.pop("browser_specific_settings", None)

    data["minimum_chrome_version"] = MIN_CHROME_VERSION

    return data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "manifest", nargs="?", default="manifest.json", type=Path,
        help="path to manifest.json (default: ./manifest.json)",
    )
    parser.add_argument(
        "--restore", action="store_true",
        help="copy the .bak back over manifest.json and exit, undoing a conversion",
    )
    args = parser.parse_args()

    manifest_path: Path = args.manifest
    backup_path = manifest_path.with_suffix(manifest_path.suffix + ".bak")

    if args.restore:
        if not backup_path.exists():
            sys.exit(f"no backup found at {backup_path}")
        shutil.copyfile(backup_path, manifest_path)
        print(f"restored {manifest_path} from {backup_path}")
        return

    if not manifest_path.exists():
        sys.exit(f"{manifest_path} not found")
    current = json.loads(manifest_path.read_text())

    # manifest.json being Firefox-shaped means it's the live, possibly just
    # -edited source -- always prefer it and refresh the backup, rather than
    # trusting a .bak that could predate a version bump, a new icon, whatever
    # else changed since the last conversion. Only fall back to the .bak when
    # manifest.json is already Chrome-shaped (converted, not yet restored),
    # since that's the one case where it's the sole remaining copy.
    if is_firefox_shaped(current):
        shutil.copyfile(manifest_path, backup_path)
        print(f"backed up current Firefox manifest to {backup_path}")
        original = current
    elif backup_path.exists():
        print(f"manifest.json is already Chrome-shaped -- reconverting from {backup_path}")
        original = json.loads(backup_path.read_text())
    else:
        sys.exit(
            f"{manifest_path} is already Chrome-shaped and no {backup_path} exists "
            "-- nothing to convert from"
        )

    chrome_manifest = to_chrome_manifest(original)

    manifest_path.write_text(json.dumps(chrome_manifest, indent=2) + "\n")
    print(f"wrote Chrome-compatible manifest to {manifest_path}")


if __name__ == "__main__":
    main()
