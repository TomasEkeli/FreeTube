FROM mcr.microsoft.com/devcontainers/javascript-node:24-bookworm

# The container user is renamed to match the host user, and its home is moved to
# the host's home path. This is not cosmetic: ~/.claude/plugins/installed_plugins.json
# records absolute plugin paths, so Claude Code's plugins only resolve if the
# mounted config sits at exactly the same path it has on the host.
ARG USERNAME=node
ARG USER_HOME=/home/node

# Renaming the base image's `node` user leaves /etc/sudoers.d/node pointing at a
# user that no longer exists, which silently costs the new user sudo entirely —
# and the account has no password to fall back on, so sudo becomes unusable.
RUN if [ "$USERNAME" != "node" ]; then \
      usermod -l "$USERNAME" -d "$USER_HOME" -m node \
      && groupmod -n "$USERNAME" node \
      && rm -f /etc/sudoers.d/node; \
    fi

# This is a single-developer dev container living behind the host's own security
# boundary, so the user gets unrestricted sudo and no password at all. Do not
# carry this into any image that runs something other than local development.
RUN usermod -aG sudo "$USERNAME" \
  && passwd -d "$USERNAME" \
  && echo "$USERNAME ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/"$USERNAME" \
  && chmod 0440 /etc/sudoers.d/"$USERNAME" \
  && visudo -cf /etc/sudoers.d/"$USERNAME"

# Runtime libraries Electron/Chromium needs to launch inside the container,
# plus libsecret for safeStorage and fonts so the UI renders text.
# libpulse0 is what carries audio: Chromium dlopens it to reach the WSLg
# PulseServer socket. Without it Chromium silently falls back to ALSA, which
# has no /dev/snd in the container — video plays, sound does not.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
  && apt-get install -y --no-install-recommends \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgl1 \
    libgtk-3-0 \
    libnotify4 \
    libnss3 \
    libpango-1.0-0 \
    libpulse0 \
    libsecret-1-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    fonts-liberation \
    xdg-utils \
  && apt-get clean -y && rm -rf /var/lib/apt/lists/*

# Match CI (pnpm/action-setup with version: 10)
RUN npm install -g pnpm@10

# Pre-create the pnpm store mount point owned by the user, so the named volume
# inherits the right ownership on first use.
RUN mkdir -p "$USER_HOME/.local/share/pnpm/store" \
  && chown -R "$USERNAME:$USERNAME" "$USER_HOME/.local"
