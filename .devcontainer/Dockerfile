FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

# [Optional] Uncomment if you want to install more tools
# RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
#     && apt-get -y install --no-install-recommends \

RUN su node -c "source /usr/local/share/nvm/nvm.sh && nvm install --lts=hydrogen"
RUN su node -c "source /usr/local/share/nvm/nvm.sh && nvm install --lts=iron"
RUN su node -c "source /usr/local/share/nvm/nvm.sh && nvm install --lts=jod"

# [Optional] Uncomment if you want to install more global node modules
ARG NODE_MODULES="turbo prettier typescript @changesets/cli @arethetypeswrong/cli"
RUN su node -c "npm install -g ${NODE_MODULES}" \
    && npm cache clean --force > /dev/null 2>&1

# [Optional] Uncomment if you want to install ydb cli
RUN curl -fsSL https://install.ydb.tech/cli | bash

# [Optional] Uncomment if you want to install bun
RUN curl -fsSL https://bun.sh/install | bash
