FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

ARG BASE_PATH=/
ENV BASE_PATH=$BASE_PATH
RUN npm run build

FROM nginx:alpine

ARG BASE_PATH=/
ENV PORT=8080

COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template

COPY docker/bake-nginx-config.sh /usr/local/bin/bake-nginx-config.sh
RUN chmod +x /usr/local/bin/bake-nginx-config.sh \
    && BASE_PATH=${BASE_PATH} /usr/local/bin/bake-nginx-config.sh \
    && rm /usr/local/bin/bake-nginx-config.sh

EXPOSE 8080
