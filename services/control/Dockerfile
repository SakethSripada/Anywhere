# Anywhere control plane: FastAPI + LangGraph agent + Brev CLI + SSH.
FROM python:3.13-slim

ARG BREV_VERSION=0.6.337
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Brev CLI, pinned and checksum-verified against the release manifest.
RUN set -eux; arch="$(dpkg --print-architecture)"; \
    base="https://github.com/brevdev/brev-cli/releases/download/v${BREV_VERSION}"; \
    tarball="brev-cli_${BREV_VERSION}_linux_${arch}.tar.gz"; \
    cd /tmp; curl -fsSLO "$base/$tarball"; curl -fsSLO "$base/brev-cli_${BREV_VERSION}_checksums.txt"; \
    grep " $tarball\$" "brev-cli_${BREV_VERSION}_checksums.txt" | sha256sum -c -; \
    tar -xzf "$tarball" -C /usr/local/bin brev; rm -f /tmp/*

RUN pip install --no-cache-dir uv==0.12.0
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev

# ~/.brev is a named volume in deploy/docker-compose.yml. Docker initialises a new
# named volume from the image's directory (contents and ownership), so it must exist
# here and belong to `anywhere`; otherwise the volume is root-owned and the Brev CLI
# can't write its login or SSH config. ~/.ssh gets the Include that `brev refresh` adds.
RUN useradd --create-home --uid 10001 anywhere \
 && mkdir -p /data /home/anywhere/.brev /home/anywhere/.ssh \
 && chown anywhere /data \
 && chown anywhere:anywhere /home/anywhere/.brev /home/anywhere/.ssh \
 && chmod 700 /home/anywhere/.ssh
USER anywhere
ENV PATH="/app/.venv/bin:$PATH" DATA_DIR=/data ENVIRONMENT=production
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1:8000/health || exit 1
CMD ["anywhere", "serve", "--port", "8000"]
