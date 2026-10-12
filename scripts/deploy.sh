#!/usr/bin/env bash
# Deployment hook used by .github/workflows/deploy.yml. The hosting platform has not been chosen yet:
# implement the three roles below for your platform (Fly.io, Render, ECS, Kubernetes, ...).
# Each role runs the same image ($IMAGE); only the command differs.
#   migrate → "$IMAGE-migrate" (npx prisma migrate deploy), run once, must finish before api/worker roll out
#   api     → "$IMAGE" with the default CMD (node dist/main.js), N replicas behind the load balancer
#   worker  → "$IMAGE" with command `node dist/worker.js`, N replicas, no public port
set -euo pipefail
role="${1:?usage: deploy.sh migrate|api|worker}"
: "${IMAGE:?IMAGE is required}"
: "${DEPLOY_TARGET:?DEPLOY_TARGET is required}"

echo "Deploying role=$role image=$IMAGE target=$DEPLOY_TARGET"
echo "No deployment platform is configured. Implement scripts/deploy.sh for your host (see docs/DEPLOYMENT.md)." >&2
exit 1
