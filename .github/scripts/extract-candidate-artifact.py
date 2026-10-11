"""Extract an exact flat allowlist from a bounded Actions artifact ZIP."""

import json
import pathlib
import stat
import sys
import zipfile


def require(condition):
    if not condition:
        raise ValueError("Artifact ZIP violates extraction bounds or allowlist")


archive, destination, maximum, names = sys.argv[1:]
maximum = int(maximum)
expected = set(json.loads(names))
require(expected and all(pathlib.PurePosixPath(name).name == name for name in expected))
require(not any(name in {".", ".."} or "\\" in name for name in expected))
root = pathlib.Path(destination)
root.mkdir(parents=True, exist_ok=False)
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    require(len(entries) == len(expected))
    require({entry.filename for entry in entries} == expected)
    require(sum(entry.file_size for entry in entries) <= maximum)
    for entry in entries:
        mode = entry.external_attr >> 16
        require(not entry.is_dir() and not stat.S_ISLNK(mode))
        require(stat.S_IFMT(mode) in {0, stat.S_IFREG})
        with source.open(entry) as content, (root / entry.filename).open("xb") as target:
            written = 0
            while chunk := content.read(1024 * 1024):
                written += len(chunk)
                require(written <= entry.file_size and written <= maximum)
                target.write(chunk)
