# DevFlow runner (change add-dev-stage): where the Dev agent runs, apart from the server container.
# It has no database, no server secrets and no access to /paperclip of the server. Paperclip reaches it over SSH
# (execution target "ssh"): it copies the case's workspace in, runs Claude Code, and copies the commits back.
# The only way out is the allow-list proxy (devflow-proxy); see docker-compose.runner.yml and squid.conf.
FROM node:24-bookworm-slim

# Toolchains for the first target repositories: Node (base image) and Python. Flutter is not installed yet
# (spike: not tried); add it here when a system needs it. python3-venv is left out on purpose: its packages are
# blocked by some company firewalls; use `pip install --user` or virtualenv instead.
RUN printf 'Acquire::Retries "5";\n' > /etc/apt/apt.conf.d/80retries \
 && apt-get update \
 && apt-get install -y --no-install-recommends openssh-server git ca-certificates curl python3 python3-pip rsync tar procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@latest

# Same path as on the server: the adapter needs the working directory valid on both sides (spike finding).
RUN useradd -m -s /bin/bash runner \
 && mkdir -p /paperclip/devflow/ws /home/runner/.ssh /run/sshd /etc/ssh/hostkeys \
 && chown -R runner:runner /paperclip /home/runner/.ssh \
 && chmod 700 /home/runner/.ssh \
 && printf '%s\n' \
    'HTTP_PROXY=http://devflow-proxy:3128' 'HTTPS_PROXY=http://devflow-proxy:3128' \
    'http_proxy=http://devflow-proxy:3128' 'https_proxy=http://devflow-proxy:3128' \
    'NO_PROXY=localhost,127.0.0.1' > /etc/environment   # sshd sessions read this through PAM

COPY sshd_config /etc/ssh/sshd_config.d/devflow.conf
COPY entrypoint.sh /usr/local/bin/devflow-runner-entrypoint
RUN chmod 755 /usr/local/bin/devflow-runner-entrypoint

EXPOSE 22
ENTRYPOINT ["devflow-runner-entrypoint"]
