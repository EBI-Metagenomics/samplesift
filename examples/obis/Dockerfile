FROM node:22-slim AS frontend

WORKDIR /app
COPY frontend ./frontend
RUN npm ci --prefix frontend && npm run build:django --prefix frontend

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    binutils libgdal-dev libgeos-dev libproj-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml README ./
COPY src ./src
COPY --from=frontend /app/src/samplesift/django/static ./src/samplesift/django/static
RUN pip install --no-cache-dir '.[django]' 'psycopg[binary]>=3.2,<4' 'redis>=5,<7'
COPY examples/obis ./examples/obis
WORKDIR /app/examples/obis
EXPOSE 8000
ENTRYPOINT ["./entrypoint.sh"]
