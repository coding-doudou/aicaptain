# Maersk MDP / Harbor — Node 20, PORT defaults to 8080 in server/index.js
FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --omit=dev

COPY server ./server
COPY aicaptain.html ./

RUN mkdir -p server/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/index.js"]
