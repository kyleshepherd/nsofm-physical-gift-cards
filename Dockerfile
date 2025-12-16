FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

# Install all dependencies (including dev for prisma)
RUN npm ci && npm cache clean --force

COPY . .

# Generate prisma client and build
RUN npx prisma generate
RUN npm run build

# Prune dev dependencies after build
RUN npm prune --omit=dev

CMD ["npm", "run", "docker-start"]
