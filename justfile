default:
    @just --list

# Verify docs are reachable through index files and links and anchors resolve.
check:
    python3 scripts/check_docs.py
