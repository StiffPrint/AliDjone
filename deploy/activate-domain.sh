#!/usr/bin/env bash
set -euo pipefail

# Install this directory as /opt/alidjone/domain-config and run as root after
# the DNS propagation interval. Never writes to the warehouse database.
exec 9>/run/alidjone-domain.lock
flock -n 9 || { echo 'Domain activation is already running'; exit 0; }
config_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
domain=alijhone.store
target_ip=185.219.43.57

ipv4_addresses() {
  dig @1.1.1.1 +time=3 +tries=1 +short A "$1" | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ {print}' | sort -u
}
if [ "$(ipv4_addresses "$domain")" != "$target_ip" ]; then
  echo 'Domain A record does not yet point exclusively to this server'; exit 2
fi
if dig @1.1.1.1 +time=3 +tries=1 +short AAAA "$domain" | grep -q ':'; then
  echo 'Remove the AAAA record: this application server uses IPv4'; exit 2
fi

certificate_names=(-d "$domain")
include_www=false
if [ "$(ipv4_addresses "www.$domain")" = "$target_ip" ] && ! dig @1.1.1.1 +time=3 +tries=1 +short AAAA "www.$domain" | grep -q ':'; then
  certificate_names+=(-d "www.$domain")
  include_www=true
fi

certbot certonly --webroot -w /var/www/letsencrypt \
  --cert-name "$domain" "${certificate_names[@]}" \
  --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring --expand

backup_dir="/opt/alidjone/domain-backups/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$backup_dir"
cp -p /etc/alidjone.env "$backup_dir/environment"
cp -p /etc/nginx/sites-available/alidjone-http.conf "$backup_dir/old-http"
cp -p /etc/nginx/sites-available/alidjone-https.conf "$backup_dir/old-https"
cp -p /etc/nginx/sites-available/alijhone-http.conf "$backup_dir/new-http"
rollback() {
  echo 'Domain activation failed; restoring previous configuration'
  cp -p "$backup_dir/environment" /etc/alidjone.env
  cp -p "$backup_dir/old-http" /etc/nginx/sites-available/alidjone-http.conf
  cp -p "$backup_dir/old-https" /etc/nginx/sites-available/alidjone-https.conf
  cp -p "$backup_dir/new-http" /etc/nginx/sites-available/alijhone-http.conf
  rm -f /etc/nginx/sites-enabled/alijhone-https.conf /etc/nginx/sites-enabled/alijhone-www-https.conf
  nginx -t && systemctl reload nginx
  systemctl restart alidjone.service
}
trap rollback ERR

install -m 644 "$config_dir/alijhone-http.conf" /etc/nginx/sites-available/alijhone-http.conf
install -m 644 "$config_dir/alijhone-https.conf" /etc/nginx/sites-available/alijhone-https.conf
ln -sfn /etc/nginx/sites-available/alijhone-https.conf /etc/nginx/sites-enabled/alijhone-https.conf
if "$include_www"; then
  install -m 644 "$config_dir/alijhone-www-https.conf" /etc/nginx/sites-available/alijhone-www-https.conf
  ln -sfn /etc/nginx/sites-available/alijhone-www-https.conf /etc/nginx/sites-enabled/alijhone-www-https.conf
fi

# Preserve the old certificate and its HTTP-01 renewal path, but send visitors
# to the canonical domain so every write uses the correct Origin and cookie.
cat > /etc/nginx/sites-available/alidjone-http.conf <<'NGINX'
server {
    listen 80;
    server_name alidjone.185.219.43.57.sslip.io;
    server_tokens off;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 301 https://alijhone.store$request_uri; }
}
NGINX
cat > /etc/nginx/sites-available/alidjone-https.conf <<'NGINX'
server {
    listen 443 ssl;
    http2 on;
    server_name alidjone.185.219.43.57.sslip.io;
    ssl_certificate /etc/letsencrypt/live/alidjone.185.219.43.57.sslip.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/alidjone.185.219.43.57.sslip.io/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    server_tokens off;
    location / { return 301 https://alijhone.store$request_uri; }
}
NGINX

nginx -t
sed -i 's|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=https://alijhone.store|' /etc/alidjone.env
systemctl restart alidjone.service
ready=false
for attempt in {1..30}; do
  if curl -fsS --max-time 2 http://127.0.0.1:5180/healthz >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.2
done
"$ready"
systemctl reload nginx
# Nginx reload returns before the replacement workers accept connections.
tls_ready=false
for attempt in {1..30}; do
  if curl -fsS --max-time 3 --resolve alijhone.store:443:127.0.0.1 https://alijhone.store/healthz >/dev/null 2>&1; then tls_ready=true; break; fi
  sleep 0.3
done
"$tls_ready"
trap - ERR
echo "Domain activated: https://$domain (www redirect: $include_www)"
