FROM node:20-alpine

WORKDIR /app

# better-sqlite3 is a native module — needs a build toolchain on alpine
RUN apk add --no-cache python3 make g++

# Install deps. --legacy-peer-deps mirrors pnpm's lenient peer resolution used
# in dev (an optional langchain peer wants an older openai). devDependencies are
# kept on purpose — tsx/typescript are required at runtime.
COPY package.json ./
RUN npm install --legacy-peer-deps

# App source + tsconfig (tsx reads it at runtime)
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3001

# tsx transpiles TypeScript on the fly — entry is src/index.ts
CMD ["npx", "tsx", "src/index.ts"]
