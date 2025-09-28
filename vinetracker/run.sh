#!/usr/bin/with-contenv bashio
set +u

bashio::log.info "Starting VineTracker service."
npm run start
