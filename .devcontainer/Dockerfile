FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

# [Optional] Uncomment if you want to install more tools
# RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
#     && apt-get -y install --no-install-recommends <your-pkg>

RUN su node -c "source /usr/local/share/nvm/nvm.sh && nvm install 22.23.5"
RUN su node -c "source /usr/local/share/nvm/nvm.sh && nvm install 24.22.3"
RUN su node -c "source /usr/local/share/nvm/nvm.sh && nvm install 26.13.1 && nvm alias default 26.13.1"

ENV NODE_VERSION=26.13.1
ENV PATH="/usr/local/share/nvm/versions/node/v26.13.1/bin:${PATH}"

# [Optional] Uncomment if you want to install more global node modules
ARG NODE_MODULES="turbo prettier typescript @changesets/cli @arethetypeswrong/cli"
RUN su node -c "npm install -g ${NODE_MODULES}" \
    && npm cache clean --force > /dev/null 2>&1

# [Optional] Uncomment if you want to install bun
RUN curl -fsSL https://bun.sh/install | bash

# [Optional] Uncomment if you want to install yc cli
RUN curl -fsSL https://storage.yandexcloud.net/yandexcloud-yc/install.sh | bash

# [Optional] Uncomment if you want to install ydb cli
RUN curl -fsSL https://raw.githubusercontent.com/ydb-platform/ydb/refs/heads/main/ydb/apps/ydb/install/install.sh | bash
