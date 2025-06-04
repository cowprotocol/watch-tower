FROM node:22.2-alpine AS build

WORKDIR /usr/src/app

COPY . .

RUN yarn && \
    yarn lint && \
    yarn test && \
    yarn build

VOLUME [ "/usr/src/app/database" ]
ENTRYPOINT ["node","./dist/src/index.js"]
