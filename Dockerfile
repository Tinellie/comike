# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
COPY patches ./patches
RUN npm ci
COPY client ./client
COPY server ./server
COPY ref/hall-meta.json ./ref/hall-meta.json
COPY tools/booth-recognition/map_recognition/west_line_cleanup.json ./tools/booth-recognition/map_recognition/
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    HOME=/app/.local \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    OCR_ENABLED=false
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/client/package.json ./client/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY server/drizzle ./server/drizzle
COPY deploy/*.mjs ./deploy/
COPY tools/booth-recognition ./tools/booth-recognition
COPY ref/hall-meta.json ref/hall-transforms.json ref/osm-map.osm ref/official-map.pdf ./seed/ref/
RUN npx --no-install playwright install --with-deps chromium && apt-get clean
RUN mkdir -p storage .local ref tools/booth-recognition/output/official-map \
    && chown node:node storage .local ref tools/booth-recognition/output/official-map
USER node
EXPOSE 3001
ENTRYPOINT ["node", "deploy/entrypoint.mjs"]
CMD ["serve"]

FROM runtime AS ocr
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv libgl1 libgomp1 \
    && python3 -m venv tools/booth-recognition/.venv \
    && tools/booth-recognition/.venv/bin/python -m pip install --no-cache-dir -r tools/booth-recognition/requirements.txt \
    && apt-get clean
ENV OCR_ENABLED=true
USER node

FROM runtime AS production
