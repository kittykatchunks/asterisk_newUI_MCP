FROM andrius/asterisk:22.11.0_debian-trixie@sha256:d6333b8b331563c5887b98b12da9371ef48317e657d17d81770fe085f335041d

USER root
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tcpdump tshark \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["python3", "-B", "/diagnostics/capture.py"]
