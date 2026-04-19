FROM node:20-slim AS frontend
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

FROM node:20-slim
RUN apt-get update && apt-get install -y curl python3 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json .
COPY src/ src/
COPY scripts/ scripts/
COPY assets/ assets/
RUN npx tsc
COPY --from=frontend /frontend/dist ./frontend/dist
CMD ["node", "dist/index.js"]
