# The app has zero runtime npm dependencies (the only devDependency is
# wrangler, which is not needed at runtime), so no install step is required —
# just Node and the source files.
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY src ./src
COPY server.js ./

# Cloud Run injects PORT (default 8080); server.js listens on $PORT.
EXPOSE 8080

CMD ["node", "server.js"]
