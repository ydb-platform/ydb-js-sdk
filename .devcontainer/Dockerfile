FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

RUN su node -c "source /usr/local/share/nvm/nvm.sh && nvm install 18"
RUN su node -c "source /usr/local/share/nvm/nvm.sh && nvm install 20"
RUN su node -c "source /usr/local/share/nvm/nvm.sh && nvm install 22"

# [Optional] Uncomment if you want to install more global node modules
ARG NODE_MODULES="typescript"
RUN su node -c "npm install -g ${NODE_MODULES}" \
    && npm cache clean --force > /dev/null 2>&1

# [Optional] Uncomment if you want to install ydb cli
RUN curl -fsSL https://install.ydb.tech/cli | bash

# [Optional] Uncomment if you want to install bun
RUN curl -fsSL https://bun.sh/install | bash
