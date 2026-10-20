"""Read only a closed list of signed instruction files, before credential IO."""
import hashlib
import pathlib

FILES = ["part-01.md", "part-02.md", "part-03.md", "part-04.md", "part-05.md", "part-06.md"]


def get_instruction_guides():
    # No caller path, identity, key store, browser, import of provider SDK or
    # external request belongs in this route. Host admission remains upstream.
    directory = pathlib.Path(__file__).resolve().parent / "instruction-guides"
    guides = []
    for name in FILES:
        path = directory / name
        content = path.read_bytes()
        guides.append({"path": str(path), "sizeBytes": len(content),
                       "sha256": hashlib.sha256(content).hexdigest()})
    return {"schemaVersion": 1, "requiredBeforeWork": "all_in_order", "guides": guides}
