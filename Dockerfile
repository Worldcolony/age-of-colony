FROM node:20-bookworm-slim AS web-deps

WORKDIR /app/web

COPY web/package*.json ./
RUN npm ci


FROM web-deps AS web-build

ENV NEXT_TELEMETRY_DISABLED=1

COPY web/ ./
RUN npm run build


FROM node:20-bookworm-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV NEXT_TELEMETRY_DISABLED=1
ENV BACKEND_PORT=8000

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY web/package*.json ./web/
COPY web/scripts ./web/scripts
COPY --from=web-deps /app/web/node_modules ./web/node_modules
COPY --from=web-build /app/web/.next ./web/.next
COPY --from=web-build /app/web/public ./web/public
COPY --from=web-build /app/web/next.config.ts ./web/next.config.ts

EXPOSE 3000

CMD ["sh", "-c", "uvicorn app.main:app --host 127.0.0.1 --port ${BACKEND_PORT:-8000} & cd web && exec npm run start -- --hostname 0.0.0.0 --port ${PORT:-3000}"]
