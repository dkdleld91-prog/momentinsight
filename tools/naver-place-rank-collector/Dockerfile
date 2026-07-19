FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --chown=pwuser:pwuser src ./src
COPY --chown=pwuser:pwuser .env.example ./.env.example

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8797
ENV NAVER_PLACE_PROVIDER_HEADLESS=true
ENV NAVER_PLACE_PROVIDER_MAX_SCROLLS=90
ENV NAVER_PLACE_PROVIDER_TIMEOUT_MS=90000

EXPOSE 8797

USER pwuser

CMD ["node", "src/server.mjs"]
