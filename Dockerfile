FROM node:22-slim

WORKDIR /app

# native build tools only for better-sqlite3; prebuilt binaries usually suffice
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY seed.js ./

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# SQLite file lives here unless a Supabase backend is configured via env
VOLUME ["/data"]
ENV LM_DB=/data/labormeasurer.db

CMD ["node", "src/server.js"]
