FROM node:22-alpine AS build

WORKDIR /usr/src/app

COPY . .

RUN yarn && \
    yarn build

VOLUME [ "/usr/src/app/database" ]
ENTRYPOINT ["node","./dist/src/index.js"]
