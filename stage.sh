#!/usr/bin/env bash
# Assemble exactly what should be public into dist/.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist
cp index.html styles.css 404.html dist/
cp -r src dist/src
echo "staged $(find dist -type f | wc -l) files into dist/"
