# The managed runtime. Vercel builds it from this folder; ffmpeg converts Telegram voice notes.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
USER node
CMD ["node", "fleet.mjs"]
