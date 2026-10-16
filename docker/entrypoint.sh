#!/bin/sh
set -eu

pnpm --filter @rack/database migrate:deploy

exec "$@"
