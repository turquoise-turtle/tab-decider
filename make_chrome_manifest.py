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
becomes the Chrome-compatible copy. Safe to run more than once -- it always
regenerates manifest.json from the .bak (never from its own prior output),
so re-running doesn't compound conversions or accidentally back up an
already-converted file.

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

    # The .bak is always the source of truth for "the Firefox original" --
    # regenerating from it, rather than from manifest.json itself, is what
    # makes this idempotent.
    if backup_path.exists():
        source_path = backup_path
    else:
        if not manifest_path.exists():
            sys.exit(f"{manifest_path} not found")
        shutil.copyfile(manifest_path, backup_path)
        print(f"backed up original to {backup_path}")
        source_path = backup_path

    original = json.loads(source_path.read_text())
    chrome_manifest = to_chrome_manifest(original)

    manifest_path.write_text(json.dumps(chrome_manifest, indent=2) + "\n")
    print(f"wrote Chrome-compatible manifest to {manifest_path}")


if __name__ == "__main__":
    main()
