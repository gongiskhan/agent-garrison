# Container launcher for the Garrison scheduler daemon (any host with Docker).
#   docker build -t garrison-scheduler -f launchers/docker/Dockerfile .
#   docker run -d --restart=always -p 7088:7088 \
#     -v garrison-state:/root/.garrison garrison-scheduler
# The daemon is the same Node code; the container is just another supervisor.
FROM node:20-alpine
WORKDIR /app
COPY scripts/scheduler.mjs ./scheduler.mjs
ENV GARRISON_SCHEDULER_HEALTH_PORT=7088
EXPOSE 7088
# SIGTERM is handled (graceful shutdown); STOPSIGNAL is the default SIGTERM.
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:7088/health || exit 1
CMD ["node", "scheduler.mjs", "daemon", "--health-port", "7088"]
