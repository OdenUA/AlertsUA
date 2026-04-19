#!/bin/bash
# .env.worker configuration for alerts-ua-telegram workers
# Copy this to /srv/alerts-ua/env/.env.worker on VPS

# Telegram API Credentials (from my.telegram.org)
TELEGRAM_API_ID=INSERT_TELEGRAM_API_ID
TELEGRAM_API_HASH=INSERT_TELEGRAM_API_HASH

# Telegram MTProto Session String (generated via gramjs script)
# IMPORTANT: This is a PRIVATE credential - treat it like a password!
# You can get this by running the session generator script locally
# If having issues, you can use Telethon (Python library) to generate it instead
TELEGRAM_SESSION_STRING="INSERT_TELEGRAM_SESSION_STRING"

# Telegram Channels to Monitor
# Format: comma-separated channel usernames or IDs
# Example: @kpszsu,@channel2,"Channel Name"
TELEGRAM_CHANNEL_REFS=@kpszsu

# Gemini API Configuration
GEMINI_API_KEY=INSERT_GEMINI_API_KEY
GEMINI_MODEL=gemini-2.5-flash

# Optional: Telegram Ingest Settings
TELEGRAM_INGEST_LIMIT=100
TELEGRAM_PARSER_BATCH=20
TELEGRAM_PARSER_MAX_ATTEMPTS=3
GEMINI_TIMEOUT_MS=30000

# Database connection (required by workers)
DATABASE_URL=postgresql://INSERT_DB_USER:INSERT_DB_PASSWORD@127.0.0.1:5432/alerts_ua
