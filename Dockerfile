FROM node:alpine AS build

WORKDIR /usr/src/app

COPY . .

RUN yarn && \
    yarn build

VOLUME [ "/usr/src/app/database" ]
ENTRYPOINT ["node","./dist/src/index.js"]
