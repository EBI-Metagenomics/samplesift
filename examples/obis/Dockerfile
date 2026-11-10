FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    binutils libgdal-dev libgeos-dev libproj-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml README ./
COPY src ./src
RUN pip install --no-cache-dir '.[django]' 'psycopg[binary]>=3.2,<4'
COPY examples/obis ./examples/obis
WORKDIR /app/examples/obis
EXPOSE 8000
ENTRYPOINT ["./entrypoint.sh"]
