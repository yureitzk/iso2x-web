#!/bin/sh
set -eu

TEMPLATE_FILE="/etc/nginx/templates/default.conf.template"

sed -i "s|\${BASE_PATH}|${BASE_PATH}|g" "$TEMPLATE_FILE"
