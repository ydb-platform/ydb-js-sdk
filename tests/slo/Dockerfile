# node, oven/bun
ARG image="node"

FROM ${image}
WORKDIR /usr/src/app

COPY package.json dist/ ./

ENTRYPOINT [ "node" ]
CMD [ "kv.test.js" ]
