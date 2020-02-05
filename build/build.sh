#!/bin/bash
set -e
export DOCKER_IMAGE_AND_TAG=${1}

npm ci
make build-prod
make lint
make prune
make docker/build