# node, oven/bun
ARG image="node"

FROM ${image}
WORKDIR /usr/src/app

COPY .env package.json dist/ ./

ENTRYPOINT [ "node", "--env-file=.env" ]
CMD [ "kv.test.js" ]
