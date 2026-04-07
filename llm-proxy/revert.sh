#!/bin/bash
# Revert Hermes config to pre-proxy state
BACKUP=$(ls -t ~/.hermes/config.yaml.backup-* 2>/dev/null | head -1)
if [ -z "$BACKUP" ]; then
  echo "No backup found!"
  exit 1
fi
echo "Reverting to: $BACKUP"
cp "$BACKUP" ~/.hermes/config.yaml
echo "Done. Proxy references removed from Hermes config."
echo "You can stop the proxy process if it's running."
