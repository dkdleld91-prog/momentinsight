FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY .env.example ./.env.example

ENV HOST=0.0.0.0
ENV PORT=8797
ENV NAVER_PLACE_PROVIDER_HEADLESS=true
ENV NAVER_PLACE_PROVIDER_MAX_SCROLLS=90
ENV NAVER_PLACE_PROVIDER_TIMEOUT_MS=90000

EXPOSE 8797

CMD ["npm", "start"]
