# DevFlow runner (change add-dev-stage): where the Dev agent runs, apart from the server container.
# It has no database, no server secrets and no access to /paperclip of the server. Paperclip reaches it over SSH
# (execution target "ssh"): it copies the case's workspace in, runs Claude Code, and copies the commits back.
# The only way out is the allow-list proxy (devflow-proxy); see docker-compose.runner.yml and squid.conf.
FROM node:24-bookworm-slim

# Toolchains for the first target repositories: Node (base image), Python, .NET 8/10 and Flutter (see below). python3-venv is left out on purpose: its packages are
# blocked by some company firewalls; use `pip install --user` or virtualenv instead.
RUN printf 'Acquire::Retries "5";\n' > /etc/apt/apt.conf.d/80retries \
 && apt-get update \
 && apt-get install -y --no-install-recommends openssh-server git ca-certificates curl python3 python3-pip rsync tar procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@latest

# .NET: SDKs 8 and 10 side by side (each SDK carries its own runtime). `dotnet` picks the SDK a repository's
# global.json asks for, else the newest; DOTNET_ROLLFORWARD lets a newer runtime run a test project that targets
# an older one. Needs the libraries .NET links against.
ENV DOTNET_ROOT=/usr/share/dotnet DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_ROLLFORWARD=Major
# Networks that inspect TLS: root CAs from docker/certs (gitignored, may be empty), as for the server image.
RUN --mount=type=bind,from=certs,target=/certs     for f in /certs/*.pem; do [ -f "$f" ] && cp "$f" "/usr/local/share/ca-certificates/$(basename "$f" .pem).crt"; done;     update-ca-certificates
RUN apt-get update \
 && apt-get install -y --no-install-recommends libicu72 libssl3 zlib1g \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
 && for channel in 8.0 10.0; do bash /tmp/dotnet-install.sh --channel "$channel" --install-dir "$DOTNET_ROOT"; done \
 && ln -s "$DOTNET_ROOT/dotnet" /usr/bin/dotnet \
 && rm /tmp/dotnet-install.sh

# Same path as on the server: the adapter needs the working directory valid on both sides (spike finding).
RUN useradd -m -s /bin/bash runner \
 && mkdir -p /paperclip/devflow/ws /home/runner/.ssh /home/runner/.nuget /home/runner/.npm /run/sshd /etc/ssh/hostkeys \
 && chown -R runner:runner /paperclip /home/runner/.ssh /home/runner/.nuget /home/runner/.npm \
 && chmod 700 /home/runner/.ssh \
 && printf '%s\n' \
    'HTTP_PROXY=http://devflow-proxy:3128' 'HTTPS_PROXY=http://devflow-proxy:3128' \
    'http_proxy=http://devflow-proxy:3128' 'https_proxy=http://devflow-proxy:3128' \
    'NO_PROXY=localhost,127.0.0.1' 'DOTNET_ROOT=/usr/share/dotnet' 'DOTNET_ROLLFORWARD=Major' \
    'DOTNET_NOLOGO=1' 'DOTNET_CLI_TELEMETRY_OPTOUT=1' > /etc/environment   # sshd sessions read this through PAM

# Flutter, pinned to what RESKI's mobile app asks for (mobile/.fvmrc: 3.47.0), for `flutter pub get`, `analyze` and `test`;
# no Android or iOS tooling (full app builds are not part of the Dev stage). Owned by the runner user because the tool writes
# into its own folder. `precache --universal` fetches the Dart SDK and the test engine now, not on the first run behind the proxy.
ARG FLUTTER_VERSION=3.47.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip xz-utils zip \
 && rm -rf /var/lib/apt/lists/* \
 && git clone --depth 1 --branch "$FLUTTER_VERSION" https://github.com/flutter/flutter.git /opt/flutter \
 && chown -R runner:runner /opt/flutter \
 && mkdir -p /home/runner/.pub-cache && chown runner:runner /home/runner/.pub-cache \
 && ln -s /opt/flutter/bin/flutter /usr/local/bin/flutter \
 && ln -s /opt/flutter/bin/dart /usr/local/bin/dart
USER runner
RUN git config --global --add safe.directory /opt/flutter \
 && flutter config --no-analytics --no-cli-animations >/dev/null \
 && dart --disable-analytics >/dev/null \
 && flutter precache --universal \
 && flutter --version
USER root

COPY sshd_config /etc/ssh/sshd_config.d/devflow.conf
COPY entrypoint.sh /usr/local/bin/devflow-runner-entrypoint
RUN chmod 755 /usr/local/bin/devflow-runner-entrypoint

EXPOSE 22
ENTRYPOINT ["devflow-runner-entrypoint"]
