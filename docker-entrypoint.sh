#!/bin/sh
set -e

echo "Esperando a que PostgreSQL esté listo..."
while ! nc -z postgres 5432; do
  sleep 1
done
echo "PostgreSQL está listo."

echo "Creando el esquema app..."
echo "CREATE SCHEMA IF NOT EXISTS app;" | npx prisma db execute --stdin

echo "Ejecutando Prisma generate..."
npx prisma generate

echo "Aplicando el esquema (db push)..."
npx prisma db push --accept-data-loss

echo "Iniciando la aplicación..."
exec "$@"
