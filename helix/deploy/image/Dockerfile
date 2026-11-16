# The image every Helix job runs in: the tools a job uses, and nothing of
# anyone's. Animus itself is not in it: Helix mounts its own checkout,
# read-only, so a release needs no new image unless these versions change.
# `helix image` builds it as animus-job:<version>, for the account Helix runs as.
FROM node:24-bookworm

ARG UID=1000
ARG GID=1000
ARG CLAUDE_VERSION=2.1.325
ARG AGENT_BROWSER_VERSION=0.43.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl python3 python3-venv \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" "agent-browser@${AGENT_BROWSER_VERSION}" && npm cache clean --force
# The browser's system libraries need root; the browser itself goes in the job user's home.
RUN agent-browser install --with-deps && rm -rf /root/.agent-browser

# The job runs as the same uid as Helix's account, so what it writes to the
# folders Helix mounts stays that account's.
RUN userdel -r node 2>/dev/null || true; \
    (getent group "${GID}" >/dev/null || groupadd -g "${GID}" animus) \
 && useradd -m -d /home/animus -u "${UID}" -g "${GID}" -s /bin/bash animus
USER animus
ENV HOME=/home/animus DISABLE_AUTOUPDATER=1 ANIMUS_BROWSER=agent-browser
RUN agent-browser install && mkdir -p /home/animus/.npm
WORKDIR /home/animus
