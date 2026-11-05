FROM node:24-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=4173
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server.mjs ./server.mjs
USER node
EXPOSE 4173
CMD ["node", "server.mjs"]
