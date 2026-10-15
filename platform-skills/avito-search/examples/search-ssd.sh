#!/bin/bash
# Development example only: build first, then run under a verified Trelio host.
# This file is never included in the signed runtime or executed by tests.

node dist/trelio-avito.cjs search "Samsung SSD 2TB M.2 server" \
  --price-max 15000 \
  --sort price_asc \
  --output output/ssd-results.json
