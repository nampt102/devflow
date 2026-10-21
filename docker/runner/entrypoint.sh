#!/bin/sh
# Starts sshd for the runner user. The host key lives on a volume so it survives rebuilds (Paperclip pins it),
# and the login key is the public half mounted read-only at /run/runner/authorized_keys.
set -eu

KEY=/etc/ssh/hostkeys/ssh_host_ed25519_key
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -f "$KEY"

AUTH=/run/runner/authorized_keys
if [ ! -s "$AUTH" ]; then
  echo "devflow-runner: no public key at $AUTH (run scripts/devflow/setup-dev-runner.mjs)" >&2
  exit 1
fi
install -o runner -g runner -m 600 "$AUTH" /home/runner/.ssh/authorized_keys

exec /usr/sbin/sshd -D -e
