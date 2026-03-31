FROM node

COPY .env .env
COPY ./lib/ ./lib/
COPY ./kv.test.ts ./main.ts

ENTRYPOINT [ "node", "--env-file=.env" ]
CMD [ "main.ts" ]
