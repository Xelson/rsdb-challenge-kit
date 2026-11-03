#!/bin/sh
# Starts rsdb-server with the flags of SPEC §4.1. Environment set by the judge or a compose file:
#   RSDB_NODE_ID (default n1); RSDB_PEERS (cluster only, id=ip:7701,...); RSDB_LOG;
#   RSDB_PEER_DELAY (for example 1ms) with RSDB_PEER_SUBNET_PREFIX: one-way netem delay on the peer interface.
set -eu
: "${RSDB_NODE_ID:=n1}"
if [ -n "${RSDB_PEER_DELAY:-}" ]; then
  iface=$(ip -o -4 addr show | awk -v p="${RSDB_PEER_SUBNET_PREFIX:?}" 'index($4, p) == 1 { print $2; exit }')
  tc qdisc replace dev "${iface:?no interface in the peer subnet}" root netem delay "$RSDB_PEER_DELAY"
fi
set -- --data-dir /data --listen 0.0.0.0:7700 --node-id "$RSDB_NODE_ID"
if [ -n "${RSDB_PEERS:-}" ]; then
  set -- "$@" --peers "$RSDB_PEERS" --peer-listen 0.0.0.0:7701
fi
exec rsdb-server "$@"
