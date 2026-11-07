#!/bin/bash
# usage: take.sh desktop|mobile  (reseeds, restarts the local server, records one take)
V=/tmp/claude-0/-home-claude/a1d83405-418b-534c-a414-6b0050e0a7a9/scratchpad/video
cd /home/claude/checkrail-pay
pkill -f "next start" ; pkill -f "next-server"; sleep 2
export DATABASE_PATH=$V/demo.sqlite CHECKRAIL_INSECURE_DEMO=1 NODE_ENV=production
rm -f $V/demo.sqlite*; npm run db:seed >/dev/null 2>&1
(npx next start -p 3300 > $V/server.log 2>&1 &)
for i in $(seq 1 30); do curl -s -o /dev/null localhost:3300/demo && break; sleep 1; done
cd $V && DATABASE_PATH=$V/demo.sqlite NODE_PATH=$(npm root -g) node video-record.cjs $1
