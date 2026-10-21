# DevFlow runner (change add-dev-stage): where the Dev agent runs, apart from the server container.
# It has no database, no server secrets and no access to /paperclip. Paperclip reaches it over SSH
# (execution target "ssh"): it copies the case's workspace in, runs Claude Code, and copies the commits back.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server git ca-certificates curl python3 python3-pip rsync tar procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@latest

RUN useradd -m -s /bin/bash runner \
 && mkdir -p /work /home/runner/.ssh /run/sshd \
 && chown -R runner:runner /work /home/runner/.ssh \
 && chmod 700 /home/runner/.ssh \
 && ssh-keygen -A

COPY sshd_config /etc/ssh/sshd_config.d/devflow.conf

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
