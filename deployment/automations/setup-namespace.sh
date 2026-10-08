#!/bin/sh
set -eu
# Database schema setup does not create the application namespace.
temporal operator cluster health --address "$TEMPORAL_ADDRESS"
if ! temporal operator namespace describe --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" >/dev/null 2>&1; then
  temporal operator namespace create --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" --retention 30d
fi
